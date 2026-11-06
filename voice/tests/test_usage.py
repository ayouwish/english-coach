"""task-100：各端点返回原始 usage 用量（LLM tokens / 图片 / TTS 字符 / ASR 秒），由 web 记账。

不写死单价；provider 不返回 usage → usage:null（不编造）。
"""

from __future__ import annotations

import io
import json

import numpy as np
import pytest
from PIL import Image

from app.audio_io import pcm16_wav_bytes
from app.config import get_settings, reset_settings_cache
from app.llm import LLMOutcome, VisionOutcome
from app.providers.registry import reset_providers


def _with_env(monkeypatch, **env):
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    reset_settings_cache()
    reset_providers()


def _llm_env(monkeypatch):
    _with_env(
        monkeypatch,
        LLM_BASE_URL="https://api.deepseek.com/v1",
        LLM_API_KEY="test-key",
        LLM_MODEL="deepseek-chat",
        IMAGE_PROVIDER="mock",
        IMAGE_SIZE="1280x1280",
    )


class _FakeResponse:
    def __init__(self, content: str, usage: dict | None = None):
        self._content = content
        self._usage = usage

    def raise_for_status(self):
        return None

    def json(self):
        body = {"choices": [{"message": {"content": self._content}, "finish_reason": "stop"}]}
        if self._usage is not None:
            body["usage"] = self._usage
        return body


def _patch_http(monkeypatch, responses):
    queue = list(responses)

    def fake_post(url, headers=None, json=None, timeout=None):  # noqa: A002
        item = queue.pop(0) if queue else _FakeResponse("{}")
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr("app.llm.httpx.post", fake_post)


VALID_DIALOGUE = {
    "reply": "Sure, one coffee. Would you like it hot or iced?",
    "reply_zh": "好的，一杯咖啡。你要热的还是冰的？",
    "correction": {"has_error": False, "type": "none", "original": None, "better": None,
                   "explain_zh": None, "severity": None},
    "suggested_replies": ["Hot, please.", "Iced, please."],
    "target_words": ["coffee", "hot"],
    "flag": "ok",
    "done": False,
}

DIALOGUE_PAYLOAD = {
    "scenario": {"id": "coffee", "title": "Ordering coffee", "title_zh": "点咖啡",
                 "setting_zh": "店员", "role_prompt": "You are a barista.",
                 "opening_line": "Hi! What can I get you?", "level": "A2", "min_age": 6},
    "learner": {"age_band": "adult", "level": "B1", "native_language": "zh", "child_safe": False},
    "history": [],
    "correction_level": "gentle",
    "turn_index": 1,
}


def _wav(seconds: float = 1.0) -> bytes:
    t = np.arange(int(16000 * seconds)) / 16000
    return pcm16_wav_bytes((0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 16000)


def _jpeg(size=(320, 320)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, (200, 210, 230)).save(buffer, format="JPEG")
    return buffer.getvalue()


# --------------------------------------------------------------------------------------
# LLM 端点：dialogue / story rewrite / retell / ocr
# --------------------------------------------------------------------------------------
def test_dialogue_usage_passthrough(client, monkeypatch):
    _llm_env(monkeypatch)
    _patch_http(monkeypatch, [_FakeResponse(json.dumps(VALID_DIALOGUE),
                                            usage={"prompt_tokens": 111, "completion_tokens": 22, "total_tokens": 133})])
    body = client.post("/v1/dialogue", json=DIALOGUE_PAYLOAD).json()
    assert body["usage"] == {
        "llm_prompt_tokens": 111,
        "llm_completion_tokens": 22,
        "llm_total_tokens": 133,
    }


def test_dialogue_usage_sums_retries(client, monkeypatch):
    _llm_env(monkeypatch)
    _patch_http(monkeypatch, [
        _FakeResponse("not json", usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}),
        _FakeResponse(json.dumps(VALID_DIALOGUE),
                      usage={"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28}),
    ])
    body = client.post("/v1/dialogue", json=DIALOGUE_PAYLOAD).json()
    assert body["usage"] == {
        "llm_prompt_tokens": 30,
        "llm_completion_tokens": 13,
        "llm_total_tokens": 43,
    }, "重试的成本也要计入"


def test_dialogue_usage_null_when_provider_omits_it(client, monkeypatch):
    _llm_env(monkeypatch)
    _patch_http(monkeypatch, [_FakeResponse(json.dumps(VALID_DIALOGUE))])  # 无 usage
    body = client.post("/v1/dialogue", json=DIALOGUE_PAYLOAD).json()
    assert body["usage"] is None, "provider 没给 usage 时必须 null，不能编造"


STORY = {
    "title_en": "My Tower",
    "sentences": ["Today I built a tall tower.", "My friend knocked it down.", "I was sad."],
}


def test_story_rewrite_usage_passthrough(client, monkeypatch):
    _llm_env(monkeypatch)

    def fake_chat_json(self, system, user, **kwargs):
        return LLMOutcome(provider="deepseek", data=STORY, prompt_tokens=400, completion_tokens=60,
                          total_tokens=460, finish_reason="stop")

    monkeypatch.setattr("app.llm.LLMClient.chat_json", fake_chat_json)
    body = client.post("/v1/story/rewrite", json={
        "text_zh": "今天我搭了一座高塔，朋友把它弄倒了，我很伤心", "level": "B1", "max_sentences": 6,
    }).json()
    assert body["usage"] == {"llm_prompt_tokens": 400, "llm_completion_tokens": 60, "llm_total_tokens": 460}


def test_story_retell_usage_passthrough(client, monkeypatch):
    _llm_env(monkeypatch)

    def fake_chat_json(self, system, user, **kwargs):
        return LLMOutcome(provider="deepseek", data={
            "coverage": 0.5,
            "covered_points": ["搭积木"],
            "missing_points": [],
            "feedback_zh": "你说了搭积木，很棒！",
            "feedback_en": "Great, you said building blocks!",
        }, prompt_tokens=300, completion_tokens=40, total_tokens=340, finish_reason="stop")

    monkeypatch.setattr("app.llm.LLMClient.chat_json", fake_chat_json)
    body = client.post("/v1/story/retell", json={
        "story_sentences": ["Today I built a tower with Ming."],
        "transcript": "我搭积木",
        "level": "A2",
    }).json()
    assert body["usage"] == {"llm_prompt_tokens": 300, "llm_completion_tokens": 40, "llm_total_tokens": 340}


def test_ocr_usage_passthrough(client, monkeypatch):
    _llm_env(monkeypatch)
    _with_env(monkeypatch, VOICE_OCR_PROVIDER="llm", LLM_BASE_URL="https://api.deepseek.com/v1",
              LLM_API_KEY="test-key", LLM_MODEL="deepseek-chat")

    def fake_call_llm(*args, **kwargs):
        return VisionOutcome(provider="deepseek", text="HELLO WORLD\n", finish_reason="stop",
                             prompt_tokens=1200, completion_tokens=30, total_tokens=1230)

    monkeypatch.setattr("app.ocr._call_llm", fake_call_llm)
    response = client.post("/v1/ocr", files={"image": ("a.jpg", _jpeg(), "image/jpeg")})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["usage"] == {"llm_prompt_tokens": 1200, "llm_completion_tokens": 30, "llm_total_tokens": 1230}


def test_ocr_usage_null_for_local_provider():
    from app.ocr import OcrResult

    payload = OcrResult(provider="local", text="hi").to_contract()
    assert payload["usage"] is None


# --------------------------------------------------------------------------------------
# 图像 / TTS / ASR
# --------------------------------------------------------------------------------------
def test_illustrate_usage_images(client, monkeypatch):
    _llm_env(monkeypatch)

    def fake_chat_json(self, system, user, **kwargs):
        return LLMOutcome(provider="deepseek", data={"scene": "a child builds a tower"}, finish_reason="stop")

    monkeypatch.setattr("app.llm.LLMClient.chat_json", fake_chat_json)
    body = client.post("/v1/image/illustrate", json={"story_text": "A child builds a tower."}).json()
    assert body["usage"] == {"images": 1, "size": "1280x1280", "model": get_settings().image_model}


def test_avatar_usage_images(client, monkeypatch):
    _llm_env(monkeypatch)
    _with_env(monkeypatch, IMAGE_AVATAR_PHOTO="1", IMAGE_PROVIDER="mock")

    def fake_read_image(self, data_url, prompt, **kwargs):
        return VisionOutcome(provider="deepseek", text=json.dumps({"character_desc": "a child with black hair"}),
                             finish_reason="stop", prompt_tokens=900, completion_tokens=50, total_tokens=950)

    monkeypatch.setattr("app.llm.LLMClient.read_image", fake_read_image)
    response = client.post("/v1/image/avatar", files={"photo": ("me.jpg", _jpeg(), "image/jpeg")},
                           data={"style": "watercolor"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["usage"] == {"images": 1, "size": "1280x1280", "model": get_settings().image_model}


def test_tts_usage_header(client):
    response = client.post("/v1/tts", json={"text": "hello world", "format": "wav", "rate": "normal"})
    assert response.status_code == 200
    assert response.headers["x-usage-tts-chars"] == str(len("hello world"))
    # 缓存命中也要带同样的用量头
    again = client.post("/v1/tts", json={"text": "hello world", "format": "wav", "rate": "normal"})
    assert again.headers["x-usage-tts-chars"] == str(len("hello world"))


def test_asr_usage_seconds(client):
    response = client.post("/v1/asr", files={"audio": ("a.wav", _wav(1.0), "audio/wav")},
                           data={"language": "en"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["usage"] == {"asr_seconds": 1.0}
