"""task-47：/v1/story/rewrite（中文讲述 -> 分级英文改写）+ ASR 语言规范化。

全部用假 LLM / 假 Azure SDK，不联网。
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from app.audio_io import pcm16_wav_bytes
from app.config import get_settings, reset_settings_cache
from app.llm import LLMOutcome
from app.providers.registry import reset_providers
from app.story import reset_story_cache

GOOD_STORY = {
    "title_en": "My Block Tower",
    "sentences": [
        "Today I built a tall block tower with Ming.",
        "Hua knocked it down.",
        "I was angry.",
    ],
}
GOOD_TEXT = " ".join(GOOD_STORY["sentences"])


def _vocab_file(tmp_path: Path, text: str) -> str:
    """造一个 A1 词表文件，包含给定期望故事的词，保证 unknown_words 稳定。"""
    path = tmp_path / "sentences.json"
    # 把目标文本拆成多句塞进 A1 词表（load_vocab 只抽 A1/A2 句子的词）
    words = text.replace(".", " . ").replace("  ", " ").split()
    path.write_text(
        json.dumps({"sentences": [{"text": " ".join(words), "level": "A1", "focus_phonemes": []}]},
                   ensure_ascii=False),
        encoding="utf-8",
    )
    return str(path)


@pytest.fixture
def llm_env(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "deepseek-flash")
    reset_settings_cache()
    reset_providers()
    reset_story_cache()
    yield
    reset_settings_cache()
    reset_providers()
    reset_story_cache()


def _patch_llm(monkeypatch, responses):
    calls: list[dict] = []

    def fake_chat_json(self, system_prompt, user_prompt, timeout_s=None, max_tokens=900,
                       temperature=0.3, disable_thinking=False):
        calls.append({
            "system": system_prompt, "user": user_prompt, "max_tokens": max_tokens,
            "disable_thinking": disable_thinking, "temperature": temperature,
        })
        item = responses.pop(0) if responses else GOOD_STORY
        if isinstance(item, LLMOutcome):
            return item
        return LLMOutcome(provider="deepseek", data=item, finish_reason="stop", thinking_disabled=True)

    monkeypatch.setattr("app.llm.LLMClient.chat_json", fake_chat_json)
    return calls


def _story_body(**overrides):
    body = {"text_zh": "今天我和小明搭积木塔，被小华碰倒了，我很生气", "level": "A1", "max_sentences": 6}
    body.update(overrides)
    return body


# --------------------------------------------------------------------------------------
# 请求校验
# --------------------------------------------------------------------------------------
def test_story_request_validation(client, llm_env):
    assert client.post("/v1/story/rewrite", json=_story_body(text_zh="")).status_code == 400
    assert client.post("/v1/story/rewrite", json=_story_body(text_zh="中" * 2001)).status_code == 400
    assert client.post("/v1/story/rewrite", json=_story_body(level="C2")).status_code == 400  # C1 合法、C2 非法
    assert client.post("/v1/story/rewrite", json=_story_body(max_sentences=0)).status_code == 400
    assert client.post("/v1/story/rewrite", json=_story_body(max_sentences=7)).status_code == 400


def test_story_requires_llm(client, monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    reset_settings_cache()
    response = client.post("/v1/story/rewrite", json=_story_body())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


# --------------------------------------------------------------------------------------
# 正常路径 / 可读性
# --------------------------------------------------------------------------------------
def test_story_rewrite_normal(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    calls = _patch_llm(monkeypatch, [GOOD_STORY])
    response = client.post("/v1/story/rewrite", json=_story_body())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["title_en"] == "My Block Tower"
    assert body["sentences"] == GOOD_STORY["sentences"]
    assert body["text_en"] == "\n".join(GOOD_STORY["sentences"])
    assert body["level"] == "A1"
    assert body["provider"] == "deepseek"
    readability = body["readability"]
    assert readability["sentence_count"] == 3
    assert readability["max_words"] == max(len(s.split()) for s in GOOD_STORY["sentences"])
    assert readability["ok"] is True
    assert readability["unknown_words"] == []
    assert body["warnings"] == []
    assert len(calls) == 1
    assert calls[0]["disable_thinking"] is True, "必须关闭思考（推理模型会吃掉 token）"
    assert calls[0]["max_tokens"] == 2000


def test_story_rewrite_triggers_one_rewrite(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    long_sentence = "Today I built a very very very tall block tower with my good friend Ming in the park"
    bad = {"title_en": "Too Long", "sentences": [long_sentence]}
    calls = _patch_llm(monkeypatch, [bad, GOOD_STORY])
    response = client.post("/v1/story/rewrite", json=_story_body())
    assert response.status_code == 200
    body = response.json()
    assert len(calls) == 2, "可读性不达标必须触发一次重写"
    assert "sentences too long" in calls[1]["user"].lower() or "rejected" in calls[1]["user"].lower()
    assert body["readability"]["ok"] is True
    assert "too_hard" not in body["warnings"]


def test_story_rewrite_two_failures_marks_too_hard(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    long_sentence = "Today I built a very very very tall block tower with my good friend Ming in the park"
    bad = {"title_en": "Too Long", "sentences": [long_sentence]}
    calls = _patch_llm(monkeypatch, [bad, bad])
    response = client.post("/v1/story/rewrite", json=_story_body())
    assert response.status_code == 200
    body = response.json()
    assert len(calls) == 2
    assert "too_hard" in body["warnings"]
    assert body["readability"]["ok"] is False


def test_story_unknown_words_trigger_rewrite(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    hard = {"title_en": "Hard", "sentences": ["I built a xylophone zeppelin contraption."]}
    calls = _patch_llm(monkeypatch, [hard, GOOD_STORY])
    body = client.post("/v1/story/rewrite", json=_story_body()).json()
    assert len(calls) == 2, "unknown_words > 2 必须重写"
    assert body["readability"]["ok"] is True


# --------------------------------------------------------------------------------------
# LLM 异常路径
# --------------------------------------------------------------------------------------
def test_story_invalid_json_retry_then_502(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    bad = LLMOutcome(provider="deepseek", error="invalid_json")
    calls = _patch_llm(monkeypatch, [bad, bad])
    response = client.post("/v1/story/rewrite", json=_story_body())
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "provider_error"
    assert len(calls) == 2


def test_story_invalid_json_then_success(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    bad = LLMOutcome(provider="deepseek", error="invalid_json")
    calls = _patch_llm(monkeypatch, [bad, GOOD_STORY])
    response = client.post("/v1/story/rewrite", json=_story_body())
    assert response.status_code == 200
    assert len(calls) == 2


def test_story_truncated_retries_with_bigger_max_tokens(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    truncated = LLMOutcome(provider="deepseek", data=None, error="invalid_json",
                           finish_reason="length", completion_tokens=2000, thinking_disabled=True)
    calls = _patch_llm(monkeypatch, [truncated, GOOD_STORY])
    response = client.post("/v1/story/rewrite", json=_story_body())
    assert response.status_code == 200
    assert len(calls) == 2
    assert calls[0]["max_tokens"] == 2000
    assert calls[1]["max_tokens"] == 4000, "截断后必须用更大的 max_tokens 重试"
    assert calls[1]["disable_thinking"] is True


# --------------------------------------------------------------------------------------
# weak_phonemes / avoid_words
# --------------------------------------------------------------------------------------
def test_story_weak_phonemes_in_prompt_and_warning(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    calls = _patch_llm(monkeypatch, [GOOD_STORY])
    body = client.post("/v1/story/rewrite", json=_story_body(weak_phonemes=["th"])).json()
    assert "/th/" in calls[0]["user"], "提示词必须包含要练习的音"
    # 故事里 "with" 含 ð → 达成，不应有 missing warning
    assert "weak_phonemes_missing" not in body["warnings"]
    assert body["provider_meta"]["weak_phonemes_achieved"] == ["th"]


def test_story_weak_phonemes_missing_warning(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    no_th = {"title_en": "Ming", "sentences": ["I built a block tower.", "Hua knocked it down.", "I was angry."]}
    _patch_llm(monkeypatch, [no_th])
    body = client.post("/v1/story/rewrite", json=_story_body(weak_phonemes=["θ"])).json()
    assert "weak_phonemes_missing" in body["warnings"]
    assert body["provider_meta"]["weak_phonemes_missing"] == ["θ"]


# --------------------------------------------------------------------------------------
# /v1/asr 语言规范化（假 Azure SDK）
# --------------------------------------------------------------------------------------
class _FakeASRResult:
    reason = None
    text = "今天我和小明搭积木塔"
    json = "{}"


class _FakeASRFuture:
    def get(self):
        return _FakeASRResult()


class _FakeRecognizer:
    def __init__(self, **kwargs):
        pass

    def recognize_once_async(self):
        return _FakeASRFuture()


def _patch_azure_asr(monkeypatch):
    captured: dict = {}

    class _Config:
        speech_recognition_language = None
        speech_synthesis_voice_name = "en-US-JennyNeural"

        def set_speech_synthesis_output_format(self, value):
            pass

    fake_sdk = SimpleNamespace(
        ResultReason=SimpleNamespace(Canceled="Canceled", NoMatch="NoMatch"),
        audio=SimpleNamespace(AudioConfig=lambda **kwargs: object()),
        SpeechRecognizer=_FakeRecognizer,
        SpeechConfig=lambda **kwargs: _Config(),
    )
    monkeypatch.setattr("app.providers.azure._speechsdk", lambda: fake_sdk)

    def fake_config(settings, sdk):
        config = _Config()
        captured["config"] = config
        return config

    monkeypatch.setattr("app.providers.azure._speech_config", fake_config)
    return captured


def _with_azure_env(monkeypatch):
    monkeypatch.setenv("PROVIDER_MODE", "cloud")
    monkeypatch.setenv("AZURE_SPEECH_KEY", "fake-key")
    monkeypatch.setenv("AZURE_SPEECH_REGION", "eastasia")
    monkeypatch.delenv("ENV_FILE", raising=False)
    reset_settings_cache()
    reset_providers()


def _wav_upload() -> bytes:
    t = np.arange(16000) / 16000
    return pcm16_wav_bytes(0.25 * np.sin(2 * np.pi * 220.0 * t), 16000)


@pytest.mark.parametrize("language, expected", [
    ("zh", "zh-CN"), ("zh-CN", "zh-CN"), ("ZH-cn", "zh-CN"),
    ("en", "en-US"), ("en-US", "en-US"), ("EN", "en-US"),
])
def test_asr_language_normalized_to_azure(client, monkeypatch, language, expected):
    _with_azure_env(monkeypatch)
    captured = _patch_azure_asr(monkeypatch)
    response = client.post("/v1/asr", files={"audio": ("a.wav", _wav_upload(), "audio/wav")}, data={"language": language})
    assert response.status_code == 200, response.text
    assert captured["config"].speech_recognition_language == expected
    body = response.json()
    assert body["language"] == expected
    assert body["text"] == "今天我和小明搭积木塔", "中文识别结果必须原样返回（不做英文后处理）"


def test_asr_invalid_language_returns_400(client, monkeypatch):
    _with_azure_env(monkeypatch)
    _patch_azure_asr(monkeypatch)
    response = client.post("/v1/asr", files={"audio": ("a.wav", _wav_upload(), "audio/wav")}, data={"language": "fr"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"


def test_whisper_language_derivation():
    from app.languages import whisper_language

    assert whisper_language("zh-CN") == "zh"
    assert whisper_language("en-US") == "en"
    assert whisper_language(None) == "en"


def test_story_common_words_and_proper_nouns_are_not_unknown(client, llm_env, monkeypatch, tmp_path):
    """常用词（many/then/tall）与句中人名（Xiaoming）不算超纲词；生僻词仍算。"""
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    story = {
        "title_en": "Ming",
        "sentences": ["Today I built a tall block tower with Xiaoming.", "Then many blocks fell down.", "I was angry."],
    }
    _patch_llm(monkeypatch, [story])
    body = client.post("/v1/story/rewrite", json=_story_body()).json()
    unknown = body["readability"]["unknown_words"]
    assert "many" not in unknown and "then" not in unknown and "xiaoming" not in unknown, unknown
    assert body["readability"]["ok"] is True, body["readability"]


def test_story_sentence_initial_proper_noun_not_unknown(client, llm_env, monkeypatch, tmp_path):
    """句首的人名（Xiaohua ...）也不能被算成超纲词。"""
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    story = {
        "title_en": "Ming",
        "sentences": ["Today I built a tower.", "Xiaohua knocked it down.", "I was angry."],
    }
    _patch_llm(monkeypatch, [story])
    body = client.post("/v1/story/rewrite", json=_story_body()).json()
    assert "xiaohua" not in body["readability"]["unknown_words"]
    assert body["readability"]["ok"] is True, body["readability"]


# --------------------------------------------------------------------------------------
# task-55：C1 级别
# --------------------------------------------------------------------------------------
C1_STORY = {
    "title_en": "The Tower and the Apology",
    "sentences": [
        "Today I constructed an elaborate block tower together with my friend Xiaoming.",
        "Xiaohua inadvertently knocked it over, which made me genuinely furious.",
        "Although I felt deeply upset, I eventually realized it had been an accident.",
        "We rebuilt the tower together, and our friendship became even stronger than before.",
    ],
}


def test_c1_level_accepted(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))  # C1 不判定词表
    reset_story_cache()
    calls = _patch_llm(monkeypatch, [C1_STORY])
    response = client.post("/v1/story/rewrite", json=_story_body(level="C1"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["level"] == "C1"
    assert body["readability"]["ok"] is True
    assert "too_hard" not in body["warnings"]
    # C1 允许抽象词/复合句：不做 unknown_words 判定，不应误报 too_hard
    assert body["readability"]["unknown_words"] == []
    assert "C1" in calls[0]["user"]
    assert "complex" in calls[0]["user"].lower() or "abstract" in calls[0]["user"].lower()


def test_c1_too_long_triggers_rewrite(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    long_sentence = " ".join(["word"] * 21) + "."
    bad = {"title_en": "Too Long", "sentences": [long_sentence]}
    calls = _patch_llm(monkeypatch, [bad, C1_STORY])
    body = client.post("/v1/story/rewrite", json=_story_body(level="C1")).json()
    assert len(calls) == 2
    assert body["readability"]["ok"] is True


def test_c1_two_failures_marks_too_hard(client, llm_env, monkeypatch, tmp_path):
    monkeypatch.setenv("STORY_VOCAB_PATH", _vocab_file(tmp_path, GOOD_TEXT))
    reset_story_cache()
    long_sentence = " ".join(["word"] * 25) + "."
    bad = {"title_en": "Too Long", "sentences": [long_sentence]}
    calls = _patch_llm(monkeypatch, [bad, bad])
    body = client.post("/v1/story/rewrite", json=_story_body(level="C1")).json()
    assert len(calls) == 2
    assert "too_hard" in body["warnings"]
    assert body["readability"]["ok"] is False


def test_c1_avg_words_threshold_is_16():
    from app.story import LEVEL_MAX_AVG_WORDS, evaluate_readability

    assert LEVEL_MAX_AVG_WORDS["C1"] == 16
    ok = evaluate_readability([" ".join(["word"] * 16)], level="C1", max_sentences=6, vocab=set())
    too_long = evaluate_readability([" ".join(["word"] * 17)], level="C1", max_sentences=6, vocab=set())
    assert ok["ok"] is True and ok["avg_words"] == 16.0
    assert too_long["ok"] is False and "avg_words_too_high" in too_long["violations"]
