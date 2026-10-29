"""task-38：`/v1/ocr` 支持 HEIC/HEIF（iPhone 相册默认格式）+ 缺依赖时可操作报错。

真 HEIC 用 `pillow_heif` 现场生成（不联网）；未安装场景用假 HEIF 头 + monkeypatch。
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import ocr as ocr_module
from app.config import reset_settings_cache
from app.ocr import HEIC_UNSUPPORTED_MESSAGE, heif_available, looks_like_heif, preprocess_image

ROOT = Path(__file__).resolve().parent.parent
HEIC_MAGIC = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 64


def _require_pillow_heif():
    return pytest.importorskip("pillow_heif", reason="pillow-heif 未安装")


def _make_heic(width: int = 900, height: int = 400) -> bytes:
    from PIL import Image, ImageDraw

    _require_pillow_heif()
    from pillow_heif import register_heif_opener

    register_heif_opener()
    image = Image.new("RGB", (width, height), (250, 248, 242))
    draw = ImageDraw.Draw(image)
    draw.text((60, 60), "Hello! My name is Lily.", fill=(30, 30, 30))
    draw.text((60, 140), "Can you see three birds?", fill=(30, 30, 30))
    buffer = io.BytesIO()
    image.save(buffer, format="HEIF", quality=85)
    return buffer.getvalue()


class _FakeEngine:
    def __call__(self, array):
        return (
            [
                [[[0, 0], [300, 0], [300, 20], [0, 20]], "Hello! My name is Lily.", 0.98],
                [[[0, 30], [300, 30], [300, 50], [0, 50]], "Can you see three birds?", 0.97],
            ],
            0.01,
        )


@pytest.fixture
def fake_local_ocr(monkeypatch):
    monkeypatch.setattr(ocr_module, "engine_available", lambda: True)
    monkeypatch.setattr(ocr_module, "_get_engine", lambda: _FakeEngine())
    return _FakeEngine()


# --------------------------------------------------------------------------------------
# HEIF 魔数检测
# --------------------------------------------------------------------------------------
def test_looks_like_heif_detects_brands():
    for brand in (b"heic", b"heix", b"hevc", b"mif1", b"msf1", b"HEIC"):
        data = b"\x00\x00\x00\x18ftyp" + brand + b"\x00" * 64
        assert looks_like_heif(data), brand


def test_looks_like_heif_rejects_others():
    assert not looks_like_heif(open(ROOT / "tests" / "fixtures" / "ocr-page.jpg", "rb").read())
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    assert not looks_like_heif(png)
    assert not looks_like_heif(b"short")
    assert not looks_like_heif(b"")
    # ISO BMFF 但不是 HEIF（例如 mp4）
    assert not looks_like_heif(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64)


# --------------------------------------------------------------------------------------
# 真 HEIC 解码（大尺寸 → 缩到 ≤1280）
# --------------------------------------------------------------------------------------
def test_heic_decodes_and_downscales():
    data = _make_heic(3000, 2000)
    assert looks_like_heif(data), "生成的 HEIC 魔数应可识别"
    image, width, height, warnings = preprocess_image(data, max_long_side=1280)
    assert image.mode == "RGB"
    assert max(width, height) <= 1280
    assert (width, height) == image.size
    assert "image_downscaled" in warnings


def test_heic_ocr_endpoint(client, fake_local_ocr):
    """HEIC 走完整 /v1/ocr：不报 400，进入识别流程，返回预处理尺寸 ≤1280。"""
    data = _make_heic(3000, 2000)
    response = client.post("/v1/ocr", files={"image": ("photo.heic", data, "image/heic")})
    assert response.status_code == 200, response.text
    body = response.json()
    assert max(body["width"], body["height"]) <= 1280
    assert body["text"] == "Hello! My name is Lily.\nCan you see three birds?"
    assert [line["text"] for line in body["lines"]] == body["text"].split("\n")


def test_heic_does_not_crash_on_exif_orientation():
    """带 EXIF Orientation 的 HEIC 不应崩溃（尺寸/方向做防御性处理）。"""
    _require_pillow_heif()
    from PIL import Image

    from pillow_heif import register_heif_opener

    register_heif_opener()
    image = Image.new("RGB", (200, 100), (255, 255, 255))
    exif = image.getexif()
    exif[274] = 6  # Orientation = rotate 90° CW
    buffer = io.BytesIO()
    try:
        image.save(buffer, format="HEIF", exif=exif.tobytes())
    except Exception:  # 某些版本不支持写 EXIF → 至少验证无 EXIF 的 HEIC 不崩
        buffer = io.BytesIO()
        image.save(buffer, format="HEIF")
    out, width, height, warnings = preprocess_image(buffer.getvalue(), max_long_side=1280)
    assert out.mode == "RGB"
    assert width > 0 and height > 0
    assert {int(width), int(height)} == {100, 200}


# --------------------------------------------------------------------------------------
# 未安装 pillow_heif：400 + 可操作消息
# --------------------------------------------------------------------------------------
def test_heic_without_pillow_heif_returns_actionable_400(client, monkeypatch, fake_local_ocr):
    monkeypatch.setattr(ocr_module, "heif_available", lambda: False)
    response = client.post("/v1/ocr", files={"image": ("photo.heic", HEIC_MAGIC, "image/heic")})
    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "bad_request"
    message = body["error"]["message"]
    assert "HEIC" in message, message
    assert "JPEG" in message or "拍照" in message, f"消息必须可操作: {message}"
    assert message == HEIC_UNSUPPORTED_MESSAGE


def test_corrupt_heic_gives_actionable_400(client, fake_local_ocr):
    _require_pillow_heif()
    response = client.post("/v1/ocr", files={"image": ("bad.heic", HEIC_MAGIC, "image/heic")})
    assert response.status_code == 400
    message = response.json()["error"]["message"]
    assert "HEIC" in message, message


def test_jpeg_and_png_unaffected(client, fake_local_ocr):
    """JPEG/PNG 回归：HEIC 支持不影响既有格式。"""
    jpeg = (ROOT / "tests" / "fixtures" / "ocr-page.jpg").read_bytes()
    assert client.post("/v1/ocr", files={"image": ("page.jpg", jpeg, "image/jpeg")}).status_code == 200

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (900, 400), (255, 255, 255)).save(buffer, format="PNG")
    png = buffer.getvalue()
    assert not looks_like_heif(png)
    response = client.post("/v1/ocr", files={"image": ("page.png", png, "image/png")})
    assert response.status_code == 200, response.text
    assert response.json()["width"] == 900


# --------------------------------------------------------------------------------------
# health 能力标记 + 启动惰性
# --------------------------------------------------------------------------------------
def test_health_reports_heic_capability(client):
    capabilities = client.get("/v1/health").json()["capabilities"]
    assert "heic" in capabilities
    assert isinstance(capabilities["heic"], bool)
    assert capabilities["heic"] is heif_available()


def test_startup_does_not_import_pillow_heif(tmp_path):
    """启动 + /v1/health 不能 import pillow_heif（首次遇到 HEIC 才懒加载）。"""
    code = """
import sys
from fastapi.testclient import TestClient
from app.main import app
with TestClient(app) as client:
    caps = client.get('/v1/health').json()['capabilities']
assert isinstance(caps['heic'], bool), caps
assert 'pillow_heif' not in sys.modules, [k for k in sys.modules if 'heif' in k]
print('LAZY_HEIF_OK')
"""
    env = {
        **os.environ,
        "PROVIDER_MODE": "mock",
        "ENV_FILE": str(tmp_path / "none.env"),
        "DATA_DIR": str(tmp_path),
        "MODEL_CACHE_DIR": str(tmp_path / "models"),
    }
    result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stderr
    assert "LAZY_HEIF_OK" in result.stdout
