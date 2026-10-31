"""故事 → 儿童绘本插画（智谱 GLM-Image，task-52）。

两步：① LLM 把故事变成英文绘画提示词（儿童绘本风、无人脸、无真名、无文字）
      ② 调智谱 `/images/generations` → **立即下载**临时 URL → 校验可解码 → base64 返回。

安全提示词模板**写死在服务端**（调用方不能覆盖）：儿童绘本风、可爱卡通、无真实人脸、图内无文字。
人名一律替换成 `a child` / `a friend`（图里画不出具体的人，也避免隐私/偏见问题）。
智谱返回的 URL 是临时的，必须立刻下载落成 bytes（本服务只缓存 PNG 字节）。

成本控制：`hash(model+size+prompt+watermark)` → `DATA_DIR/cache/images/<key>.png`，命中直接返回；
`?force=1` 强制重新生成。`IMAGE_PROVIDER=mock` 时本地画占位图（不联网、不花钱）。
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import re
import time
from pathlib import Path

import httpx

from .config import Settings, get_settings
from .errors import BadRequest, ContentUnsafe, ProviderError, ProviderUnavailable
from .llm import LLMClient, _loads_json
from .story import COMMON_WORDS  # 复用常用词做"是否为普通英文词"判断

logger = logging.getLogger("voice.image")

PROVIDER_ZHIPU = "zhipu"
PROVIDER_MOCK = "mock"
PROVIDER_NONE = "none"
SUPPORTED_PROVIDERS = (PROVIDER_ZHIPU, PROVIDER_MOCK, PROVIDER_NONE)

# 风格枚举（task-61）：五种儿童友好风格，每种有独立的 style tokens（头像/插画共用同一套词）
STYLE_PRESETS: dict[str, str] = {
    "watercolor": "soft watercolor",
    "cartoon": "friendly flat cartoon style",
    "pixel": "cute pixel art style, chunky pixels",
    "papercut": "layered paper-cut collage style, soft shadows",
    "clay": "soft 3D clay / plasticine style, rounded shapes, matte finish",
}
ALLOWED_STYLES: tuple[str, ...] = tuple(STYLE_PRESETS)
DEFAULT_STYLE = "watercolor"
AVATAR_SAFETY = "no text in image, safe for young children"
AVATAR_SCENE = "friendly expression, upper body, plain soft background"
AVATAR_TEMPLATE = (
    "children's picture book character portrait, {style}, {character}, "
    "{scene}, {safety}"
)
MAX_CHARACTER_DESC = 300
# prompt 注入词（不区分大小写）：命中直接拒绝
_INJECTION_MARKERS: tuple[str, ...] = (
    "ignore previous instructions", "ignore all previous", "ignore the previous",
    "disregard previous", "disregard all previous", "forget your instructions",
    "system prompt", "you are now", "new instructions", "reveal your",
    "api key", "password", "jailbreak", "developer mode", "act as",
    "<script", "```", "http://", "https://",
)
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

SAFETY_TEMPLATE = (
    "children's picture book illustration, soft {style}, warm colors, {scene}; "
    "cute cartoon characters, no realistic human faces, no text in image, safe for young children"
)
MAX_PROMPT_CHARS = 1000
MAX_PIXELS = 2 ** 22  # 总像素上限（约 4.19M）
MIN_DIM = 1024
MAX_DIM = 2048
GLM_RECOMMENDED_SIZES = {"1280x1280", "1568x1056", "1056x1568"}
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
MAX_RETRIES = 3
MAX_STORY_CHARS = 2000

DEFAULT_SCENE = "a child and a friend playing together happily in a warm, cheerful place"


# --------------------------------------------------------------------------------------
# 风格 / 角色卡（task-61）
# --------------------------------------------------------------------------------------
# task-63：写实/照片风格一律硬拒绝（防止绕过 UI 直接调接口）
BLOCKED_STYLE_MARKERS = ("realistic", "photoreal", "photo", "photograph", "写实", "真实照片", "real life")


def assert_style_allowed(style: str | None) -> None:
    value = (style or "").strip().lower()
    if any(marker in value for marker in BLOCKED_STYLE_MARKERS):
        raise BadRequest("不支持写实/照片风格：本项目只做儿童绘本插画风（禁止写实人脸）")


def validate_style(style: str | None) -> str:
    """头像/角色卡用：必须是五种预设之一，否则 400；写实/照片风格硬拒绝。"""
    assert_style_allowed(style)
    value = (style or DEFAULT_STYLE).strip().lower()
    if value not in STYLE_PRESETS:
        raise BadRequest(f"style must be one of {list(ALLOWED_STYLES)}, got {style!r}")
    return value


def style_phrase(style: str | None) -> str:
    """风格词：预设直接映射；插画接口的历史自由文本保持 "soft {style}" 的行为。"""
    assert_style_allowed(style)
    value = (style or DEFAULT_STYLE).strip().lower()
    if value in STYLE_PRESETS:
        return STYLE_PRESETS[value]
    sanitized = re.sub(r"[^a-zA-Z -]", "", style or DEFAULT_STYLE).strip() or DEFAULT_STYLE
    return f"soft {sanitized}"


def clean_character_desc(text: str | None, *, source: str = "character_desc") -> str:
    """清洗角色卡：去换行/控制字符、压缩空白、拒绝 prompt 注入词、截断 300 字符。

    - 调用方传入的 character_desc 命中注入词 → 400（不允许把指令塞进提示词）
    - 空输入 → 空字符串（illustrate 会当作"没有角色卡"，向后兼容）
    """
    if text is None:
        return ""
    cleaned = _CONTROL_CHARS_RE.sub(" ", str(text))
    cleaned = " ".join(cleaned.replace("\n", " ").replace("\r", " ").replace("\t", " ").split())
    if not cleaned:
        return ""
    lowered = cleaned.lower()
    for marker in _INJECTION_MARKERS:
        if marker in lowered:
            raise BadRequest(f"{source} 包含不允许的指令词（疑似 prompt 注入）：{marker!r}")
    if len(cleaned) > MAX_CHARACTER_DESC:
        cleaned = cleaned[:MAX_CHARACTER_DESC].rstrip(" ,;")
    return cleaned


def compose_illustration_prompt(
    scene: str, style: str | None = DEFAULT_STYLE, character_desc: str = ""
) -> tuple[str, dict]:
    """拼最终提示词 + 四段 prompt_parts（style/character/scene/safety）。

    角色段固定在 style 之后、scene 之前（"插入固定位置"）；没有角色卡时与历史提示词**逐字节一致**。
    """
    phrase = style_phrase(style)
    character = f"featuring {character_desc}, " if character_desc else ""
    safety = "cute cartoon characters, no realistic human faces, no text in image, safe for young children"
    prompt = f"children's picture book illustration, {phrase}, warm colors, {character}{scene}; {safety}"
    if len(prompt) > MAX_PROMPT_CHARS:
        prompt = prompt[:MAX_PROMPT_CHARS].rstrip(" ,;")
    return prompt, {"style": phrase, "character": character_desc, "scene": scene, "safety": safety}


def compose_avatar_prompt(character_desc: str, style: str | None = DEFAULT_STYLE) -> tuple[str, dict]:
    phrase = style_phrase(style)
    prompt = AVATAR_TEMPLATE.format(style=phrase, character=character_desc, scene=AVATAR_SCENE, safety=AVATAR_SAFETY)
    if len(prompt) > MAX_PROMPT_CHARS:
        prompt = prompt[:MAX_PROMPT_CHARS].rstrip(" ,;")
    return prompt, {"style": phrase, "character": character_desc, "scene": AVATAR_SCENE, "safety": AVATAR_SAFETY}

_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")
_CAPITAL_WORD_RE = re.compile(r"\b[A-Z][A-Za-z]{1,30}\b")


# --------------------------------------------------------------------------------------
# 可用性 / 配置
# --------------------------------------------------------------------------------------
def normalize_provider(value: str | None) -> str:
    provider = (value or PROVIDER_NONE).strip().lower()
    return provider if provider in SUPPORTED_PROVIDERS else PROVIDER_NONE


def active_provider(settings: Settings | None = None) -> str | None:
    """实际可用的图片 provider（"zhipu" / "mock" / None）。"""
    settings = settings or get_settings()
    provider = normalize_provider(settings.image_provider)
    if provider == PROVIDER_MOCK:
        return PROVIDER_MOCK
    if provider == PROVIDER_ZHIPU and settings.image_api_key:
        return PROVIDER_ZHIPU
    return None


def image_available(settings: Settings | None = None) -> bool:
    return active_provider(settings) is not None


def avatar_available(settings: Settings | None = None) -> bool:
    """虚拟形象需要文生图 + 视觉 LLM 都可用。"""
    if not image_available(settings):
        return False
    try:
        return LLMClient(settings or get_settings()).vision_available
    except Exception:
        return False


def parse_size(size: str | None) -> tuple[int, int]:
    """解析并校验 IMAGE_SIZE。非法 → 400（宽高需 1024–2048 且 32 的倍数）。"""
    raw = (size or "").strip().lower()
    match = re.fullmatch(r"(\d{3,4})x(\d{3,4})", raw)
    if not match:
        raise BadRequest(f"invalid IMAGE_SIZE: {size!r}（格式应为 宽x高，如 1280x1280）")
    width, height = int(match.group(1)), int(match.group(2))
    if raw in GLM_RECOMMENDED_SIZES:
        return width, height
    if not (MIN_DIM <= width <= MAX_DIM and MIN_DIM <= height <= MAX_DIM):
        raise BadRequest(f"invalid IMAGE_SIZE: {size!r}（宽高需在 {MIN_DIM}–{MAX_DIM}）")
    if width % 32 or height % 32:
        raise BadRequest(f"invalid IMAGE_SIZE: {size!r}（宽高需是 32 的倍数）")
    return width, height


# --------------------------------------------------------------------------------------
# 提示词：LLM 生成 + 儿童安全模板 + 人名替换
# --------------------------------------------------------------------------------------
def _replace_cjk(text: str) -> str:
    return _CJK_RE.sub("a child", text)


def sanitize_names(scene: str) -> str:
    """把绘画提示词里的真实人名替换成 `a child` / `a friend`。"""
    replacements = ["a child", "a friend"]
    counter = {"n": 0}

    def repl(match):
        word = match.group(0)
        if word.lower() in COMMON_WORDS:  # Today / My / The 这类普通词
            return word
        value = replacements[counter["n"] % len(replacements)]
        counter["n"] += 1
        return value

    cleaned = _CAPITAL_WORD_RE.sub(repl, _replace_cjk(scene))
    return " ".join(cleaned.split())


def _llm_scene_prompt(story_text: str, title_en: str | None, style: str) -> tuple[str | None, list[str], LLMClient]:
    settings = get_settings()
    client = LLMClient(settings)
    if not client.available:
        return None, ["prompt_template"], client
    system = (
        "You write English image-generation prompts for a children's picture book. "
        "Given a short English story, describe ONE warm illustration scene in English (<=60 words). "
        "NEVER include a person's name — use 'a child' or 'a friend' instead. "
        "Do not request any text or letters inside the image. "
        'Output ONLY JSON: {"scene": "..."}'
    )
    user = f"Story:\n{story_text}"
    if title_en:
        user += f"\nTitle: {title_en}"
    user += f"\nStyle: {style}\nDescribe the scene. JSON only."
    outcome = client.chat_json(
        system, user, timeout_s=60.0, max_tokens=800, temperature=0.5, disable_thinking=True
    )
    if outcome.truncated:
        outcome = client.chat_json(
            system, user, timeout_s=60.0, max_tokens=1600, temperature=0.5, disable_thinking=True
        )
    if outcome.ok and isinstance(outcome.data, dict):
        scene = str(outcome.data.get("scene") or "").strip()
        if scene:
            return scene, [], client
    logger.warning("illustration prompt LLM failed (%s), using template scene", outcome.error)
    return None, ["prompt_template"], client


def build_prompt(
    story_text: str,
    title_en: str | None = None,
    style: str = DEFAULT_STYLE,
    character_desc: str = "",
) -> tuple[str, list[str], dict]:
    """-> (最终提示词, warnings, prompt_parts)。

    角色卡（character_desc）由调用方先清洗；这里只负责放到固定位置（style 之后、scene 之前）。
    """
    scene, warnings, _client = _llm_scene_prompt(story_text, title_en, style)
    if not scene:
        scene = DEFAULT_SCENE
    scene = sanitize_names(scene)[:400] or DEFAULT_SCENE
    prompt, parts = compose_illustration_prompt(scene, style, character_desc)
    return prompt, warnings, parts


# --------------------------------------------------------------------------------------
# 缓存
# --------------------------------------------------------------------------------------
def image_cache_dir(settings: Settings | None = None) -> Path:
    settings = settings or get_settings()
    return settings.data_dir / "cache" / "images"


def image_cache_key(model: str, size: str, prompt: str, watermark: bool) -> str:
    payload = "\x1f".join([model or "", size or "", prompt or "", "1" if watermark else "0"])
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------------------
# 图片校验 / mock 生成
# --------------------------------------------------------------------------------------
def _looks_like_image(data: bytes) -> bool:
    return (
        data.startswith(b"\x89PNG\r\n\x1a\n")
        or data.startswith(b"\xff\xd8\xff")
        or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")
    )


def validate_and_normalize_image(data: bytes, expected: tuple[int, int]) -> tuple[bytes, int, int]:
    """校验 magic bytes + PIL 解码 + 尺寸/像素上限；统一转成 PNG。"""
    from PIL import Image

    if not data or not _looks_like_image(data):
        raise ProviderError("插画下载失败：返回的不是图片", provider="image")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        image = image.convert("RGB")
    except Exception as exc:
        raise ProviderError(f"插画无法解码：{type(exc).__name__}", provider="image") from exc
    width, height = image.size
    if width * height > MAX_PIXELS:
        raise ProviderError(f"插画像素过大：{width}x{height} > {MAX_PIXELS} pixels", provider="image")
    if expected and (width, height) != expected:
        raise ProviderError(
            f"插画尺寸不符：期望 {expected[0]}x{expected[1]}，实际 {width}x{height}", provider="image"
        )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), width, height


def _mock_image_bytes(size: tuple[int, int]) -> bytes:
    """本地占位图：暖色卡片 + 简单几何图形（不联网、不花钱、图内无文字）。"""
    from PIL import Image, ImageDraw

    width, height = size
    digest = hashlib.sha1(f"{width}x{height}".encode()).digest()
    base = (247, 241, 230)
    accent = (digest[0] % 40 + 120, digest[1] % 40 + 130, digest[2] % 40 + 150)
    image = Image.new("RGB", (width, height), base)
    draw = ImageDraw.Draw(image)
    band = max(1, height // 60)
    for index in range(0, height, band):
        ratio = index / max(1, height)
        color = (
            int(240 - 20 * ratio),
            int(236 - 30 * ratio),
            int(226 - 40 * ratio),
        )
        draw.rectangle([0, index, width, index + band], fill=color)
    # 太阳 + 小山 + 两个简单卡通角色（无脸）
    draw.ellipse(
        [int(width * 0.70), int(height * 0.10), int(width * 0.88), int(height * 0.28)],
        fill=(255, 214, 128),
    )
    draw.ellipse(
        [-int(width * 0.2), int(height * 0.70), int(width * 0.5), int(height * 1.1)], fill=accent
    )
    draw.ellipse(
        [int(width * 0.45), int(height * 0.75), int(width * 1.1), int(height * 1.2)],
        fill=tuple(min(255, value + 15) for value in accent),
    )
    for offset in (0.28, 0.52):
        body_w = int(width * 0.10)
        body_h = int(height * 0.16)
        left = int(width * offset)
        top = int(height * 0.62)
        draw.ellipse([left, top, left + body_w, top + body_h], fill=(120, 110, 150))
        draw.ellipse(
            [left + body_w // 3, top - body_h // 3, left + 2 * body_w // 3, top],
            fill=(160, 140, 170),
        )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


# --------------------------------------------------------------------------------------
# 智谱 API
# --------------------------------------------------------------------------------------
def _zhipu_request_url(settings: Settings) -> str:
    return settings.image_base_url.rstrip("/") + "/images/generations"


def _zhipu_generate(prompt: str, size: str, settings: Settings) -> tuple[str, list[str]]:
    """调智谱生成图片，返回临时 URL。429/5xx 重试 3 次（1s/2s/2s 退避）。"""
    url = _zhipu_request_url(settings)
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.image_api_key}",
    }
    payload = {
        "model": settings.image_model,
        "prompt": prompt,
        "size": size,
        "quality": "hd" if str(settings.image_model).startswith("glm-image") else settings.image_quality,
        "watermark_enabled": bool(settings.image_watermark),
    }
    warnings: list[str] = []
    last_error = ""
    for attempt in range(MAX_RETRIES + 1):
        if attempt:
            delay = 1.0 if attempt == 1 else 2.0
            time.sleep(delay)
        try:
            response = httpx.post(url, headers=headers, json=payload, timeout=settings.image_timeout_s)
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            logger.warning("zhipu image api network error (attempt %d): %s", attempt + 1, last_error)
            continue
        status = getattr(response, "status_code", 200)
        if status == 200:
            body = response.json() if callable(getattr(response, "json", None)) else {}
            if body.get("content_filter"):
                raise ContentUnsafe("这段内容没法生成插画，换个说法试试", provider="zhipu")
            data = body.get("data") or []
            if not data or not data[0].get("url"):
                raise ProviderError(f"zhipu 返回里没有图片 URL：{str(body)[:200]}", provider="zhipu")
            return str(data[0]["url"]), warnings
        body_text = getattr(response, "text", "") or ""
        last_error = f"HTTP {status}: {body_text[:200]}"
        if status in RETRYABLE_STATUS:
            logger.warning("zhipu image api retryable error (%s), attempt %d", last_error, attempt + 1)
            continue
        raise ProviderError(f"zhipu image api failed: {last_error}", provider="zhipu")
    raise ProviderError(f"zhipu image api failed after {MAX_RETRIES} retries: {last_error}", provider="zhipu")


def _download_image(url: str, settings: Settings) -> bytes:
    try:
        response = httpx.get(url, timeout=min(60.0, settings.image_timeout_s), follow_redirects=True)
    except Exception as exc:
        raise ProviderError(f"插画下载失败：{type(exc).__name__}", provider="zhipu") from exc
    if getattr(response, "status_code", 200) != 200:
        raise ProviderError(f"插画下载失败：HTTP {response.status_code}", provider="zhipu")
    data = response.content
    if not _looks_like_image(data):
        raise ProviderError("插画下载失败：返回的不是图片（可能被网关拦截）", provider="zhipu")
    return data


# --------------------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------------------
# --------------------------------------------------------------------------------------
# 虚拟形象（task-61）：照片 → 视觉 LLM 角色卡 → 文生图风格化头像
# --------------------------------------------------------------------------------------
MAX_AVATAR_PHOTO_SIDE = 1280

_AVATAR_ANALYSIS_SYSTEM = (
    "You analyze a photo ONLY to design a stylized picture-book character card. "
    "Describe drawable visual traits in English: hair colour/length/style, face shape, glasses, "
    "clothing colours and items, distinctive accessories. "
    "STRICT child-safety rules: never guess or mention race, ethnicity, religion, nationality, "
    "health, or any sensitive trait; do not estimate a precise age (say 'a child'); "
    "never include any real name or location; do not describe other people; keep it wholesome "
    "and simple (<= 60 words).\n"
    'Output ONLY this flat JSON (character_desc MUST be ONE English sentence): '
    '{"character_desc": "a child with ...", "safety_notes": []}'
)
_AVATAR_ANALYSIS_PROMPT = (
    "Describe this child's appearance as a picture-book character card (drawable traits only). JSON only."
)


def _load_photo(data: bytes) -> tuple[object, int, int]:
    """校验并预处理上传照片：EXIF 转正 → RGB → 长边 ≤1280；非法 → 400。"""
    from PIL import Image, ImageOps

    if not data:
        raise BadRequest("empty photo")
    try:
        probe = Image.open(io.BytesIO(data))
        if probe.width * probe.height > MAX_PIXELS:
            raise BadRequest(f"photo too large: {probe.width}x{probe.height} > {MAX_PIXELS} pixels")
        image = ImageOps.exif_transpose(probe).convert("RGB")
    except BadRequest:
        raise
    except Exception as exc:
        raise BadRequest(f"cannot decode photo: {type(exc).__name__}") from exc
    width, height = image.size
    if min(width, height) < 8:
        raise BadRequest(f"photo too small: {width}x{height}")
    longest = max(width, height)
    if longest > MAX_AVATAR_PHOTO_SIDE:
        scale = MAX_AVATAR_PHOTO_SIDE / float(longest)
        image = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.LANCZOS)
    return image, image.size[0], image.size[1]


def _jpeg_data_url(image, quality: int = 85) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


_SENSITIVE_KEY_PARTS = (
    "race", "ethnic", "relig", "nation", "age", "name", "location", "school",
    "gender", "address", "health", "disab", "identity",
)
_VISUAL_KEY_HINTS = (
    "desc", "hair", "eye", "face", "skin", "cloth", "wear", "glass", "freckle",
    "accessor", "mouth", "shape", "color", "colour", "body", "head", "shoe", "hat",
    "expression",
)
_COLOR_WORDS = {
    "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "black",
    "white", "gray", "grey", "peach", "dark", "light", "blonde", "golden", "tan",
}


def _looks_like_color(text: str) -> bool:
    words = {word.strip(".,").lower() for word in text.split()}
    return bool(words & _COLOR_WORDS)


_TRAIT_NOUNS = {
    "head": "head shape", "face": "face shape", "hair": "hair", "eyes": "eyes", "eye": "eyes",
    "mouth": "mouth", "skin": "skin", "clothing": "clothing", "cloth": "clothing",
    "body": "body", "glasses": "glasses", "hat": "hat", "shoe": "shoes", "shoes": "shoes",
    "expression": "expression", "shape": "face shape", "accessories": "accessories",
}
_TRAIT_ORDER = ("hair", "eyes", "skin", "face shape", "head shape", "glasses", "mouth",
                "clothing", "body", "hat", "shoes", "accessories", "expression")


def _trait_noun(key: str) -> str:
    lowered = key.lower()
    return _TRAIT_NOUNS.get(lowered, lowered if lowered in _TRAIT_NOUNS.values() else "")


def _flatten_character_payload(payload) -> str:
    """把视觉模型返回的嵌套 JSON（head/hair/eyes…）拍平成一句英文外观描述。

    跳过敏感字段（race/ethnicity/religion/age/name/location…），只保留可画的外观特征；
    同一性状（如 hair 的 style+color）合并成一个短语。
    """
    traits: dict[str, list[str]] = {}

    def add(noun: str, value: str) -> None:
        if not noun:
            return
        entry = traits.setdefault(noun, [])
        if value.lower() not in {item.lower() for item in entry}:
            entry.append(value)

    def walk(node, path: list[str]) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                lowered = str(key).lower()
                if any(bad in lowered for bad in _SENSITIVE_KEY_PARTS):
                    continue
                walk(value, path + [str(key)])
        elif isinstance(node, list):
            for item in node:
                walk(item, path)
        elif isinstance(node, str):
            text = node.strip().rstrip(".,;")
            if not text or len(text) > 80:
                return
            leaf = path[-1].lower() if path else ""
            parent = path[-2].lower() if len(path) > 1 else ""
            if "skin" in leaf:
                add("skin", text)
            elif leaf in ("color", "colour", "style", "shape", "type", "item", "pattern"):
                noun = _trait_noun(parent) or _trait_noun(leaf)
                add(noun, text)
            elif leaf in ("glasses", "hat", "shoes", "accessories", "expression"):
                add(_trait_noun(leaf) or leaf, text)
            elif leaf in _TRAIT_NOUNS:
                add(_trait_noun(leaf), text)
            elif _looks_like_color(text):
                add(_trait_noun(parent) or "details", text)

    walk(payload, [])
    phrases = []
    for noun in _TRAIT_ORDER:
        values = traits.get(noun)
        if values:
            phrases.append(f"{' '.join(values)} {noun}")
    for noun, values in traits.items():
        if noun not in _TRAIT_ORDER:
            phrases.append(f"{' '.join(values)} {noun}")
    return ", ".join(phrases)


def analyze_photo_character(photo: bytes, settings: Settings | None = None) -> str:
    """视觉 LLM 分析照片 → 英文角色卡（儿童安全，已清洗）。失败 → 502/503。"""
    settings = settings or get_settings()
    client = LLMClient(settings)
    if not client.vision_available:
        raise ProviderUnavailable(
            "虚拟形象需要视觉 LLM：请配置 .env 的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（并重建镜像）",
            provider="image",
            code="provider_unavailable",
        )
    image, _width, _height = _load_photo(photo)
    data_url = _jpeg_data_url(image)
    last_error = ""
    for attempt in range(2):
        outcome = client.read_image(
            data_url, _AVATAR_ANALYSIS_PROMPT, timeout_s=60.0, max_tokens=600, disable_thinking=True
        )
        if outcome.truncated:
            outcome = client.read_image(
                data_url, _AVATAR_ANALYSIS_PROMPT, timeout_s=60.0, max_tokens=1200, disable_thinking=True
            )
        if outcome.ok:
            raw_text = (outcome.text or "").strip()
            payload = _loads_json(raw_text)
            description = ""
            if isinstance(payload, dict):
                top = payload.get("character_desc")
                if isinstance(top, str) and top.strip():
                    description = top.strip()
                else:
                    flattened = _flatten_character_payload(payload)
                    if flattened:
                        description = "a child with " + flattened
            elif raw_text:
                # 模型没给 JSON（直接写了一段英文描述）→ 把纯文本当角色卡
                plain = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", raw_text).strip()
                if plain and len(plain.split()) <= 80:
                    description = plain
            if description:
                try:
                    cleaned = clean_character_desc(description, source="character_desc（由视觉模型生成）")
                except BadRequest as exc:
                    raise ProviderError(f"视觉模型返回的角色卡不合规：{exc.message}", provider="image") from exc
                if cleaned:
                    return cleaned
        last_error = outcome.error or "invalid_character_card"
        logger.warning("avatar character analysis failed (attempt %d): %s", attempt + 1, last_error)
    raise ProviderError(f"视觉模型没能生成可用的角色卡（{last_error}），请重试", provider="image")


def _write_cache(cache_path: Path, data: bytes, meta: dict | None = None) -> None:
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = cache_path.with_name(cache_path.name + f".{time.time_ns()}.tmp")
        temp_path.write_bytes(data)
        temp_path.replace(cache_path)
        if meta is not None:
            meta_path = cache_path.with_suffix(".json")
            temp_meta = meta_path.with_name(meta_path.name + f".{time.time_ns()}.tmp")
            temp_meta.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            temp_meta.replace(meta_path)
    except Exception as exc:  # 缓存写失败不影响返回图片
        logger.warning("image cache write failed: %s", exc)


def generate_avatar(
    photo: bytes,
    *,
    style: str = DEFAULT_STYLE,
    force: bool = False,
    settings: Settings | None = None,
) -> dict:
    """照片 → 风格化虚拟形象。返回契约 JSON（含 character_desc / prompt_used / prompt_parts）。"""
    settings = settings or get_settings()
    style = validate_style(style)
    provider = active_provider(settings)
    if provider is None:
        raise ProviderUnavailable(
            "文生图未启用：请在 .env 配置 IMAGE_PROVIDER=zhipu 且填写 IMAGE_API_KEY（并重建镜像）；"
            "本地/测试可用 IMAGE_PROVIDER=mock",
            provider="image",
            code="provider_unavailable",
        )
    expected_size = parse_size(settings.image_size)
    size = f"{expected_size[0]}x{expected_size[1]}"
    _load_photo(photo)  # 先做格式/尺寸校验（非法 → 400）

    photo_hash = hashlib.sha1(photo).hexdigest()
    cache_key = hashlib.sha1(
        f"avatar|{style}|{settings.image_model}|{size}|{int(bool(settings.image_watermark))}|{photo_hash}".encode()
    ).hexdigest()
    cache_dir = image_cache_dir(settings)
    cache_path = cache_dir / f"avatar_{cache_key}.png"
    started = time.perf_counter()

    def _result(image_bytes: bytes, width: int, height: int, cached: bool, character: str, prompt: str, parts: dict) -> dict:
        return {
            "image_b64": base64.b64encode(image_bytes).decode("ascii"),
            "mime": "image/png",
            "character_desc": character,
            "style": style,
            "provider": provider,
            "model": settings.image_model,
            "size": size,
            "width": width,
            "height": height,
            "prompt_used": prompt,
            "prompt_parts": parts,
            "elapsed_ms": int(round((time.perf_counter() - started) * 1000)),
            "cached": cached,
            "warnings": [],
        }

    meta_path = cache_path.with_suffix(".json")
    if not force and cache_path.is_file() and meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            normalized, width, height = validate_and_normalize_image(cache_path.read_bytes(), expected_size)
            return _result(
                normalized, width, height, True,
                meta.get("character_desc") or "", meta.get("prompt_used") or "",
                meta.get("prompt_parts") or {},
            )
        except Exception as exc:
            logger.warning("avatar cache unreadable, regenerating: %s", exc)

    character_desc = analyze_photo_character(photo, settings)  # 视觉 LLM（缓存未命中才调用）
    prompt, parts = compose_avatar_prompt(character_desc, style)
    if provider == PROVIDER_MOCK:
        raw = _mock_image_bytes(expected_size)
    else:
        url, _extra = _zhipu_generate(prompt, size, settings)
        raw = _download_image(url, settings)
    normalized, width, height = validate_and_normalize_image(raw, expected_size)
    _write_cache(
        cache_path, normalized,
        {
            "character_desc": character_desc,
            "prompt_used": prompt,
            "prompt_parts": parts,
            "style": style,
            "model": settings.image_model,
            "size": size,
        },
    )
    return _result(normalized, width, height, False, character_desc, prompt, parts)


def generate_illustration(
    story_text: str,
    *,
    title_en: str | None = None,
    style: str = DEFAULT_STYLE,
    character_desc: str | None = None,
    character_style: str | None = None,
    force: bool = False,
    settings: Settings | None = None,
) -> dict:
    settings = settings or get_settings()
    story_text = (story_text or "").strip()
    if not story_text:
        raise BadRequest("story_text is required")
    if len(story_text) > MAX_STORY_CHARS:
        raise BadRequest(f"story_text too long: {len(story_text)} > {MAX_STORY_CHARS} chars")
    if title_en and len(title_en) > 200:
        raise BadRequest("title_en too long")
    provider = active_provider(settings)
    if provider is None:
        raise ProviderUnavailable(
            "文生图未启用：请在 .env 配置 IMAGE_PROVIDER=zhipu 且填写 IMAGE_API_KEY（并重建镜像）；"
            "本地/测试可用 IMAGE_PROVIDER=mock",
            provider="image",
            code="provider_unavailable",
        )
    expected_size = parse_size(settings.image_size)
    size = f"{expected_size[0]}x{expected_size[1]}"
    # task-61：可选角色卡（清洗；注入词 → 400）。角色风格保持与头像同一套 style tokens。
    clean_desc = clean_character_desc(character_desc, source="character_desc")
    render_style = style
    if character_desc is not None and str(character_desc).strip() == "":
        clean_desc = ""
    if character_style:
        render_style = validate_style(character_style)
    prompt, warnings, prompt_parts = build_prompt(
        story_text, title_en=title_en, style=render_style, character_desc=clean_desc
    )
    cache_key = image_cache_key(settings.image_model, size, prompt, settings.image_watermark)
    cache_dir = image_cache_dir(settings)
    cache_path = cache_dir / f"{cache_key}.png"
    started = time.perf_counter()

    def _result(image_bytes: bytes, width: int, height: int, cached: bool) -> dict:
        return {
            "image_b64": base64.b64encode(image_bytes).decode("ascii"),
            "mime": "image/png",
            "prompt_used": prompt,
            "provider": provider,
            "model": settings.image_model,
            "size": size,
            "width": width,
            "height": height,
            "prompt_parts": prompt_parts,
            "character_used": bool(clean_desc),
            "elapsed_ms": int(round((time.perf_counter() - started) * 1000)),
            "cached": cached,
            "warnings": warnings,
        }

    if not force and cache_path.is_file():
        try:
            cached_bytes = cache_path.read_bytes()
            normalized, width, height = validate_and_normalize_image(cached_bytes, expected_size)
            return _result(normalized, width, height, True)
        except Exception as exc:
            logger.warning("image cache unreadable, regenerating: %s", exc)

    if provider == PROVIDER_MOCK:
        raw = _mock_image_bytes(expected_size)
    else:
        url, _extra = _zhipu_generate(prompt, size, settings)
        raw = _download_image(url, settings)
    normalized, width, height = validate_and_normalize_image(raw, expected_size)
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        temp_path = cache_path.with_name(cache_path.name + f".{time.time_ns()}.tmp")
        temp_path.write_bytes(normalized)
        temp_path.replace(cache_path)
    except Exception as exc:  # 缓存写失败不影响返回图片
        logger.warning("image cache write failed: %s", exc)
    return _result(normalized, width, height, False)
