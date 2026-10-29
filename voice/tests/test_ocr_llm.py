"""task-27：OCR 改为 DeepSeek 多模态为主（LLM 视觉），本地 rapidocr 仅兜底。

全部用**假 LLM**（monkeypatch `app.llm.httpx.post`），不真调外部 API、不联网。
"""

from __future__ import annotations

import base64
import io
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import ocr as ocr_module
from app.config import reset_settings_cache
from app.ocr import (
    MAX_LONG_SIDE_LLM,
    OCR_PROMPT,
    lines_from_llm_text,
    ocr_chain,
    active_ocr_provider,
    ocr_available,
)
from app.providers.registry import reset_providers

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "ocr-page.jpg"
OCR_KEYS = {"provider", "text", "lines", "width", "height", "elapsed_ms", "warnings"}
ROOT = Path(__file__).resolve().parent.parent

THREE_LINES = "Hello! My name is Lily.\nI like drawing cats and dogs.\nCan you see three birds in the tree?"


class _FakeResponse:
    def __init__(self, content, status: int = 200):
        self._content = content
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")
        return None

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


@pytest.fixture
def fake_vision(monkeypatch):
    """LLM 已配置 + httpx.post 被替换；返回 (calls, queue)。"""
    monkeypatch.setenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "deepseek-flash")
    monkeypatch.delenv("VOICE_OCR_PROVIDER", raising=False)
    reset_settings_cache()
    reset_providers()
    calls: list[dict] = []
    queue: list[object] = []

    def fake_post(url, headers=None, json=None, timeout=None):  # noqa: A002
        calls.append({"url": url, "headers": headers, "body": json})
        item = queue.pop(0) if queue else _FakeResponse(THREE_LINES)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr("app.llm.httpx.post", fake_post)
    yield calls, queue
    reset_settings_cache()
    reset_providers()


@pytest.fixture
def fake_local(monkeypatch):
    """本地 OCR 可用（假引擎），不加载真模型。"""

    class FakeEngine:
        def __call__(self, array):
            return (
                [
                    [[[0, 0], [300, 0], [300, 20], [0, 20]], "Local line one.", 0.99],
                    [[[0, 30], [300, 30], [300, 50], [0, 50]], "Local line two.", 0.95],
                ],
                0.01,
            )

    monkeypatch.setattr(ocr_module, "engine_available", lambda: True)
    monkeypatch.setattr(ocr_module, "_get_engine", lambda: FakeEngine())
    return FakeEngine()


def _post_image(client, payload: bytes | None = None):
    data = payload if payload is not None else FIXTURE.read_bytes()
    return client.post("/v1/ocr", files={"image": ("page.jpg", data, "image/jpeg")})


def _make_jpeg(width: int, height: int) -> bytes:
    from PIL import Image

    image = Image.new("RGB", (width, height), (255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=80)
    return buffer.getvalue()


# --------------------------------------------------------------------------------------
# LLM 视觉主路径
# --------------------------------------------------------------------------------------
def test_llm_ocr_success_contract(client, fake_vision):
    calls, _queue = fake_vision
    response = _post_image(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == OCR_KEYS
    assert body["provider"] == "deepseek vision"
    assert body["text"] == THREE_LINES
    assert [line["text"] for line in body["lines"]] == THREE_LINES.split("\n")
    assert body["width"] == 900 and body["height"] == 400
    assert isinstance(body["elapsed_ms"], int) and body["elapsed_ms"] >= 0
    assert body["warnings"] == []

    # 请求形状：OpenAI 兼容多模态 content = [text, image_url(data URL)]
    request = calls[0]["body"]
    assert request["model"] == "deepseek-flash"
    assert request["max_tokens"] == 800
    content = request["messages"][0]["content"]
    assert content[0]["type"] == "text" and OCR_PROMPT[:12] in content[0]["text"]
    image_part = content[1]
    assert image_part["type"] == "image_url"
    assert image_part["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_llm_lines_have_null_confidence(client, fake_vision):
    """视觉模型没有置信度：必须给 null，不许编造。"""
    body = _post_image(client).json()
    assert body["provider"] == "deepseek vision"
    assert all(line["confidence"] is None for line in body["lines"])


def test_llm_image_is_downscaled_to_1280_and_sent_as_jpeg(client, fake_vision):
    calls, _queue = fake_vision
    body = _post_image(client, _make_jpeg(3000, 1000)).json()
    assert max(body["width"], body["height"]) <= MAX_LONG_SIDE_LLM
    assert "image_downscaled" in body["warnings"]
    data_url = calls[0]["body"]["messages"][0]["content"][1]["image_url"]["url"]
    encoded = data_url.split(",", 1)[1]
    from PIL import Image

    sent = Image.open(io.BytesIO(base64.b64decode(encoded)))
    assert sent.format == "JPEG"
    assert max(sent.size) <= MAX_LONG_SIDE_LLM


def test_llm_ocr_works_without_local_deps(client, fake_vision, monkeypatch):
    """**没有本地 OCR 依赖**时也必须能工作（LLM 视觉是主路径）。"""
    monkeypatch.setattr(ocr_module, "engine_available", lambda: False)
    assert ocr_module.ocr_chain(reset_and_get_settings()) == ["llm"]
    response = _post_image(client)
    assert response.status_code == 200
    assert response.json()["provider"] == "deepseek vision"


def test_llm_empty_text_gives_no_text_warning(client, fake_vision):
    _calls, queue = fake_vision
    queue.append(_FakeResponse(""))
    body = _post_image(client).json()
    assert body["text"] == ""
    assert body["lines"] == []
    assert "no_text_found" in body["warnings"]


def test_llm_numbering_and_blank_lines_are_cleaned():
    text = "1. Hello!\n\n2) I like drawing.\n- Can you see three birds?"
    assert lines_from_llm_text(text) == ["Hello!", "I like drawing.", "Can you see three birds?"]
    assert lines_from_llm_text(None) == []


# --------------------------------------------------------------------------------------
# 降级链
# --------------------------------------------------------------------------------------
def test_llm_failure_falls_back_to_local(client, fake_vision, fake_local):
    _calls, queue = fake_vision
    queue.append(RuntimeError("connect timeout"))
    body = _post_image(client).json()
    assert body["provider"] == "rapidocr"
    assert "llm_vision_failed" in body["warnings"]
    assert [line["text"] for line in body["lines"]] == ["Local line one.", "Local line two."]
    assert all(isinstance(line["confidence"], float) for line in body["lines"])


def test_llm_failure_without_local_returns_503(client, fake_vision, monkeypatch):
    monkeypatch.setattr(ocr_module, "engine_available", lambda: False)
    _calls, queue = fake_vision
    queue.append(RuntimeError("HTTP 500"))
    response = _post_image(client)
    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == "provider_unavailable"
    assert "LLM" in body["error"]["message"]


def test_provider_mode_local_never_calls_llm(client, fake_vision, fake_local, monkeypatch):
    monkeypatch.setenv("VOICE_OCR_PROVIDER", "local")
    reset_settings_cache()
    calls, _queue = fake_vision

    def forbidden(*args, **kwargs):
        raise AssertionError("VOICE_OCR_PROVIDER=local 时不应该调用 LLM")

    import app.llm as llm_module

    monkeypatch.setattr(llm_module.httpx, "post", forbidden)
    body = _post_image(client).json()
    assert body["provider"] == "rapidocr"
    assert calls == []  # fake_vision 的 post 未被调用（被 forbidden 覆盖前也没有调用）


def test_provider_mode_llm_prefers_llm(client, fake_vision, fake_local, monkeypatch):
    monkeypatch.setenv("VOICE_OCR_PROVIDER", "llm")
    reset_settings_cache()
    assert ocr_chain(reset_and_get_settings()) == ["llm", "local"]
    body = _post_image(client).json()
    assert body["provider"] == "deepseek vision"


# --------------------------------------------------------------------------------------
# health 能力标记
# --------------------------------------------------------------------------------------
def test_health_reports_llm_ocr_provider(client, fake_vision):
    body = client.get("/v1/health").json()
    capabilities = body["capabilities"]
    assert capabilities["ocr"] is True
    assert capabilities["ocr_provider"] == "llm"


def test_health_reports_no_ocr_when_nothing_available(client, monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.setattr(ocr_module, "engine_available", lambda: False)
    reset_settings_cache()
    reset_providers()
    capabilities = client.get("/v1/health").json()["capabilities"]
    assert capabilities["ocr"] is False
    assert capabilities["ocr_provider"] is None


# --------------------------------------------------------------------------------------
# 没有本地依赖时的启动惰性（子进程，环境隔离）
# --------------------------------------------------------------------------------------
def test_startup_lazy_without_local_ocr_deps(tmp_path):
    """屏蔽本地 OCR 依赖时：启动不 import 它们、health.ocr 仍为 true（LLM 可用）、ocr_provider=llm。"""
    code = """
import importlib.util, sys

class _Blocker:
    BLOCKED = {"rapidocr_onnxruntime", "cv2", "onnxruntime"}
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in self.BLOCKED:
            raise ModuleNotFoundError(name)
        return None

sys.meta_path.insert(0, _Blocker())
from fastapi.testclient import TestClient
from app.main import app
from app.ocr import engine_available
with TestClient(app) as client:
    caps = client.get('/v1/health').json()['capabilities']
assert engine_available() is False, caps
assert caps['ocr'] is True, caps
assert caps['ocr_provider'] == 'llm', caps
for name in ('rapidocr_onnxruntime', 'cv2', 'onnxruntime'):
    assert name not in sys.modules, (name, [k for k in sys.modules if k.startswith(name)])
print('LAZY_NO_LOCAL_OCR_OK')
"""
    env = {
        **os.environ,
        "PROVIDER_MODE": "mock",
        "ENV_FILE": str(tmp_path / "none.env"),
        "DATA_DIR": str(tmp_path),
        "MODEL_CACHE_DIR": str(tmp_path / "models"),
        "LLM_BASE_URL": "https://api.deepseek.com/v1",
        "LLM_API_KEY": "test-key",
        "LLM_MODEL": "deepseek-flash",
    }
    env.pop("VOICE_OCR_PROVIDER", None)
    result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stderr
    assert "LAZY_NO_LOCAL_OCR_OK" in result.stdout


def reset_and_get_settings():
    from app.config import get_settings

    reset_settings_cache()
    return get_settings()
