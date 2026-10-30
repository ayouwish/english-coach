"""task-56：ASR 连续识别（中间停顿不再丢后半句）+ PA 多段合并。

全部用假 Azure SDK / 假 provider，不联网。
"""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from app.audio_io import pcm16_wav_bytes
from app.config import reset_settings_cache
from app.errors import ProviderError, ProviderTimeout
from app.providers.registry import reset_providers

TICKS_PER_MS = 10000


def _clip(seconds: float = 2.0):
    from app.audio_io import decode_audio

    samples = 0.25 * np.sin(2 * np.pi * 220.0 * np.arange(int(16000 * seconds)) / 16000)
    return decode_audio(pcm16_wav_bytes(samples.astype(np.float32), 16000), 16000, 60.0)


class _Connection:
    def __init__(self):
        self.handlers = []

    def connect(self, handler):
        self.handlers.append(handler)

    def fire(self, event):
        for handler in self.handlers:
            handler(event)


class _Future:
    def __init__(self, value=None):
        self._value = value

    def get(self, timeout=None):
        return self._value


def _evt(result):
    return SimpleNamespace(result=result)


def _word_dict(word: str, start_ms: int, duration_ms: int):
    return {
        "Word": word,
        "Offset": start_ms * TICKS_PER_MS,
        "Duration": duration_ms * TICKS_PER_MS,
        "Confidence": 0.9,
    }


def _asr_result(text: str, words: list | None = None):
    payload = {"NBest": [{"Words": words or []}]}
    import json as _json

    return SimpleNamespace(reason="RecognizedSpeech", text=text, json=_json.dumps(payload))


def _pa_result(text: str, words: list, scores: dict):
    return SimpleNamespace(
        reason="RecognizedSpeech",
        text=text,
        json="{}",
        assessment={"words": words, **scores},
    )


def _word(word: str, start_ms: int, duration_ms: int, accuracy: float = 90.0, error="None", phonemes=None):
    return SimpleNamespace(
        word=word,
        offset=start_ms * TICKS_PER_MS,
        duration=duration_ms * TICKS_PER_MS,
        accuracy_score=accuracy,
        error_type=error,
        phonemes=phonemes or [],
    )


class FakeRecognizer:
    scenario = "two"
    events: list = []
    instances: list = []

    def __init__(self, speech_config=None, audio_config=None):
        self.recognized = _Connection()
        self.canceled = _Connection()
        self.session_stopped = _Connection()
        self.speech_config = speech_config
        FakeRecognizer.instances.append(self)

    def start_continuous_recognition_async(self):
        scenario = type(self).scenario
        if scenario == "timeout":
            return _Future()
        if scenario == "cancel":
            details = SimpleNamespace(reason="Error", error_details="connection dropped")
            self.canceled.fire(_evt(SimpleNamespace(reason="Canceled", cancellation_details=details)))
            return _Future()
        for result in type(self).events:
            self.recognized.fire(_evt(result))
        self.session_stopped.fire(_evt(None))
        return _Future()

    def stop_continuous_recognition_async(self):
        return _Future()


def _fake_sdk(config_capture: dict):
    class _Config:
        speech_recognition_language = "en-US"
        speech_synthesis_voice_name = "en-US-JennyNeural"

        def __init__(self):
            self.properties = {}
            config_capture["config"] = self

        def set_property(self, property_id, value):
            self.properties[property_id] = value

        def set_speech_synthesis_output_format(self, value):
            pass

    pa_config = SimpleNamespace(
        apply_to=lambda recognizer: None,
        enable_prosody_assessment=lambda: None,
    )
    return SimpleNamespace(
        ResultReason=SimpleNamespace(RecognizedSpeech="RecognizedSpeech", NoMatch="NoMatch", Canceled="Canceled"),
        CancellationReason=SimpleNamespace(Error="Error"),
        PropertyId=SimpleNamespace(Speech_SegmentationSilenceTimeoutMs="Speech_SegmentationSilenceTimeoutMs"),
        audio=SimpleNamespace(AudioConfig=lambda **kwargs: object()),
        SpeechRecognizer=FakeRecognizer,
        SpeechConfig=lambda **kwargs: _Config(),
        PronunciationAssessmentConfig=lambda **kwargs: pa_config,
        PronunciationAssessmentGradingSystem=SimpleNamespace(HundredMark="HundredMark"),
        PronunciationAssessmentGranularity=SimpleNamespace(Phoneme="Phoneme"),
        PronunciationAssessmentResult=lambda result: SimpleNamespace(**result.assessment),
    )


def _azure_env(monkeypatch, *, scenario="two", events=None):
    monkeypatch.setenv("PROVIDER_MODE", "cloud")
    monkeypatch.setenv("AZURE_SPEECH_KEY", "fake-key")
    monkeypatch.setenv("AZURE_SPEECH_REGION", "eastasia")
    monkeypatch.setenv("AZURE_SEGMENTATION_SILENCE_TIMEOUT_MS", "1500")
    monkeypatch.delenv("ENV_FILE", raising=False)
    reset_settings_cache()
    reset_providers()
    FakeRecognizer.scenario = scenario
    FakeRecognizer.events = events or []
    FakeRecognizer.instances = []
    capture: dict = {}
    monkeypatch.setattr("app.providers.azure._speechsdk", lambda: _fake_sdk(capture))
    monkeypatch.setattr("app.providers.azure._speech_config", lambda settings, sdk: _fake_sdk(capture).SpeechConfig())
    return capture


def _post_asr(client, language: str = "en"):
    return client.post(
        "/v1/asr",
        files={"audio": ("a.wav", pcm16_wav_bytes(0.0 * np.ones(16000, dtype=np.float32), 16000), "audio/wav")},
        data={"language": language},
    )


# --------------------------------------------------------------------------------------
# 核心：多段拼接
# --------------------------------------------------------------------------------------
def test_asr_joins_multiple_segments(client, monkeypatch):
    capture = _azure_env(monkeypatch, events=[
        _asr_result("I like going to my school today.", [_word_dict("I", 0, 200), _word_dict("like", 200, 200)]),
        _asr_result("I like my school very much.", [_word_dict("I", 3000, 200), _word_dict("like", 3200, 200)]),
    ])
    response = _post_asr(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["text"] == "I like going to my school today. I like my school very much."
    assert body["provider"] == "azure"
    assert body["language"] == "en-US"
    assert len(body["words"]) == 4, "两段的词时间轴都要保留"
    # 分段静音阈值已下发
    assert capture["config"].properties["Speech_SegmentationSilenceTimeoutMs"] == "1500"


def test_asr_single_segment_unchanged(client, monkeypatch):
    _azure_env(monkeypatch, events=[_asr_result("Hello world.")])
    body = _post_asr(client).json()
    assert body["text"] == "Hello world."


def test_asr_zero_segments_reports_no_speech(client, monkeypatch, caplog):
    import logging

    _azure_env(monkeypatch, events=[])
    with caplog.at_level(logging.WARNING):
        response = _post_asr(client)
    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "provider_error"
    assert "没有识别到语音" in body["error"]["message"]
    assert "Hello" not in response.text, "绝不能拿 mock 文本冒充识别结果"


def test_asr_canceled_error_raises_provider_error(monkeypatch):
    from app.providers.azure import AzureASR

    _azure_env(monkeypatch, scenario="cancel")
    with pytest.raises(ProviderError):
        AzureASR().recognize(_clip())


def test_asr_timeout_raises_provider_timeout(monkeypatch):
    from app.providers.azure import AzureASR

    monkeypatch.setenv("AZURE_ASR_TIMEOUT_S", "0.2")
    _azure_env(monkeypatch, scenario="timeout")
    with pytest.raises(ProviderTimeout):
        AzureASR().recognize(_clip())


def test_asr_chinese_segments_joined(client, monkeypatch):
    _azure_env(monkeypatch, events=[
        _asr_result("今天我和小明搭积木塔。"),
        _asr_result("被小华碰倒了，我很生气。"),
    ])
    body = _post_asr(client, language="zh").json()
    assert body["text"] == "今天我和小明搭积木塔。 被小华碰倒了，我很生气。"
    assert body["language"] == "zh-CN"


# --------------------------------------------------------------------------------------
# PA 多段合并
# --------------------------------------------------------------------------------------
def test_pa_merges_segments(monkeypatch):
    from app.providers.azure import AzurePA

    words_one = [_word("hello", 0, 200), _word("world", 200, 200)]
    words_two = [_word("how", 3000, 200), _word("are", 3200, 200), _word("you", 3400, 200)]
    events = [
        _pa_result("hello world", words_one, {"pronunciation_score": 80.0, "accuracy_score": 80.0,
                                              "fluency_score": 80.0, "completeness_score": 80.0, "prosody_score": 80.0}),
        _pa_result("how are you", words_two, {"pronunciation_score": 90.0, "accuracy_score": 90.0,
                                              "fluency_score": 90.0, "completeness_score": 90.0, "prosody_score": 90.0}),
    ]
    _azure_env(monkeypatch, events=events)
    result = AzurePA().assess(_clip(), "hello world how are you")
    assert result.recognized_text == "hello world how are you"
    assert len(result.words) == 5, "两段单词都要保留"
    assert [w.word for w in result.words] == ["hello", "world", "how", "are", "you"]
    # 第二段词更多（600ms vs 400ms）→ 加权平均应偏向 90
    assert result.scores.pron is not None and 84.0 < result.scores.pron < 90.0
    assert result.provider_meta["segments"] == 2


# --------------------------------------------------------------------------------------
# faster-whisper 本地路径：整段解码，无单段问题
# --------------------------------------------------------------------------------------
def test_local_asr_transcribes_whole_clip(monkeypatch):
    from app.providers import local as local_module

    captured = {}

    def fake_transcribe(clip, language="en"):
        captured["duration_ms"] = clip.duration_ms
        captured["language"] = language
        return "first sentence. second sentence", [], {}

    monkeypatch.setattr(local_module, "transcribe_words", fake_transcribe)
    clip = _clip(3.0)
    result = local_module.LocalASR().recognize(clip, language="en-US")
    assert captured["duration_ms"] == clip.duration_ms, "whisper 必须一次拿到整段音频"
    assert captured["language"] == "en"
    assert result.text == "first sentence. second sentence"


def test_empty_transcript_is_reported_as_no_speech(client, monkeypatch):
    """本地 whisper 遇到静音会返回空文本 → 路由必须按"没听到"报 502，而不是 200 + 空 text。"""
    from app.config import get_settings
    from app.providers.base import ASRResult, Capabilities
    from app.providers.mock import MockPA
    from app.providers.registry import ProviderSet, build_providers, reset_providers

    class EmptyASR:
        name = "whisper-local"
        capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

        def recognize(self, clip, language="en", prompt=None):
            return ASRResult(text="", language="en-US", duration_ms=clip.duration_ms, provider=self.name)

    monkeypatch.setenv("PROVIDER_MODE", "local")
    monkeypatch.delenv("ENV_FILE", raising=False)
    reset_settings_cache()
    reset_providers()
    base = build_providers()
    provider_set = ProviderSet(
        asr=EmptyASR(), pa=base.pa or MockPA(), tts=base.tts,
        asr_chain=[EmptyASR()], pa_chain=base.pa_chain, tts_chain=base.tts_chain,
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    response = _post_asr(client)
    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "provider_error"
    assert "没有识别到语音" in body["error"]["message"]
