"""task-27：OCR 改为 DeepSeek 多模态为主（LLM 视觉），本地 rapidocr 仅兜底。

全部用**假 LLM**（monkeypatch `app.llm.httpx.post`），不真调外部 API、不联网。
"""

from __future__ import annotations

import base64
import io
import logging
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
    assert request["max_tokens"] == 1500
    assert request["thinking"] == {"type": "disabled"}  # task-36：默认关推理
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
    """首次空 + 重试仍空 → text="" 且两个 warning 都出现（task-35）。"""
    _calls, queue = fake_vision
    queue.extend([_FakeResponse(""), _FakeResponse("")])
    body = _post_image(client).json()
    assert body["text"] == ""
    assert body["lines"] == []
    assert "no_text_found" in body["warnings"]
    assert "llm_empty_retried" in body["warnings"]


def test_llm_numbering_and_blank_lines_are_cleaned():
    text = "1. Hello!\n\n2) I like drawing.\n- Can you see three birds?"
    assert lines_from_llm_text(text) == ["Hello!", "I like drawing.", "Can you see three birds?"]
    assert lines_from_llm_text(None) == []


# --------------------------------------------------------------------------------------
# task-28：可选返回"实际送去识别的那张 JPEG"
# --------------------------------------------------------------------------------------
def test_llm_return_image_is_the_sent_jpeg(client, fake_vision):
    calls, _queue = fake_vision
    response = client.post(
        "/v1/ocr",
        files={"image": ("page.jpg", FIXTURE.read_bytes(), "image/jpeg")},
        data={"return_image": "1"},
    )
    assert response.status_code == 200
    body = response.json()
    assert "image_jpeg_b64" in body

    sent_url = calls[0]["body"]["messages"][0]["content"][1]["image_url"]["url"]
    sent_b64 = sent_url.split(",", 1)[1]
    assert body["image_jpeg_b64"] == sent_b64, "返回的必须是实际发给视觉模型的那张图（同一 base64）"

    from PIL import Image

    decoded = Image.open(io.BytesIO(base64.b64decode(body["image_jpeg_b64"])))
    assert decoded.format == "JPEG"
    assert decoded.size == (body["width"], body["height"])


def test_llm_no_return_image_absent(client, fake_vision):
    body = _post_image(client).json()
    assert "image_jpeg_b64" not in body


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


# --------------------------------------------------------------------------------------
# task-35：空结果 → 宽容提示词重试一次 + 诊断日志
# --------------------------------------------------------------------------------------
from app.llm import VisionOutcome  # noqa: E402
from app.ocr import OCR_PROMPT_RETRY  # noqa: E402


def _patch_read_image(monkeypatch, returns: list[str]):
    """把 LLMClient.read_image 换成按顺序返回给定的原始文本；返回捕获到的 prompts 列表。"""
    calls: list[dict] = []

    def fake_read_image(self, image_data_url, prompt, timeout_s=None, max_tokens=1500,
                        temperature=0.0, disable_thinking=False):
        calls.append({"prompt": prompt, "provider": self.provider_name,
                      "max_tokens": max_tokens, "disable_thinking": disable_thinking})
        item = returns.pop(0) if returns else ""
        if isinstance(item, VisionOutcome):
            return item
        return VisionOutcome(provider=self.provider_name, text=item)

    monkeypatch.setattr("app.llm.LLMClient.read_image", fake_read_image)
    return calls


def _llm_env(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "deepseek-flash")
    monkeypatch.delenv("VOICE_OCR_PROVIDER", raising=False)
    reset_settings_cache()
    reset_providers()


def test_empty_then_retry_succeeds(client, monkeypatch):
    """① 首次空、重试成功 → 非空结果、provider 正确、不含 no_text_found、调用 2 次。"""
    _llm_env(monkeypatch)
    calls = _patch_read_image(monkeypatch, ["", "Hello! My name is Lily.\nI like drawing cats and dogs."])
    body = _post_image(client).json()
    assert body["provider"] == "deepseek vision"
    assert body["text"] == "Hello! My name is Lily.\nI like drawing cats and dogs."
    assert [line["text"] for line in body["lines"]] == body["text"].split("\n")
    assert "no_text_found" not in body["warnings"]
    assert "llm_empty_retried" not in body["warnings"]
    assert len(calls) == 2, f"首次空必须重试一次，实际调用 {len(calls)} 次"


def test_both_attempts_empty(client, monkeypatch):
    """② 两次都空 → text="" + warnings 同时含 no_text_found 与 llm_empty_retried。"""
    _llm_env(monkeypatch)
    calls = _patch_read_image(monkeypatch, ["", "   \n\n  "])
    body = _post_image(client).json()
    assert body["text"] == ""
    assert body["lines"] == []
    assert "no_text_found" in body["warnings"]
    assert "llm_empty_retried" in body["warnings"]
    assert len(calls) == 2


def test_first_success_does_not_retry(client, monkeypatch):
    """③ 首次就成功 → 只调用 1 次（不浪费一次 API 调用）。"""
    _llm_env(monkeypatch)
    calls = _patch_read_image(monkeypatch, ["Hello! My name is Lily."])
    body = _post_image(client).json()
    assert body["text"] == "Hello! My name is Lily."
    assert len(calls) == 1


def test_retry_uses_different_lenient_prompt(client, monkeypatch):
    """④ 重试请求用的是 OCR_PROMPT_RETRY（与首次不同）。"""
    _llm_env(monkeypatch)
    calls = _patch_read_image(monkeypatch, ["", "Can you see three birds in the tree?"])
    _post_image(client)
    assert len(calls) == 2
    assert calls[0]["prompt"] == OCR_PROMPT
    assert calls[1]["prompt"] == OCR_PROMPT_RETRY
    assert calls[0]["prompt"] != calls[1]["prompt"]
    assert "完全没有任何英文字母" in OCR_PROMPT_RETRY
    assert "标题" in OCR_PROMPT_RETRY and "装饰字" in OCR_PROMPT_RETRY


def test_empty_result_logs_warning_with_raw_prefix(client, monkeypatch, caplog):
    """⑤ 空结果产生 WARNING 日志，且包含模型原始返回片段（repr），不含 base64。

    （日志用 repr 打出前 200 字符，可以区分：真空串 `''` / 只有换行空白 `'\\n\\n  '` / 拒答话术。）
    """
    _llm_env(monkeypatch)
    _patch_read_image(monkeypatch, ["", "\n\n  "])
    with caplog.at_level(logging.WARNING, logger="voice.ocr"):
        body = _post_image(client).json()
    assert body["text"] == ""
    records = [r for r in caplog.records if r.name == "voice.ocr" and r.levelno >= logging.WARNING]
    messages = [record.getMessage() for record in records]
    assert len(messages) >= 2, messages
    assert any("empty text" in message for message in messages), messages
    assert any("still empty after lenient retry" in message for message in messages), messages
    joined = "\n".join(messages)
    assert "raw_prefix=" in joined and "raw_len=" in joined, "必须打印原始返回长度与前 200 字符"
    assert repr("\n\n  ") in joined, f"必须能看出原始返回是换行空白: {joined!r}"
    assert "base64" not in joined.lower(), "日志不能包含 base64"


# --------------------------------------------------------------------------------------
# 模型占位符返回（实测空白页会返回字面量 `` `<empty string>` ``）也必须按"空"处理
# --------------------------------------------------------------------------------------
def test_placeholder_text_is_treated_as_empty(client, monkeypatch):
    _llm_env(monkeypatch)
    calls = _patch_read_image(monkeypatch, ["`<empty string>`", "<empty>"])
    body = _post_image(client).json()
    assert body["text"] == "", body["text"]
    assert body["lines"] == []
    assert "no_text_found" in body["warnings"]
    assert "llm_empty_retried" in body["warnings"]
    assert len(calls) == 2, "占位符也应触发重试"


def test_chinese_explanation_is_not_ocr_text(client, monkeypatch):
    """模型用中文解释"没识别到文字"时，不能当成 OCR 原文（实测空白页会这样返回）。"""
    _llm_env(monkeypatch)
    explanation = "（注：由于原图几乎为空白，未识别到任何清晰的英文文本，因此返回空内容。）"
    calls = _patch_read_image(monkeypatch, ["`<empty string>`", explanation])
    body = _post_image(client).json()
    assert body["text"] == "", body["text"]
    assert body["lines"] == []
    assert "no_text_found" in body["warnings"]
    assert "llm_empty_retried" in body["warnings"]
    assert len(calls) == 2


def test_normalize_placeholder_variants():
    from app.ocr import _normalize_llm_text

    for value in ("`<empty string>`", "<empty string>", "<empty>", "(empty)", "[empty]", "N/A", "none", "  ""  "):
        assert _normalize_llm_text(value) == "", value
    for value in ("Hello!", "The cat is sleeping.", "Chapter 1", "N/A is not a placeholder in sentence"):
        assert _normalize_llm_text(value) == value.strip(), value


def test_lines_require_latin_letters():
    from app.ocr import lines_from_llm_text

    text = "Hello!\n中文解释：这张图没有文字。\n12345\n\nI like cats."
    assert lines_from_llm_text(text) == ["Hello!", "I like cats."]


# --------------------------------------------------------------------------------------
# task-36：推理模型吃光 max_tokens（截断）→ 检测 + 重试 + 关思考
# --------------------------------------------------------------------------------------
FROGGY_TEXT = "CAMP RUN-A-MUCK\nBy the time they got to the camp, Froggy didn't wanna go home."


def test_truncated_then_retry_with_bigger_max_tokens(client, monkeypatch):
    """① finish_reason=length（content 被截断）→ 自动重试（max_tokens×3 上限 4000、关思考）→ 成功。"""
    _llm_env(monkeypatch)
    truncated = VisionOutcome(
        provider="deepseek", text="By the time they got", finish_reason="length",
        completion_tokens=1500, reasoning_tokens=794, reasoning_len=1200, thinking_disabled=True,
    )
    full = VisionOutcome(
        provider="deepseek", text=FROGGY_TEXT, finish_reason="stop",
        completion_tokens=879, reasoning_tokens=None, thinking_disabled=True,
    )
    calls = _patch_read_image(monkeypatch, [truncated, full])
    body = _post_image(client).json()
    assert len(calls) == 2, f"截断必须重试一次，实际 {len(calls)} 次"
    assert calls[0]["max_tokens"] == 1500
    assert calls[1]["max_tokens"] == 4000, "重试 max_tokens 应 ×3 并封顶 4000"
    assert calls[1]["disable_thinking"] is True
    lowered = body["text"].lower()
    assert "camp run-a-muck" in lowered and "wanna go home" in lowered
    assert "llm_truncated" not in body["warnings"]
    assert body["provider"] == "deepseek vision"


def test_still_truncated_warns_and_returns_partial(client, monkeypatch):
    """② 两次都 length → warnings 含 llm_truncated，返回已拿到的部分内容。"""
    _llm_env(monkeypatch)
    partial_one = VisionOutcome(provider="deepseek", text="By the time", finish_reason="length", completion_tokens=1500)
    partial_two = VisionOutcome(provider="deepseek", text="By the time they got to the camp", finish_reason="length", completion_tokens=4000)
    calls = _patch_read_image(monkeypatch, [partial_one, partial_two])
    body = _post_image(client).json()
    assert len(calls) == 2
    assert "llm_truncated" in body["warnings"]
    assert body["text"] == "By the time they got to the camp"


def test_truncation_warning_logs_diagnostics(client, monkeypatch, caplog):
    """截断时 WARNING 必须带 completion/reasoning/content_len，便于排查。"""
    _llm_env(monkeypatch)
    truncated = VisionOutcome(
        provider="deepseek", text="By the", finish_reason="length",
        completion_tokens=1500, reasoning_tokens=1497, reasoning_len=3000, thinking_disabled=True,
    )
    full = VisionOutcome(provider="deepseek", text="Camp Run-A-Muck", finish_reason="stop")
    _patch_read_image(monkeypatch, [truncated, full])
    with caplog.at_level(logging.WARNING, logger="voice.ocr"):
        _post_image(client)
    messages = [r.getMessage() for r in caplog.records if r.name == "voice.ocr" and r.levelno >= logging.WARNING]
    truncated_logs = [m for m in messages if "finish_reason=length" in m]
    assert truncated_logs, messages
    joined = "\n".join(truncated_logs)
    assert "completion_tokens=1500" in joined
    assert "reasoning_tokens=1497" in joined
    assert "content_len=6" in joined


def test_thinking_disabled_rejected_400_degrades_without_500(monkeypatch):
    """③ 端点不认 thinking 参数（400）→ 自动降级为不带参数重试，不抛 500。"""
    from app.config import get_settings
    from app.llm import LLMClient

    monkeypatch.setenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "deepseek-flash")
    reset_settings_cache()
    settings = get_settings()

    posted: list[dict] = []

    class Response:
        def __init__(self, status: int, payload: dict):
            self.status_code = status
            self._payload = payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")

        def json(self):
            return self._payload

    def fake_post(url, headers=None, json=None, timeout=None):  # noqa: A002
        posted.append(json)
        if "thinking" in json:
            return Response(400, {"error": {"message": "unknown parameter: thinking"}})
        return Response(200, {"choices": [{"message": {"content": FROGGY_TEXT}, "finish_reason": "stop"}],
                              "usage": {"completion_tokens": 900}})

    monkeypatch.setattr("app.llm.httpx.post", fake_post)
    outcome = LLMClient(settings).read_image("data:image/jpeg;base64,xxxx", "read it", disable_thinking=True)
    assert outcome.ok, outcome.error
    assert outcome.text == FROGGY_TEXT
    assert outcome.thinking_disabled is False, "400 降级后应记录为未关思考"
    assert len(posted) == 2
    assert posted[0].get("thinking") == {"type": "disabled"}
    assert "thinking" not in posted[1]
    assert posted[1]["max_tokens"] == posted[0]["max_tokens"]


def test_ocr_disable_thinking_env_can_turn_off(client, fake_vision, monkeypatch):
    """④ OCR_DISABLE_THINKING=0 时不发 thinking 参数（回退到靠大 max_tokens 兜）。"""
    monkeypatch.setenv("OCR_DISABLE_THINKING", "0")
    reset_settings_cache()
    calls, _queue = fake_vision
    _post_image(client)
    request = calls[0]["body"]
    assert "thinking" not in request
    assert request["max_tokens"] == 1500
