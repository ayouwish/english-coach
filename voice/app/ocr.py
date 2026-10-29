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
MAX_LONG_SIDE_LOCAL = 1600  # 本地 PP-OCR 用 1600
MAX_PIXELS = 40_000_000  # 解码前像素上限（防解压炸弹）
MIN_SIDE = 8
LLM_JPEG_QUALITY = 85

PROVIDER_LLM = "llm"
PROVIDER_LOCAL = "local"
LOCAL_PROVIDER_NAME = "rapidocr"
WARNING_LLM_FAILED = "llm_vision_failed"
WARNING_NO_TEXT = "no_text_found"
WARNING_DOWNSCALED = "image_downscaled"

OCR_PROMPT = (
    "请逐行输出图片中的英文原文：\n"
    "1. 每行对应图片里的一行文字，按从上到下的顺序排列；\n"
    "2. 不要编号、不要加解释、不要翻译、不要加引号；\n"
    "3. 保留原文的标点与大小写；\n"
    "4. 忽略中文注释、页码、书名、页眉页脚；\n"
    "5. 如果图片里没有英文，返回空字符串。\n"
    "只输出识别到的英文文本本身。"
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

    def to_contract(self) -> dict:
        return {
            "provider": self.provider,
            "text": self.text,
            "lines": self.lines,
            "width": self.width,
            "height": self.height,
            "elapsed_ms": self.elapsed_ms,
            "warnings": self.warnings,
        }


# --------------------------------------------------------------------------------------
# 可用性 / provider 链
# --------------------------------------------------------------------------------------
def llm_vision_available() -> bool:
    """LLM 视觉是否可用：只看配置（不联网）。"""
    try:
        return LLMClient().vision_available
    except Exception:  # pragma: no cover - 配置异常按不可用处理
        return False


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
    try:
        probe = Image.open(io.BytesIO(data))
        if probe.width * probe.height > MAX_PIXELS:
            raise BadRequest(f"image too large: {probe.width}x{probe.height} > {MAX_PIXELS} pixels")
        image = ImageOps.exif_transpose(probe)
        image = image.convert("RGB")
    except VoiceError:
        raise
    except Exception as exc:
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


def jpeg_data_url(image, quality: int = LLM_JPEG_QUALITY) -> str:
    """PIL RGB -> `data:image/jpeg;base64,...`（视觉模型的 image_url 格式）。"""
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


# --------------------------------------------------------------------------------------
# 行解析 / 本地行排序
# --------------------------------------------------------------------------------------
_NUMBERING_RE = re.compile(r"^\s*(?:\d+[.)、]|[-•*])\s+")


def lines_from_llm_text(text: str | None) -> list[str]:
    """把视觉模型返回的纯文本切成行：去首尾空白、丢空行、防御性去掉编号。"""
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        stripped = _NUMBERING_RE.sub("", line).strip()
        if stripped:
            line = stripped
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
def _recognize_with_llm(image, width: int, height: int, warnings: list[str], settings: Settings) -> OcrResult:
    client = LLMClient(settings)
    data_url = jpeg_data_url(image)
    started = time.perf_counter()
    outcome = client.read_image(
        data_url,
        OCR_PROMPT,
        timeout_s=settings.ocr_timeout_s,
        max_tokens=settings.ocr_max_tokens,
    )
    elapsed_ms = int(round((time.perf_counter() - started) * 1000))
    if not outcome.ok:
        raise _LlmVisionFailed(outcome.error or "unknown_error")

    texts = lines_from_llm_text(outcome.text)
    if not texts:
        warnings.append(WARNING_NO_TEXT)
    lines = [{"text": text, "confidence": None} for text in texts]  # 视觉模型没有置信度，不编造
    return OcrResult(
        provider=f"{outcome.provider} vision",
        text="\n".join(texts),
        lines=lines,
        width=width,
        height=height,
        elapsed_ms=elapsed_ms,
        warnings=warnings,
    )


def _recognize_with_local(image, width: int, height: int, warnings: list[str]) -> OcrResult:
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
    return OcrResult(
        provider=LOCAL_PROVIDER_NAME,
        text="\n".join(line["text"] for line in lines),
        lines=lines,
        width=width,
        height=height,
        elapsed_ms=elapsed_ms,
        warnings=warnings,
    )


# --------------------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------------------
def recognize_image(data: bytes, settings: Settings | None = None) -> OcrResult:
    """识别一张图片（内存中完成，不落盘）。LLM 视觉优先，失败降级本地（若可用）。"""
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
            return _recognize_with_llm(image, width, height, warnings, settings)
        except _LlmVisionFailed as exc:
            logger.warning("LLM vision OCR failed, falling back if possible: %s", exc)
            warnings.append(WARNING_LLM_FAILED)
            if PROVIDER_LOCAL not in chain:
                raise OcrUnavailable(
                    "LLM 视觉 OCR 调用失败，且没有可用的本地 OCR 兜底（安装 requirements-ocr-local.txt 可离线兜底）",
                    detail=str(exc),
                ) from exc

    return _recognize_with_local(image, width, height, warnings)
