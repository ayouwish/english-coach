"""task-25：`POST /v1/ocr`（离线拍照识别）+ `health.capabilities.ocr`。

真跑用 `tests/fixtures/ocr-page.jpg`（3 句英文，模拟手机拍照：轻微旋转+模糊+噪声+阴影）；
其余用构造图片/假引擎，**不联网、不下载模型**（rapidocr 的 PP-OCRv4 模型随包）。
"""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import ocr as ocr_module
from app.config import get_settings
from app.ocr import OcrUnavailable, preprocess_image, recognize_image, sort_ocr_lines

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "ocr-page.jpg"
OCR_KEYS = {"provider", "text", "lines", "width", "height", "elapsed_ms", "warnings"}
ROOT = Path(__file__).resolve().parent.parent
REQUIRES_OCR = pytest.mark.skipif(
    not ocr_module.engine_available(), reason="rapidocr-onnxruntime / opencv / pillow 未安装"
)


@pytest.fixture
def fake_ocr_provider(monkeypatch):
    """无 rapidocr 时注入假本地引擎，让路由级测试不依赖真实 OCR 依赖（CI 干净环境）。

    背景：`.venv` 里残留 rapidocr 时这些用例能过，但 CI 只装 requirements（不含 rapidocr），
    `ocr_chain()` 为空 → `/v1/ocr` 一律 503 → 测试必红。这里只替换 provider 选择与引擎调用，
    保留 `preprocess_image` / `_recognize_with_local` 的真实逻辑（尺寸、编码、warning 等仍被覆盖）。
    """
    if ocr_module.engine_available():
        yield
        return

    monkeypatch.setattr(ocr_module, "ocr_chain", lambda settings=None: [ocr_module.PROVIDER_LOCAL])

    class _FakeEngine:
        def __call__(self, array):
            return ([[[[0, 0], [100, 0], [100, 20], [0, 20]], "Hello world", 0.99]], 0.01)

    monkeypatch.setattr(ocr_module, "_get_engine", lambda: _FakeEngine())
    yield


def _post_image(client, payload: bytes, name: str = "page.jpg", content_type: str = "image/jpeg"):
    return client.post("/v1/ocr", files={"image": (name, payload, content_type)})


# --------------------------------------------------------------------------------------
# health 能力标记 + 启动惰性
# --------------------------------------------------------------------------------------
def test_health_reports_ocr_capability(client):
    body = client.get("/v1/health").json()
    assert "ocr" in body["capabilities"]
    assert isinstance(body["capabilities"]["ocr"], bool)
    # task-27：ocr = 任一 provider 可用（LLM 视觉 或 本地 rapidocr）
    assert body["capabilities"]["ocr"] is ocr_module.ocr_available()
    assert body["capabilities"]["ocr_provider"] in ("llm", "local", None)


def test_ocr_is_lazy_at_startup(tmp_path):
    """启动 + /v1/health 不能 import rapidocr / cv2（模型更不能加载）。"""
    code = """
import sys
from fastapi.testclient import TestClient
from app.main import app
with TestClient(app) as client:
    health = client.get('/v1/health').json()
assert isinstance(health['capabilities']['ocr'], bool), health
for name in ('rapidocr_onnxruntime', 'cv2', 'onnxruntime'):
    assert name not in sys.modules, (name, [k for k in sys.modules if k.startswith(name)])
print('LAZY_OCR_OK')
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
    assert "LAZY_OCR_OK" in result.stdout


# --------------------------------------------------------------------------------------
# 真跑：fixture 必须识别出 3 行
# --------------------------------------------------------------------------------------
@REQUIRES_OCR
def test_ocr_fixture_reads_three_lines(client):
    assert FIXTURE.is_file(), f"缺少 fixture: {FIXTURE}"
    response = _post_image(client, FIXTURE.read_bytes())
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == OCR_KEYS
    assert body["provider"] == "rapidocr"
    assert body["width"] > 0 and body["height"] > 0
    assert isinstance(body["elapsed_ms"], int) and body["elapsed_ms"] >= 0
    assert body["warnings"] == []

    texts = [line["text"] for line in body["lines"]]
    assert len(texts) == 3, texts
    joined = body["text"]
    assert "Hello" in joined and "tree" in joined
    assert joined == "\n".join(texts), "text 必须是按行序用 \\n 连接"
    assert texts[0].startswith("Hello"), f"行序应为从上到下: {texts}"

    for line in body["lines"]:
        assert set(line) == {"text", "confidence"}
        assert isinstance(line["text"], str) and line["text"]
        assert 0.0 <= float(line["confidence"]) <= 1.0


@REQUIRES_OCR
def test_ocr_does_not_write_anything_to_disk(client):
    """隐私：书页照片只在内存识别，不落盘（DATA_DIR 里不新增任何文件）。"""
    data_dir = get_settings().data_dir
    before = sorted(str(path) for path in data_dir.rglob("*"))
    response = _post_image(client, FIXTURE.read_bytes())
    assert response.status_code == 200
    after = sorted(str(path) for path in data_dir.rglob("*"))
    assert after == before, f"OCR 不应写盘，新增: {set(after) - set(before)}"


# --------------------------------------------------------------------------------------
# 错误语义
# --------------------------------------------------------------------------------------
@pytest.mark.usefixtures("fake_ocr_provider")
def test_ocr_non_image_returns_400(client):
    response = _post_image(client, b"this is definitely not an image", name="notes.txt", content_type="text/plain")
    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "bad_request"
    assert set(body["error"]) == {"code", "message", "detail"}


def test_ocr_empty_file_returns_400(client):
    response = _post_image(client, b"")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"


def test_ocr_oversized_returns_413(client):
    too_big = b"\xff\xd8\xff" + b"x" * (10 * 1024 * 1024)
    response = _post_image(client, too_big)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


@pytest.mark.usefixtures("fake_ocr_provider")
def test_ocr_accepts_at_limit_size(client, monkeypatch):
    """恰好 10MB 的上限不应被 413（大小判断是 > 而不是 >=），随后因不是图片而 400。"""
    payload = b"\xff\xd8\xff" + b"x" * (10 * 1024 * 1024 - 3)
    assert len(payload) == 10 * 1024 * 1024
    response = _post_image(client, payload)
    assert response.status_code == 400  # 超过大小限制之后才是解码失败
    assert response.json()["error"]["code"] == "bad_request"


def test_ocr_missing_dependency_returns_503(client, monkeypatch):
    """依赖没装 → 503 provider_unavailable（消息里给出安装命令），而不是 500/400。"""
    ocr_module.reset_engine()
    monkeypatch.setitem(sys.modules, "rapidocr_onnxruntime", None)  # 模拟未安装 → import 抛错
    try:
        response = _post_image(client, FIXTURE.read_bytes())
    finally:
        ocr_module.reset_engine()
    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == "provider_unavailable"
    assert "requirements-ocr-local.txt" in body["error"]["message"]


# --------------------------------------------------------------------------------------
# 预处理：EXIF 旋转 / 缩放 / RGB
# --------------------------------------------------------------------------------------
def _image_with_exif_orientation(orientation: int) -> bytes:
    from PIL import Image

    image = Image.new("RGB", (200, 100), (255, 255, 255))
    for x in range(80):
        for y in range(40):
            image.putpixel((x, y), (0, 0, 0))  # 左上角黑块
    exif = image.getexif()
    exif[274] = orientation  # 274 = Orientation
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif.tobytes())
    return buffer.getvalue()


def test_exif_orientation_is_applied():
    """Orientation=6（顺时针 90°）必须先把图转正：200x100 -> 100x200，左上黑块转到右上。"""
    data = _image_with_exif_orientation(6)
    image, width, height, warnings = preprocess_image(data)
    assert (width, height) == (100, 200), (width, height)
    assert warnings == []
    top_right = image.getpixel((width - 1, 0))
    assert sum(top_right) < 120, f"EXIF 旋转未生效，右上角应为原来的黑色块，实际 {top_right}"


def test_preprocess_downscales_long_side():
    from PIL import Image

    image = Image.new("RGB", (4000, 300), (255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    out, width, height, warnings = preprocess_image(buffer.getvalue())
    assert max(width, height) <= 1600
    assert "image_downscaled" in warnings
    assert round(width / height, 2) == round(4000 / 300, 2), "等比缩小"


def test_preprocess_converts_to_rgb():
    from PIL import Image

    image = Image.new("RGBA", (40, 20), (10, 20, 30, 128))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    out, width, height, warnings = preprocess_image(buffer.getvalue())
    assert out.mode == "RGB"
    assert (width, height) == (40, 20)
    assert warnings == []


def test_preprocess_rejects_tiny_image():
    from PIL import Image

    image = Image.new("RGB", (4, 4), (255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    from app.errors import BadRequest

    with pytest.raises(BadRequest):
        preprocess_image(buffer.getvalue())


# --------------------------------------------------------------------------------------
# 行序（rapidocr 返回无序文本框）
# --------------------------------------------------------------------------------------
def test_line_order_is_top_to_bottom_then_left_to_right():
    # 故意乱序：第二行在前、第一行两段在后
    items = [
        [[[10, 120], [300, 120], [300, 160], [10, 160]], "second line", 0.9],
        [[[10, 40], [200, 40], [200, 80], [10, 80]], "first A", 0.8],
        [[[220, 42], [380, 42], [380, 82], [220, 82]], "first B", 0.7],
    ]
    lines = sort_ocr_lines(items)
    assert [line["text"] for line in lines] == ["first A", "first B", "second line"]
    assert all(isinstance(line["confidence"], float) for line in lines)


def test_line_order_tolerates_slight_rotation():
    """轻微旋转让同一行 y 有抖动，仍应按行聚合，而不是拆成两行。"""
    items = [
        [[[10, 50], [200, 42], [200, 78], [10, 86]], "row1-left", 0.9],
        [[[220, 40], [400, 32], [400, 68], [220, 76]], "row1-right", 0.9],
        [[[10, 140], [400, 132], [400, 168], [10, 176]], "row2", 0.9],
    ]
    texts = [line["text"] for line in sort_ocr_lines(items)]
    assert texts == ["row1-left", "row1-right", "row2"], texts


def test_sort_ocr_lines_skips_malformed_items():
    items = [None, [], {"text": "", "box": [[0, 0], [1, 0], [1, 1], [0, 1]], "score": 0.5}]
    assert sort_ocr_lines(items) == []


# --------------------------------------------------------------------------------------
# 响应字段契约
# --------------------------------------------------------------------------------------
@REQUIRES_OCR
def test_ocr_response_contract_types(client):
    body = _post_image(client, FIXTURE.read_bytes()).json()
    assert set(body) == OCR_KEYS
    assert isinstance(body["provider"], str) and body["provider"]
    assert isinstance(body["text"], str)
    assert isinstance(body["lines"], list)
    assert isinstance(body["width"], int) and isinstance(body["height"], int)
    assert isinstance(body["elapsed_ms"], int)
    assert isinstance(body["warnings"], list)
    json.dumps(body)  # 必须可 JSON 序列化


@pytest.mark.usefixtures("fake_ocr_provider")
def test_recognize_image_returns_no_text_warning_for_blank_page(monkeypatch):
    """空白页：不报错，text=""、lines=[]，warnings 里显式说明没找到文字。"""
    from PIL import Image

    class FakeEngine:
        def __call__(self, array):
            return None, 0.01  # rapidocr 没检测到文字时返回 None

    monkeypatch.setattr(ocr_module, "_get_engine", lambda: FakeEngine())
    image = Image.new("RGB", (600, 300), (255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    result = recognize_image(buffer.getvalue())
    assert result.text == ""
    assert result.lines == []
    assert "no_text_found" in result.warnings


@pytest.mark.usefixtures("fake_ocr_provider")
def test_engine_singleton_is_reused(monkeypatch, tmp_path):
    created = []

    class FakeEngine:
        def __call__(self, array):
            return ([[[[0, 0], [100, 0], [100, 20], [0, 20]], "hello", 0.99]], 0.01)

    def fake_get_engine():
        if not created:
            created.append(FakeEngine())
        return created[0]

    monkeypatch.setattr(ocr_module, "_get_engine", fake_get_engine)
    from PIL import Image

    image = Image.new("RGB", (300, 200), (255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    data = buffer.getvalue()
    assert recognize_image(data).text == "hello"
    assert recognize_image(data).text == "hello"
    assert len(created) == 1, "引擎必须是单例（模型只加载一次）"


# --------------------------------------------------------------------------------------
# task-28：可选返回预处理后的 JPEG（供 web 存"我的书页"）
# --------------------------------------------------------------------------------------
def _post_fixture(client, form: dict):
    return client.post(
        "/v1/ocr",
        files={"image": ("page.jpg", FIXTURE.read_bytes(), "image/jpeg")},
        data=form,
    )


def _decode_jpeg(b64: str):
    from PIL import Image

    assert not b64.startswith("data:"), "响应里必须是纯 base64，不含 data: 前缀"
    raw = base64.b64decode(b64)
    assert raw[:3] == b"\xff\xd8\xff", "必须是 JPEG（SOI 标记）"
    return Image.open(io.BytesIO(raw))


@pytest.mark.usefixtures("fake_ocr_provider")
def test_return_image_absent_by_default(client):
    body = _post_fixture(client, {}).json()
    assert "image_jpeg_b64" not in body, "未请求时字段应缺失（不是 null）"
    assert set(body) == OCR_KEYS


@pytest.mark.usefixtures("fake_ocr_provider")
def test_return_image_local_path(client):
    """本地路径：返回实际识别用的预处理图（JPEG，尺寸与 width/height 一致）。"""
    body = _post_fixture(client, {"return_image": "1"}).json()
    assert "image_jpeg_b64" in body
    image = _decode_jpeg(body["image_jpeg_b64"])
    assert image.format == "JPEG"
    assert image.size == (body["width"], body["height"])
    assert max(image.size) <= 1280
    # 其余字段不受影响
    assert body["provider"] == "rapidocr"
    assert body["text"].startswith("Hello")


@pytest.mark.usefixtures("fake_ocr_provider")
def test_return_image_true_string(client):
    body = _post_fixture(client, {"return_image": "true"}).json()
    assert "image_jpeg_b64" in body


def test_return_image_false_values_absent(client):
    for value in ("0", "false", "no", ""):
        body = _post_fixture(client, {"return_image": value}).json()
        assert "image_jpeg_b64" not in body, f"return_image={value!r} 不应返回图片"


@pytest.mark.usefixtures("fake_ocr_provider")
def test_return_image_downscales_3000x2000(client):
    """3000×2000 大图 → 返回的 JPEG 长边 ≤1280（web 存小图）。"""
    from PIL import Image

    image = Image.new("RGB", (3000, 2000), (250, 250, 245))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=90)
    response = client.post(
        "/v1/ocr",
        files={"image": ("big.jpg", buffer.getvalue(), "image/jpeg")},
        data={"return_image": "1"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert "image_jpeg_b64" in body
    sent = _decode_jpeg(body["image_jpeg_b64"])
    assert max(sent.size) <= 1280
    assert sent.size == (body["width"], body["height"])
    assert "image_downscaled" in body["warnings"]


@pytest.mark.usefixtures("fake_ocr_provider")
def test_return_image_encode_failure_warning(client, monkeypatch):
    """编码失败：warnings 里明确说明，且不返回该字段（不是返回空串/null）。"""
    monkeypatch.setattr(ocr_module, "encode_jpeg_b64", lambda *a, **k: None)
    body = _post_fixture(client, {"return_image": "1"}).json()
    assert "image_jpeg_b64" not in body
    assert "image_encode_failed" in body["warnings"]
    assert body["text"].startswith("Hello")  # 识别本身不受影响
