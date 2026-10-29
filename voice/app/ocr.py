"""拍照 OCR：离线 `rapidocr-onnxruntime`（自带 PP-OCRv4 模型），零密钥、零联网、**不落盘**。

为什么是 rapidocr：PP-OCRv4 检测+识别+方向分类都是 ONNX，CPU 上 780×300 热启动约 0.5–0.8s；
依赖只有 onnxruntime + opencv + pillow（≈90MB），也不需要任何云密钥。
（Azure 视觉要联网 + 密钥，且延迟不可控，本机形态不适合。）

隐私：孩子书页照片**只在内存里识别**，不写任何文件、不留缓存。
"""

from __future__ import annotations

import io
import logging
import threading
import time
from dataclasses import dataclass, field

from .config import Settings, get_settings
from .errors import BadRequest, PayloadTooLarge, VoiceError

logger = logging.getLogger("voice.ocr")

MAX_LONG_SIDE = 1600  # 长边超过就等比缩小（CPU 与实测精度都不需要更高分辨率）
MAX_PIXELS = 40_000_000  # 解码前的像素上限（防解压炸弹）
MIN_SIDE = 8
PROVIDER_NAME = "rapidocr"

_ENGINE_LOCK = threading.Lock()
_ENGINE: dict[str, object] = {}


class OcrUnavailable(VoiceError):
    """OCR 依赖缺失（没装 rapidocr/opencv/pillow）→ 503 provider_unavailable。"""

    code = "provider_unavailable"


@dataclass
class OcrResult:
    text: str
    lines: list[dict] = field(default_factory=list)
    width: int = 0
    height: int = 0
    elapsed_ms: int = 0
    warnings: list[str] = field(default_factory=list)
    provider: str = PROVIDER_NAME

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


def engine_available() -> bool:
    """health 用：只探测依赖是否存在（`find_spec` 不 import，也不加载模型）。"""
    import importlib.util

    for name in ("rapidocr_onnxruntime", "PIL", "cv2"):
        try:
            if importlib.util.find_spec(name) is None:
                return False
        except Exception:  # pragma: no cover - 环境异常按不可用处理
            return False
    return True


def _get_engine():
    """懒加载单例：首次调用才加载 PP-OCRv4 模型（约 1–2s），之后复用。"""
    with _ENGINE_LOCK:
        engine = _ENGINE.get("engine")
        if engine is not None:
            return engine
        try:
            from rapidocr_onnxruntime import RapidOCR  # 惰性导入：启动时不加载重依赖
        except Exception as exc:
            raise OcrUnavailable(
                "OCR 依赖未安装（rapidocr-onnxruntime / pillow / opencv）。"
                "请在 voice/ 下执行：pip install -r requirements.txt",
                detail=str(exc),
            ) from exc
        try:
            engine = RapidOCR()
        except Exception as exc:
            raise OcrUnavailable("OCR 模型加载失败（rapidocr 自带模型文件损坏？）", detail=str(exc)) from exc
        _ENGINE["engine"] = engine
        logger.info("rapidocr engine loaded (lazy, ~1-2s)")
        return engine


def reset_engine() -> None:
    """测试用：清掉单例。"""
    with _ENGINE_LOCK:
        _ENGINE.clear()


# --------------------------------------------------------------------------------------
# 图片预处理
# --------------------------------------------------------------------------------------
def preprocess_image(data: bytes, settings: Settings | None = None):
    """bytes -> (PIL.Image RGB, out_w, out_h, warnings)。

    - `ImageOps.exif_transpose`：手机照片常带 Orientation（如 6=顺时针 90°），
      不转正会让整页文字变成竖排 → OCR 直接失败。
    - 转 RGB（去 alpha / 调色板 / CMYK）。
    - 长边 > MAX_LONG_SIDE 等比缩小；像素总量上限保护。
    """
    settings = settings or get_settings()
    if not data:
        raise BadRequest("empty image payload")
    if len(data) > settings.max_ocr_bytes:
        raise PayloadTooLarge(f"image too large: {len(data)} bytes > {settings.max_ocr_bytes}")

    try:
        from PIL import Image, ImageOps  # 惰性导入
    except Exception as exc:  # pragma: no cover - 依赖未安装
        raise OcrUnavailable("Pillow 未安装，无法处理图片", detail=str(exc)) from exc

    warnings: list[str] = []
    try:
        probe = Image.open(io.BytesIO(data))
        if probe.width * probe.height > MAX_PIXELS:
            raise BadRequest(f"image too large: {probe.width}x{probe.height} > {MAX_PIXELS} pixels")
        image = ImageOps.exif_transpose(probe)  # 处理 EXIF 旋转
        image = image.convert("RGB")
    except VoiceError:
        raise
    except Exception as exc:
        raise BadRequest(f"cannot decode image: {type(exc).__name__}: {exc}") from exc

    width, height = image.size
    if width < MIN_SIDE or height < MIN_SIDE:
        raise BadRequest(f"image too small: {width}x{height}")

    longest = max(width, height)
    if longest > MAX_LONG_SIDE:
        scale = MAX_LONG_SIDE / float(longest)
        new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        image = image.resize(new_size, getattr(Image, "LANCZOS", 1))
        width, height = new_size
        warnings.append("image_downscaled")
        logger.info("ocr image downscaled: %dx%d -> %dx%d", probe.width, probe.height, width, height)

    return image, width, height, warnings


def sort_ocr_lines(items) -> list[dict]:
    """rapidocr 返回的文本框是**无序**的：按行（纵坐标）从上到下、行内按横坐标排序。

    注意：手机拍照常带轻微旋转，同一行的文本框 y 会差十几像素，
    所以不能简单按 y 分桶（会把一行拆成两行、顺序错乱）。这里按"行高 60% 的容差"
    把 y 相邻、垂直位置接近的框聚成一行，再在行内按 x 排。
    """
    parsed: list[tuple[float, float, float, str, float]] = []  # (center_y, center_x, height, text, conf)
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

    parsed.sort(key=lambda item: item[0])  # 先按纵坐标粗排

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


def recognize_image(data: bytes, settings: Settings | None = None) -> OcrResult:
    """识别一张图片（内存中完成，不落盘）。"""
    settings = settings or get_settings()
    image, width, height, warnings = preprocess_image(data, settings)
    engine = _get_engine()

    import numpy as np  # numpy 是基础依赖

    # rapidocr 内部按 cv2（BGR）习惯处理，这里把 PIL 的 RGB 转成 BGR 再传
    array = np.asarray(image)
    bgr = array[:, :, ::-1].copy()

    started = time.perf_counter()
    try:
        raw = engine(bgr)
    except Exception as exc:
        raise BadRequest(f"OCR failed on this image: {type(exc).__name__}: {exc}") from exc
    elapsed_ms = int(round((time.perf_counter() - started) * 1000))

    # rapidocr 1.x 返回 (result, elapse)；result 可能为 None（未检测到文字）
    items = raw[0] if isinstance(raw, tuple) else raw
    lines = sort_ocr_lines(items or [])
    if not lines:
        warnings.append("no_text_found")
    text = "\n".join(line["text"] for line in lines)
    return OcrResult(
        text=text,
        lines=lines,
        width=width,
        height=height,
        elapsed_ms=elapsed_ms,
        warnings=warnings,
    )
