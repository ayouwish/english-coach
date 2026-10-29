"""拍照 OCR：**DeepSeek 多模态（LLM 视觉）为主**，本地 `rapidocr` 仅作可选离线兜底（task-27）。

为什么改成 LLM 视觉：用户明确要求用大模型；实测 `deepseek-flash` 对真实书页版式
（旋转/阴影/多栏）比本地 PP-OCR 更稳（820×300/3 行 1.19s、1200×1600/8 行 2.94s，逐行全对）。

Provider 链（`VOICE_OCR_PROVIDER=auto|llm|local`，默认 auto）：
- `auto`：LLM 已配置 → `llm`；否则本地依赖可用 → `local`；都不可用 → 503
- `llm` ：LLM 为主，失败/超时降级本地（若已装）
- `local`：只用本地 rapidocr（完全离线）

隐私：图片**只在内存里**识别，不落盘、不留缓存。
本地依赖（rapidocr/onnxruntime/opencv/pillow）已从生产 requirements.txt 拆出，
要离线兜底请装 `requirements-ocr-local.txt`（或 `uv sync --extra ocr-local`）。
"""

from __future__ import annotations

import base64
import io
import logging
import re
import threading
import time
from dataclasses import dataclass, field

from .config import Settings, get_settings
from .errors import BadRequest, PayloadTooLarge, VoiceError
from .llm import LLMClient

logger = logging.getLogger("voice.ocr")

MAX_LONG_SIDE_LLM = 1280  # 发给视觉模型前缩到 ≤1280（token 成本随像素涨；1600→1280 省约 40%）
MAX_LONG_SIDE_LOCAL = 1280  # 本地 PP-OCR 同样用 1280：两条路径共用同一张预处理图（task-28 返回图 ≤1280）
MAX_PIXELS = 40_000_000  # 解码前像素上限（防解压炸弹）
MIN_SIDE = 8
LLM_JPEG_QUALITY = 85

PROVIDER_LLM = "llm"
PROVIDER_LOCAL = "local"
LOCAL_PROVIDER_NAME = "rapidocr"
WARNING_LLM_FAILED = "llm_vision_failed"
WARNING_NO_TEXT = "no_text_found"
WARNING_DOWNSCALED = "image_downscaled"
WARNING_ENCODE_FAILED = "image_encode_failed"
WARNING_EMPTY_RETRIED = "llm_empty_retried"  # task-35：首次空、宽容提示词重试后仍空
WARNING_TRUNCATED = "llm_truncated"  # task-36：重试后仍被 max_tokens 截断

OCR_PROMPT = (
    "请逐行输出图片中的英文原文：\n"
    "1. 每行对应图片里的一行文字，按从上到下的顺序排列；\n"
    "2. 不要编号、不要加解释、不要翻译、不要加引号；\n"
    "3. 保留原文的标点与大小写；\n"
    "4. 忽略中文注释、页码、书名、页眉页脚；\n"
    "5. 如果图片里没有英文，返回空字符串。\n"
    "只输出识别到的英文文本本身。"
)

# 首次返回空时用的**宽容版**提示词（task-35：模型可能过度遵守"没有英文就返回空"，
# 把绘本封面标题、标签、装饰字误判成"没有可读英文"）。
OCR_PROMPT_RETRY = (
    "这张图片是一本书页/绘本封面/练习页的照片，请尽可能读出其中所有可见的英文内容。\n"
    "请逐行输出，按从上到下的顺序：\n"
    "1. 包括标题、封面文字、标签、说明文字、装饰字、单词、短语、标点符号；\n"
    "2. 即使只有一两个英文单词，也请原样输出；\n"
    "3. 不要编号、不要加解释、不要翻译、不要加引号；\n"
    "4. 保留原文的标点与大小写；\n"
    "5. 忽略中文注释、页码、页眉页脚。\n"
    "只有在图片里**完全没有任何英文字母**时，才返回空字符串。\n"
    "只输出识别到的英文文本本身。"
)

TRUNCATION_MAX_TOKENS_CAP = 4000  # 截断重试的上限（×3 但不超过它，避免被慢/贵）
TRUNCATION_RETRY_FACTOR = 3

# iPhone 相册照片默认 HEIC/HEIF（ISO BMFF 容器，major brand 在 ftyp 里）
_HEIF_BRANDS = {
    b"heic", b"heix", b"heis", b"hevc", b"hevx", b"heim", b"hevm", b"mif1", b"msf1",
}
HEIC_UNSUPPORTED_MESSAGE = (
    "这张图是 iPhone 的 HEIC/HEIF 格式，当前服务端未启用 HEIC 支持。"
    "请改用「拍照」按钮（会存成 JPEG），或在相册里用「存储为 JPEG / 导出为 JPEG」后再从相册选择。"
)

_ENGINE_LOCK = threading.Lock()
_ENGINE: dict[str, object] = {}


class OcrUnavailable(VoiceError):
    """OCR 不可用（LLM 没配 且 本地依赖没装）→ 503 provider_unavailable。"""

    code = "provider_unavailable"


class _LlmVisionFailed(Exception):
    """LLM 视觉调用失败（内部用于触发降级）。"""


@dataclass
class OcrResult:
    text: str
    lines: list[dict] = field(default_factory=list)
    width: int = 0
    height: int = 0
    elapsed_ms: int = 0
    warnings: list[str] = field(default_factory=list)
    provider: str = LOCAL_PROVIDER_NAME
    image_jpeg_b64: str | None = None  # task-28：仅 return_image 请求时出现（缺失=未请求，不是 null）

    def to_contract(self) -> dict:
        payload = {
            "provider": self.provider,
            "text": self.text,
            "lines": self.lines,
            "width": self.width,
            "height": self.height,
            "elapsed_ms": self.elapsed_ms,
            "warnings": self.warnings,
        }
        if self.image_jpeg_b64 is not None:
            payload["image_jpeg_b64"] = self.image_jpeg_b64
        return payload


# --------------------------------------------------------------------------------------
# 可用性 / provider 链
# --------------------------------------------------------------------------------------
def llm_vision_available() -> bool:
    """LLM 视觉是否可用：只看配置（不联网）。"""
    try:
        return LLMClient().vision_available
    except Exception:  # pragma: no cover - 配置异常按不可用处理
        return False


def heif_available() -> bool:
    """HEIC/HEIF 解码是否可用（只查依赖是否存在，**不 import**，保证启动惰性）。"""
    import importlib.util

    try:
        return importlib.util.find_spec("pillow_heif") is not None
    except Exception:  # pragma: no cover - 环境异常按不可用处理
        return False


def looks_like_heif(data: bytes) -> bool:
    """按 ISO BMFF 头判断是否 HEIC/HEIF：`....ftyp` + major brand。"""
    if len(data) < 12 or data[4:8] != b"ftyp":
        return False
    return data[8:12].lower() in _HEIF_BRANDS


_HEIF_LOCK = threading.Lock()
_HEIF_REGISTERED = False


def _register_heif_opener() -> None:
    """首次遇到 HEIF 时才 import pillow_heif 并注册 PIL opener（线程安全、只做一次）。"""
    global _HEIF_REGISTERED
    with _HEIF_LOCK:
        if _HEIF_REGISTERED:
            return
        try:
            from pillow_heif import register_heif_opener  # 惰性导入：启动时不加载 libheif
        except Exception as exc:
            raise BadRequest(HEIC_UNSUPPORTED_MESSAGE) from exc
        try:
            register_heif_opener()
        except Exception as exc:
            raise BadRequest(f"HEIC/HEIF 解码器初始化失败：{type(exc).__name__}") from exc
        _HEIF_REGISTERED = True
        logger.info("pillow_heif opener registered (lazy, first HEIF input)")


def reset_heif_state() -> None:
    """测试用：重置懒加载状态（PIL 的 opener 注册是全局的，无法真正反注册）。"""
    global _HEIF_REGISTERED
    with _HEIF_LOCK:
        _HEIF_REGISTERED = False


def engine_available() -> bool:
    """本地 OCR 依赖是否可用：`find_spec` 探测，**不 import、不加载模型**。"""
    import importlib.util

    for name in ("rapidocr_onnxruntime", "PIL", "cv2"):
        try:
            if importlib.util.find_spec(name) is None:
                return False
        except Exception:  # pragma: no cover - 环境异常按不可用处理
            return False
    return True


def ocr_chain(settings: Settings | None = None) -> list[str]:
    """按 `VOICE_OCR_PROVIDER` 决定尝试顺序（只包含当前真正可用的 provider）。"""
    settings = settings or get_settings()
    mode = (settings.ocr_provider or "auto").lower()
    if mode not in ("auto", "llm", "local"):
        mode = "auto"
    llm_ok = llm_vision_available()
    local_ok = engine_available()
    if mode == "local":
        return [PROVIDER_LOCAL] if local_ok else []
    if mode == "llm":
        return [name for name, ok in ((PROVIDER_LLM, llm_ok), (PROVIDER_LOCAL, local_ok)) if ok]
    return [name for name, ok in ((PROVIDER_LLM, llm_ok), (PROVIDER_LOCAL, local_ok)) if ok]


def ocr_available(settings: Settings | None = None) -> bool:
    """health.capabilities.ocr：任一 provider 可用即为 True。"""
    return bool(ocr_chain(settings))


def active_ocr_provider(settings: Settings | None = None) -> str | None:
    """health.capabilities.ocr_provider：实际首选的 provider（"llm"/"local"/None）。"""
    chain = ocr_chain(settings)
    return chain[0] if chain else None


# --------------------------------------------------------------------------------------
# 本地 rapidocr（懒加载单例，可选兜底）
# --------------------------------------------------------------------------------------
def _get_engine():
    with _ENGINE_LOCK:
        engine = _ENGINE.get("engine")
        if engine is not None:
            return engine
        try:
            from rapidocr_onnxruntime import RapidOCR  # 惰性导入：启动时不加载重依赖
        except Exception as exc:
            raise OcrUnavailable(
                "本地 OCR 依赖未安装（rapidocr-onnxruntime / pillow / opencv）。"
                "离线兜底请在 voice/ 下执行：pip install -r requirements-ocr-local.txt；"
                "或者在 .env 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 使用视觉 OCR。",
                detail=str(exc),
            ) from exc
        try:
            engine = RapidOCR()
        except Exception as exc:
            raise OcrUnavailable("本地 OCR 模型加载失败（rapidocr 自带模型文件损坏？）", detail=str(exc)) from exc
        _ENGINE["engine"] = engine
        logger.info("rapidocr engine loaded (lazy)")
        return engine


def reset_engine() -> None:
    with _ENGINE_LOCK:
        _ENGINE.clear()


# --------------------------------------------------------------------------------------
# 图片预处理
# --------------------------------------------------------------------------------------
def preprocess_image(data: bytes, settings: Settings | None = None, max_long_side: int = MAX_LONG_SIDE_LOCAL):
    """bytes -> (PIL.Image RGB, out_w, out_h, warnings)。

    - `ImageOps.exif_transpose`：手机照片常带 Orientation（6=顺时针 90°），不转正整页识别会失败。
    - 转 RGB；长边 > max_long_side 等比缩小；像素总量上限保护。
    """
    settings = settings or get_settings()
    if not data:
        raise BadRequest("empty image payload")
    if len(data) > settings.max_ocr_bytes:
        raise PayloadTooLarge(f"image too large: {len(data)} bytes > {settings.max_ocr_bytes}")

    try:
        from PIL import Image, ImageOps  # 惰性导入
    except Exception as exc:
        raise OcrUnavailable(
            "Pillow 未安装，无法处理图片；离线兜底请装 requirements-ocr-local.txt", detail=str(exc)
        ) from exc

    warnings: list[str] = []
    is_heif = looks_like_heif(data)
    if is_heif:
        # HEIC/HEIF：Pillow 默认解不了，需要 pillow_heif 的 opener（首次遇到才懒加载）
        if not heif_available():
            logger.warning("HEIC input rejected: pillow-heif not installed")
            raise BadRequest(HEIC_UNSUPPORTED_MESSAGE)
        _register_heif_opener()
    try:
        probe = Image.open(io.BytesIO(data))
        if probe.width * probe.height > MAX_PIXELS:
            raise BadRequest(f"image too large: {probe.width}x{probe.height} > {MAX_PIXELS} pixels")
        image = ImageOps.exif_transpose(probe)
        image = image.convert("RGB")
    except VoiceError:
        raise
    except Exception as exc:
        if is_heif:
            raise BadRequest(
                f"这张 HEIC/HEIF 图片无法解码（文件可能损坏或使用了不支持的编码）。"
                f"请改用在相册里「存储为 JPEG」后重试，或改用「拍照」按钮。原始错误：{type(exc).__name__}"
            ) from exc
        raise BadRequest(f"cannot decode image: {type(exc).__name__}: {exc}") from exc

    width, height = image.size
    if width < MIN_SIDE or height < MIN_SIDE:
        raise BadRequest(f"image too small: {width}x{height}")

    longest = max(width, height)
    if longest > max_long_side:
        scale = max_long_side / float(longest)
        new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        image = image.resize(new_size, getattr(Image, "LANCZOS", 1))
        width, height = new_size
        warnings.append(WARNING_DOWNSCALED)
        logger.info("ocr image downscaled: %dx%d -> %dx%d", probe.width, probe.height, width, height)

    return image, width, height, warnings


def encode_jpeg_b64(image, quality: int = LLM_JPEG_QUALITY) -> str | None:
    """PIL RGB -> base64（不含 data: 前缀）。编码失败返回 None（调用方决定降级/加 warning）。"""
    try:
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=quality, optimize=True)
        return base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception as exc:  # pragma: no cover - 实际极少失败（PIL 纯内存编码）
        logger.warning("OCR image encode failed: %s", exc)
        return None


def jpeg_data_url(image, quality: int = LLM_JPEG_QUALITY) -> str | None:
    """PIL RGB -> `data:image/jpeg;base64,...`（视觉模型的 image_url 格式）；失败返回 None。"""
    encoded = encode_jpeg_b64(image, quality=quality)
    return f"data:image/jpeg;base64,{encoded}" if encoded is not None else None


# --------------------------------------------------------------------------------------
# 行解析 / 本地行排序
# --------------------------------------------------------------------------------------
_NUMBERING_RE = re.compile(r"^\s*(?:\d+[.)、]|[-•*])\s+")

# 模型对"没有可读文字"的图片可能返回字面量占位符（实测空白页返回 `` `<empty string>` ``），
# 这类返回必须当成"空"处理，否则会被当作英文原文展示给用户。
_PLACEHOLDER_RE = re.compile(r"^[`'\"\u2018\u2019\u201c\u201d\s]*(.*?)[`'\"\u2018\u2019\u201c\u201d\s]*$")
_PLACEHOLDERS = {
    "<empty string>", "<empty>", "<no text>", "<none>", "[empty]", "(empty)",
    "empty", "empty string", "n/a", "none", "null", "无", "（无）", "(无)",
}


def _normalize_llm_text(text: str | None) -> str:
    """把模型的占位符返回（如 `` `<empty string>` ``）归一成空串；正常文本原样返回。"""
    raw = (text or "").strip()
    if not raw:
        return ""
    match = _PLACEHOLDER_RE.match(raw)
    inner = (match.group(1) if match else raw).strip().lower()
    return "" if inner in _PLACEHOLDERS else raw


_LATIN_RE = re.compile(r"[A-Za-z]")


def lines_from_llm_text(text: str | None) -> list[str]:
    """把视觉模型返回的纯文本切成行：去首尾空白、丢空行、防御性去掉编号。

    额外过滤**不含任何拉丁字母**的行：本接口是"识别英文原文"，而模型偶尔会用中文
    解释（实测空白页返回"（注：由于原图几乎为空白，未识别到任何清晰的英文文本…）"），
    这类说明文字不是 OCR 结果，必须当空处理，否则会被 web 当成书页内容展示。
    """
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        stripped = _NUMBERING_RE.sub("", line).strip()
        if stripped:
            line = stripped
        if not _LATIN_RE.search(line):
            continue
        out.append(line)
    return out


def sort_ocr_lines(items) -> list[dict]:
    """本地 rapidocr 的文本框无序：按行聚类（行高 60% 容差，容忍手机拍照的轻微旋转）+ 行内按 x 排。"""
    parsed: list[tuple[float, float, float, str, float]] = []
    for item in items or []:
        if isinstance(item, dict):
            box, text, confidence = item.get("box"), item.get("text"), item.get("score")
        else:
            try:
                box, text, confidence = item[0], item[1], item[2]
            except (IndexError, TypeError):
                continue
        if not isinstance(text, str) or not text.strip():
            continue
        try:
            ys = [float(point[1]) for point in box]
            xs = [float(point[0]) for point in box]
        except Exception:
            continue
        if not ys or not xs:
            continue
        height = max(1.0, max(ys) - min(ys))
        parsed.append(((min(ys) + max(ys)) / 2.0, (min(xs) + max(xs)) / 2.0, height, text.strip(), _to_float(confidence)))

    parsed.sort(key=lambda item: item[0])
    rows: list[dict] = []
    for center_y, center_x, height, text, conf in parsed:
        if rows:
            current = rows[-1]
            tolerance = max(6.0, 0.6 * min(height, current["height"]))
            if abs(center_y - current["center_y"]) <= tolerance:
                current["items"].append((center_x, text, conf))
                current["center_y"] = (current["center_y"] * current["count"] + center_y) / (current["count"] + 1)
                current["count"] += 1
                current["height"] = max(current["height"], height)
                continue
        rows.append({"center_y": center_y, "height": height, "count": 1, "items": [(center_x, text, conf)]})

    lines: list[dict] = []
    for row in rows:
        for _center_x, text, conf in sorted(row["items"], key=lambda item: item[0]):
            lines.append({"text": text, "confidence": conf})
    return lines


def _to_float(value) -> float:
    try:
        return round(max(0.0, min(1.0, float(value))), 4)
    except (TypeError, ValueError):
        return 0.0


# --------------------------------------------------------------------------------------
# 两个 provider 的实现
# --------------------------------------------------------------------------------------
def _log_truncation(prefix: str, outcome, requested_tokens: int) -> None:
    logger.warning(
        "%s: finish_reason=length, requested max_tokens=%d, completion_tokens=%s, "
        "reasoning_tokens=%s, content_len=%d, reasoning_len=%d, thinking_disabled=%s",
        prefix,
        requested_tokens,
        outcome.completion_tokens,
        outcome.reasoning_tokens,
        len(outcome.text or ""),
        outcome.reasoning_len,
        outcome.thinking_disabled,
    )


def _call_llm(client: LLMClient, data_url: str, prompt: str, settings: Settings, max_tokens: int, disable_thinking: bool):
    return client.read_image(
        data_url,
        prompt,
        timeout_s=settings.ocr_timeout_s,
        max_tokens=max_tokens,
        disable_thinking=disable_thinking,
    )


def _recognize_with_llm(
    image, width: int, height: int, warnings: list[str], settings: Settings, return_image: bool
) -> OcrResult:
    client = LLMClient(settings)
    encoded = encode_jpeg_b64(image)
    if encoded is None:
        raise _LlmVisionFailed("image_encode_failed")
    data_url = f"data:image/jpeg;base64,{encoded}"
    started = time.perf_counter()
    max_tokens = max(1, int(settings.ocr_max_tokens))
    disable_thinking = bool(settings.ocr_disable_thinking)
    outcome = _call_llm(client, data_url, OCR_PROMPT, settings, max_tokens, disable_thinking)
    if not outcome.ok:
        raise _LlmVisionFailed(outcome.error or "unknown_error")

    # task-36：推理模型会把 max_tokens 吃在 reasoning 上（finish_reason=length，content 空/残缺）。
    # 检测到截断 → WARNING（含 completion/reasoning/content_len）+ 重试一次（×3，上限 4000，关思考）。
    if outcome.truncated:
        _log_truncation("LLM vision OCR truncated (root cause: reasoning tokens ate max_tokens)", outcome, max_tokens)
        bumped = min(max_tokens * TRUNCATION_RETRY_FACTOR, TRUNCATION_MAX_TOKENS_CAP)
        retried = _call_llm(client, data_url, OCR_PROMPT, settings, bumped, True)
        if retried.ok:
            logger.info(
                "LLM vision OCR truncation retry: max_tokens %d -> %d, thinking_disabled=%s, finish_reason=%s",
                max_tokens,
                bumped,
                retried.thinking_disabled,
                retried.finish_reason,
            )
            outcome = retried
            max_tokens = bumped
            if retried.truncated:
                _log_truncation("LLM vision OCR still truncated after retry", retried, bumped)
                warnings.append(WARNING_TRUNCATED)

    raw_text = _normalize_llm_text(outcome.text)
    texts = lines_from_llm_text(raw_text)

    if not texts:
        # task-35：模型对"没有英文就返回空"过度遵守（绘本封面/强反光等）→ 诊断日志 + 宽容重试一次。
        # 日志只打模型的**文本**返回前 200 字符（不含 base64 / 图片数据），用于区分：
        # 真空串 / 只有换行空白 / 拒答话术（"I'm sorry, I can't read this image."）。
        logger.warning(
            "LLM vision OCR returned empty text (provider=%s, raw_len=%d): raw_prefix=%r original_prefix=%r",
            outcome.provider,
            len(raw_text),
            raw_text[:200],
            (outcome.text or "")[:200],
        )
        retry = _call_llm(client, data_url, OCR_PROMPT_RETRY, settings, max_tokens, True)
        if not retry.ok:
            raise _LlmVisionFailed(retry.error or "unknown_error")
        retry_raw = _normalize_llm_text(retry.text)
        retry_texts = lines_from_llm_text(retry_raw)
        if not retry_texts:
            logger.warning(
                "LLM vision OCR still empty after lenient retry (raw_len=%d): raw_prefix=%r original_prefix=%r",
                len(retry_raw),
                retry_raw[:200],
                (retry.text or "")[:200],
            )
            warnings.append(WARNING_NO_TEXT)
            warnings.append(WARNING_EMPTY_RETRIED)
            texts = []
        else:
            logger.info("LLM vision OCR recovered %d line(s) on lenient retry", len(retry_texts))
            texts = retry_texts
    elapsed_ms = int(round((time.perf_counter() - started) * 1000))
    lines = [{"text": text, "confidence": None} for text in texts]  # 视觉模型没有置信度，不编造
    return OcrResult(
        provider=f"{outcome.provider} vision",
        text="\n".join(texts),
        lines=lines,
        width=width,
        height=height,
        elapsed_ms=elapsed_ms,
        warnings=warnings,
        image_jpeg_b64=encoded if return_image else None,
    )


def _recognize_with_local(
    image, width: int, height: int, warnings: list[str], return_image: bool
) -> OcrResult:
    engine = _get_engine()
    import numpy as np

    array = np.asarray(image)
    bgr = array[:, :, ::-1].copy()  # rapidocr 内部按 cv2(BGR) 处理
    started = time.perf_counter()
    try:
        raw = engine(bgr)
    except Exception as exc:
        raise BadRequest(f"OCR failed on this image: {type(exc).__name__}: {exc}") from exc
    elapsed_ms = int(round((time.perf_counter() - started) * 1000))

    items = raw[0] if isinstance(raw, tuple) else raw
    lines = sort_ocr_lines(items or [])
    if not lines:
        warnings.append(WARNING_NO_TEXT)
    encoded = None
    if return_image:
        encoded = encode_jpeg_b64(image)
        if encoded is None:
            warnings.append(WARNING_ENCODE_FAILED)
    return OcrResult(
        provider=LOCAL_PROVIDER_NAME,
        text="\n".join(line["text"] for line in lines),
        lines=lines,
        width=width,
        height=height,
        elapsed_ms=elapsed_ms,
        warnings=warnings,
        image_jpeg_b64=encoded,
    )


# --------------------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------------------
def recognize_image(data: bytes, settings: Settings | None = None, return_image: bool = False) -> OcrResult:
    """识别一张图片（内存中完成，不落盘）。LLM 视觉优先，失败降级本地（若可用）。

    `return_image=True` 时把**实际送去识别的那张预处理图**（EXIF 转正、长边 ≤1280、JPEG q85）
    以 base64 放进 `image_jpeg_b64`（供 web 存"我的书页"，避免存手机原图）。
    """
    settings = settings or get_settings()
    chain = ocr_chain(settings)
    if not chain:
        raise OcrUnavailable(
            "OCR 不可用：LLM 未配置（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），"
            "且本地 OCR 依赖未安装（离线兜底：pip install -r requirements-ocr-local.txt）"
        )

    max_side = MAX_LONG_SIDE_LLM if PROVIDER_LLM in chain else MAX_LONG_SIDE_LOCAL
    image, width, height, warnings = preprocess_image(data, settings, max_long_side=max_side)

    if PROVIDER_LLM in chain:
        try:
            return _recognize_with_llm(image, width, height, warnings, settings, return_image)
        except _LlmVisionFailed as exc:
            logger.warning("LLM vision OCR failed, falling back if possible: %s", exc)
            warnings.append(WARNING_LLM_FAILED)
            if PROVIDER_LOCAL not in chain:
                raise OcrUnavailable(
                    "LLM 视觉 OCR 调用失败，且没有可用的本地 OCR 兜底（安装 requirements-ocr-local.txt 可离线兜底）",
                    detail=str(exc),
                ) from exc

    return _recognize_with_local(image, width, height, warnings, return_image)
