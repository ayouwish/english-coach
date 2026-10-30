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
import logging
import re
import time
from pathlib import Path

import httpx

from .config import Settings, get_settings
from .errors import BadRequest, ContentUnsafe, ProviderError, ProviderUnavailable
from .llm import LLMClient
from .story import COMMON_WORDS  # 复用常用词做"是否为普通英文词"判断

logger = logging.getLogger("voice.image")

PROVIDER_ZHIPU = "zhipu"
PROVIDER_MOCK = "mock"
PROVIDER_NONE = "none"
SUPPORTED_PROVIDERS = (PROVIDER_ZHIPU, PROVIDER_MOCK, PROVIDER_NONE)

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
    style: str = "watercolor",
) -> tuple[str, list[str]]:
    """-> (最终提示词, warnings)。人名一律被替换；安全模板写死在服务端。"""
    scene, warnings, _client = _llm_scene_prompt(story_text, title_en, style)
    if not scene:
        scene = DEFAULT_SCENE
    scene = sanitize_names(scene)[:400] or DEFAULT_SCENE
    safe_style = re.sub(r"[^a-zA-Z -]", "", style or "watercolor").strip() or "watercolor"
    prompt = SAFETY_TEMPLATE.format(style=safe_style, scene=scene)
    if len(prompt) > MAX_PROMPT_CHARS:
        prompt = prompt[:MAX_PROMPT_CHARS].rstrip(" ,;")
    return prompt, warnings


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
def generate_illustration(
    story_text: str,
    *,
    title_en: str | None = None,
    style: str = "watercolor",
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
    prompt, warnings = build_prompt(story_text, title_en=title_en, style=style)
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
