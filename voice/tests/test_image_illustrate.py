"""task-52：/v1/image/illustrate（智谱 GLM-Image 文生图）。

全部用假 HTTP 客户端 / mock provider，不联网、不调真实智谱 API。
"""

from __future__ import annotations

import base64
import io
from types import SimpleNamespace

import numpy as np
from PIL import Image
import pytest

from app.config import get_settings, reset_settings_cache
from app.image_gen import image_available, parse_size, sanitize_names
from app.llm import LLMOutcome
from app.providers.registry import reset_providers

STORY = "Today I built a tall block tower with Ming. Hua knocked it down. I was very angry."
PNG_1280 = None


def _png(width: int = 1280, height: int = 1280) -> bytes:
    image = Image.new("RGB", (width, height), (120, 140, 200))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _body(**overrides):
    body = {"story_text": STORY, "title_en": "My Block Tower", "style": "watercolor"}
    body.update(overrides)
    return body


def _with_env(monkeypatch, **env):
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    reset_settings_cache()
    reset_providers()


def _fake_llm(monkeypatch, scene: str = "A child and a friend build a tall block tower in a sunny park"):
    calls = []

    def fake_chat_json(self, system_prompt, user_prompt, timeout_s=None, max_tokens=900,
                       temperature=0.3, disable_thinking=False):
        calls.append({"system": system_prompt, "user": user_prompt, "disable_thinking": disable_thinking})
        return LLMOutcome(provider="deepseek", data={"scene": scene}, finish_reason="stop", thinking_disabled=True)

    monkeypatch.setattr("app.llm.LLMClient.chat_json", fake_chat_json)
    return calls


def _fake_zhipu(monkeypatch, *, image_bytes: bytes | None = None, status: int = 200,
                body_override: dict | None = None, download_bytes: bytes | None = None,
                download_status: int = 200):
    png = image_bytes if image_bytes is not None else _png()
    calls = {"post": 0, "get": 0, "payloads": []}

    class FakeResponse:
        def __init__(self, status_code: int, payload: dict | None = None, content: bytes = b""):
            self.status_code = status_code
            self._payload = payload or {}
            self.content = content
            self.text = str(payload)[:200] if payload else ""

        def json(self):
            return self._payload

    def fake_post(url, headers=None, json=None, timeout=None, **kwargs):  # noqa: A002
        calls["post"] += 1
        calls["payloads"].append({"url": url, "headers": headers, "json": json})
        if body_override is not None:
            return FakeResponse(status, body_override)
        return FakeResponse(200, {"created": 1, "data": [{"url": "https://fake.zhipu/img-1.png"}]})

    def fake_get(url, timeout=None, follow_redirects=False, **kwargs):
        calls["get"] += 1
        return FakeResponse(download_status, {}, download_bytes if download_bytes is not None else png)

    monkeypatch.setattr("app.image_gen.httpx.post", fake_post)
    monkeypatch.setattr("app.image_gen.httpx.get", fake_get)
    return calls


@pytest.fixture
def zhihu_env(monkeypatch):
    _with_env(
        monkeypatch,
        IMAGE_PROVIDER="zhipu",
        IMAGE_API_KEY="fake-key",
        IMAGE_BASE_URL="https://fake.zhipu/api/paas/v4",
        IMAGE_MODEL="glm-image",
        IMAGE_SIZE="1280x1280",
        IMAGE_WATERMARK="1",
        LLM_BASE_URL="https://api.deepseek.com/v1",
        LLM_API_KEY="test-key",
        LLM_MODEL="deepseek-flash",
    )
    yield
    reset_settings_cache()


# --------------------------------------------------------------------------------------
# mock provider（本地占位图）
# --------------------------------------------------------------------------------------
def test_mock_provider_returns_decodable_png(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_PROVIDER="mock", IMAGE_SIZE="1280x1280")
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "mock"
    assert body["mime"] == "image/png"
    assert body["model"] == "glm-image"
    assert body["size"] == "1280x1280"
    assert body["width"] == 1280 and body["height"] == 1280
    assert body["cached"] is False
    raw = base64.b64decode(body["image_b64"])
    image = Image.open(io.BytesIO(raw))
    assert image.format == "PNG"
    assert image.size == (1280, 1280)
    assert len(raw) > 1000, "占位图不应是空图"


def test_mock_provider_cache_and_force(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_PROVIDER="mock")
    first = client.post("/v1/image/illustrate", json=_body()).json()
    second = client.post("/v1/image/illustrate", json=_body()).json()
    assert first["cached"] is False
    assert second["cached"] is True, "相同参数第二次应命中缓存"
    assert first["image_b64"] == second["image_b64"]

    forced = client.post("/v1/image/illustrate?force=1", json=_body()).json()
    assert forced["cached"] is False, "force=1 必须重新生成"


# --------------------------------------------------------------------------------------
# 智谱路径（假 HTTP 客户端）
# --------------------------------------------------------------------------------------
def test_zhipu_request_shape_and_safety_prompt(client, monkeypatch, zhihu_env):
    calls = _fake_zhipu(monkeypatch)
    llm_calls = _fake_llm(monkeypatch)
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "zhipu"
    assert body["cached"] is False
    assert len(llm_calls) == 1, "应先调 LLM 生成绘画提示词"
    assert llm_calls[0]["disable_thinking"] is True

    assert calls["post"] == 1, "应调用一次智谱生成接口"
    payload = calls["payloads"][0]
    assert payload["url"].endswith("/images/generations")
    assert payload["headers"]["Authorization"] == "Bearer fake-key"
    request = payload["json"]
    assert request["model"] == "glm-image"
    assert request["size"] == "1280x1280"
    assert request["quality"] == "hd"
    assert request["watermark_enabled"] is True

    prompt = body["prompt_used"]
    assert prompt.startswith("children's picture book illustration")
    for fragment in ("no realistic human faces", "no text in image", "safe for young children"):
        assert fragment in prompt, prompt
    assert len(prompt) <= 1000
    # 服务端安全提示词模板不允许调用方覆盖
    assert body["prompt_used"] == request["prompt"]


def test_zhipu_replaces_real_names(client, monkeypatch, zhihu_env):
    _fake_zhipu(monkeypatch)
    _fake_llm(monkeypatch, scene="Ming and Hua build a tall block tower while their teacher watches")
    body = client.post("/v1/image/illustrate", json=_body()).json()
    prompt = body["prompt_used"]
    assert "Ming" not in prompt and "Hua" not in prompt, prompt
    assert "a child" in prompt
    assert "teacher" in prompt, "普通英文词不应被误替换"


def test_zhipu_cache_hit_and_force(client, monkeypatch, zhihu_env):
    calls = _fake_zhipu(monkeypatch)
    _fake_llm(monkeypatch)
    first = client.post("/v1/image/illustrate", json=_body()).json()
    second = client.post("/v1/image/illustrate", json=_body()).json()
    assert first["cached"] is False
    assert second["cached"] is True
    assert calls["post"] == 1, "缓存命中时不得再调智谱（避免重复花钱）"

    forced = client.post("/v1/image/illustrate?force=1", json=_body()).json()
    assert forced["cached"] is False
    assert calls["post"] == 2, "force=1 应重新调用"


def test_zhipu_content_filter_returns_400_content_unsafe(client, monkeypatch, zhihu_env):
    _fake_zhipu(monkeypatch, body_override={"created": 1, "data": [], "content_filter": {"code": 1301}})
    _fake_llm(monkeypatch)
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "content_unsafe"
    assert "换个说法" in body["error"]["message"]


def test_zhipu_429_retries_three_times_then_502(client, monkeypatch, zhihu_env):
    calls = _fake_zhipu(monkeypatch, status=429, body_override={"error": "rate limited"})
    _fake_llm(monkeypatch)
    monkeypatch.setattr("app.image_gen.time.sleep", lambda *_: None)
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "provider_error"
    assert calls["post"] == 4, "初次 + 重试 3 次"


def test_zhipu_5xx_retries_then_502(client, monkeypatch, zhihu_env):
    calls = _fake_zhipu(monkeypatch, status=503, body_override={"error": "unavailable"})
    _fake_llm(monkeypatch)
    monkeypatch.setattr("app.image_gen.time.sleep", lambda *_: None)
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 502
    assert calls["post"] == 4


def test_zhipu_download_html_returns_502(client, monkeypatch, zhihu_env):
    _fake_zhipu(monkeypatch, download_bytes=b"<html>gateway error</html>")
    _fake_llm(monkeypatch)
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "provider_error"


def test_zhipu_download_wrong_size_returns_502(client, monkeypatch, zhihu_env):
    _fake_zhipu(monkeypatch, image_bytes=_png(1024, 1024))
    _fake_llm(monkeypatch)
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 502
    assert "尺寸不符" in response.json()["error"]["message"]


def test_zhipu_without_key_returns_503(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_PROVIDER="zhipu", IMAGE_API_KEY=None)
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


def test_image_provider_none_returns_503(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_PROVIDER="none")
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 503


# --------------------------------------------------------------------------------------
# 尺寸 / 请求校验 / 工具函数
# --------------------------------------------------------------------------------------
def test_invalid_image_size_returns_400(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_PROVIDER="mock", IMAGE_SIZE="1000x1000")  # 非 32 倍数
    response = client.post("/v1/image/illustrate", json=_body())
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"


def test_parse_size_accepts_recommended_and_custom():
    assert parse_size("1280x1280") == (1280, 1280)
    assert parse_size("1568x1056") == (1568, 1056)
    assert parse_size("2048x1024") == (2048, 1024)
    with pytest.raises(Exception):
        parse_size("512x512")
    with pytest.raises(Exception):
        parse_size("1280x1280x2")


def test_story_text_validation(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_PROVIDER="mock")
    assert client.post("/v1/image/illustrate", json=_body(story_text="")).status_code == 400
    assert client.post("/v1/image/illustrate", json=_body(story_text="x" * 2001)).status_code == 400


def test_sanitize_names_keeps_common_words():
    assert sanitize_names("Today Ming and Hua play with a teacher") == "Today a child and a friend play with a teacher"
    assert sanitize_names("A child plays in the park") == "A child plays in the park"


# --------------------------------------------------------------------------------------
# capabilities
# --------------------------------------------------------------------------------------
def test_health_image_capabilities(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_PROVIDER="mock")
    caps = client.get("/v1/health").json()["capabilities"]
    assert caps["image"] is True
    assert caps["image_provider"] == "mock"

    _with_env(monkeypatch, IMAGE_PROVIDER="zhipu", IMAGE_API_KEY=None)
    caps = client.get("/v1/health").json()["capabilities"]
    assert caps["image"] is False
    assert caps["image_provider"] is None

    _with_env(monkeypatch, IMAGE_PROVIDER="none")
    caps = client.get("/v1/health").json()["capabilities"]
    assert caps["image"] is False
