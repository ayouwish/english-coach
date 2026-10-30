"""task-46：TTS SSML 的 xml:lang 按音色推导（支持中文鼓励语音色）+ voice 透传/注入防护。"""

from __future__ import annotations

import re
from types import SimpleNamespace

import numpy as np
import pytest

from app.audio_io import pcm16_wav_bytes, probe_audio
from app.config import get_settings, reset_settings_cache
from app.providers.azure import AzureTTS
from app.providers.base import Capabilities
from app.providers.mock import MockPA
from app.providers.registry import ProviderSet, build_providers
from app.voice_names import is_valid_voice_name, normalize_voice_name, voice_locale

SR = 24000


def _wav24(seconds: float = 0.4) -> bytes:
    t = np.arange(int(SR * seconds)) / SR
    return pcm16_wav_bytes(0.25 * np.sin(2 * np.pi * 220.0 * t), SR)


class _FakeResult:
    reason = None

    def __init__(self, audio: bytes):
        self.audio_data = audio
        self.audio_duration = None


class _FakeFuture:
    def __init__(self, result):
        self._result = result

    def get(self):
        return self._result


class _FakeSynthesizer:
    last_ssml: str | None = None
    last_text: str | None = None
    audio = _wav24()

    def __init__(self, **kwargs):
        pass

    def speak_ssml_async(self, ssml):
        type(self).last_ssml = ssml
        return _FakeFuture(_FakeResult(self.audio))

    def speak_text_async(self, text):
        type(self).last_text = text
        return _FakeFuture(_FakeResult(self.audio))


def _patch_azure_sdk(monkeypatch):
    _FakeSynthesizer.last_ssml = None
    _FakeSynthesizer.last_text = None
    fake_sdk = SimpleNamespace(
        ResultReason=SimpleNamespace(Canceled="Canceled"),
        SpeechSynthesisOutputFormat=SimpleNamespace(
            Riff24Khz16BitMonoPcm=object(), Audio24Khz96KBitRateMonoMp3=object()
        ),
        SpeechSynthesizer=lambda **kwargs: _FakeSynthesizer(**kwargs),
    )
    fake_config = SimpleNamespace(
        speech_synthesis_voice_name="en-US-JennyNeural",
        speech_recognition_language="en-US",
        set_speech_synthesis_output_format=lambda value: None,
    )
    monkeypatch.setattr("app.providers.azure._speechsdk", lambda: fake_sdk)
    monkeypatch.setattr("app.providers.azure._speech_config", lambda settings, sdk: fake_config)
    return fake_sdk


# --------------------------------------------------------------------------------------
# A. locale 推导
# --------------------------------------------------------------------------------------
def test_voice_locale_parsing():
    assert voice_locale("zh-CN-XiaoxiaoNeural") == "zh-CN"
    assert voice_locale("en-US-JennyNeural") == "en-US"
    assert voice_locale("en-GB-SoniaNeural") == "en-GB"
    assert voice_locale("zh-CN-liaoning-XiaobeiNeural") == "zh-CN"  # 带方言段
    assert voice_locale("yue-CN-XiaoMinNeural") == "yue-CN"


def test_voice_locale_fallback_chain():
    # 无法解析 locale → 回退默认音色的 locale
    assert voice_locale("JustAVoice", "zh-CN-XiaoxiaoNeural") == "zh-CN"
    # 都失败 → en-US
    assert voice_locale(None, None) == "en-US"
    assert voice_locale("", "") == "en-US"


def test_voice_name_injection_guard():
    assert is_valid_voice_name("zh-CN-XiaoxiaoNeural")
    assert normalize_voice_name(" zh-CN-XiaoxiaoNeural ") == "zh-CN-XiaoxiaoNeural"
    for bad in ('zh-CN-X"><script>', "zh-CN-X&y", "zh CN X", "a\nb", "x" * 200):
        assert not is_valid_voice_name(bad), bad
        assert normalize_voice_name(bad) is None, bad


# --------------------------------------------------------------------------------------
# B. Azure slow 分支：SSML 的 xml:lang 与 voice 一致
# --------------------------------------------------------------------------------------
def _ssml_locale(ssml: str) -> str | None:
    match = re.search(r'xml:lang="([^"]+)"', ssml or "")
    return match.group(1) if match else None


def _ssml_voice(ssml: str) -> str | None:
    match = re.search(r'<voice name="([^"]+)"', ssml or "")
    return match.group(1) if match else None


def test_ssml_locale_follows_zh_voice(monkeypatch):
    _patch_azure_sdk(monkeypatch)
    monkeypatch.delenv("TTS_TRIM_SILENCE", raising=False)
    reset_settings_cache()
    result = AzureTTS().synthesize("你真棒！继续加油！", voice="zh-CN-XiaoxiaoNeural", rate="slow", fmt="wav")
    assert result.audio and probe_audio(result.audio).duration_ms > 0
    ssml = _FakeSynthesizer.last_ssml
    assert ssml is not None
    assert _ssml_locale(ssml) == "zh-CN", ssml
    assert _ssml_voice(ssml) == "zh-CN-XiaoxiaoNeural", ssml
    assert _FakeSynthesizer.last_text is None, "slow 分支应走 SSML，不是纯文本"


def test_ssml_locale_follows_en_voice_regression(monkeypatch):
    _patch_azure_sdk(monkeypatch)
    reset_settings_cache()
    AzureTTS().synthesize("think", voice="en-US-JennyNeural", rate="slow", fmt="wav")
    ssml = _FakeSynthesizer.last_ssml
    assert _ssml_locale(ssml) == "en-US", ssml
    assert _ssml_voice(ssml) == "en-US-JennyNeural", ssml


def test_ssml_locale_falls_back_to_default_voice_locale(monkeypatch):
    _patch_azure_sdk(monkeypatch)
    monkeypatch.setenv("AZURE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
    reset_settings_cache()
    try:
        AzureTTS().synthesize("鼓励", voice="JustAVoice", rate="slow", fmt="wav")
    finally:
        monkeypatch.delenv("AZURE_TTS_VOICE", raising=False)
        reset_settings_cache()
    ssml = _FakeSynthesizer.last_ssml
    assert _ssml_locale(ssml) == "zh-CN", ssml
    assert _ssml_voice(ssml) == "JustAVoice", ssml


def test_non_slow_branch_uses_text_not_ssml(monkeypatch):
    """非 slow 分支不要动：仍走 speak_text_async，由 SDK 按语音名处理 locale。"""
    _patch_azure_sdk(monkeypatch)
    reset_settings_cache()
    AzureTTS().synthesize("think", voice="zh-CN-XiaoxiaoNeural", rate="normal", fmt="wav")
    assert _FakeSynthesizer.last_text == "think"
    assert _FakeSynthesizer.last_ssml is None


# --------------------------------------------------------------------------------------
# C. /v1/tts：voice 透传 + 注入拒绝 + 缓存按 voice 隔离
# --------------------------------------------------------------------------------------
class _CapturingTTS:
    name = "capturing"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def __init__(self):
        self.voices: list[str | None] = []

    def synthesize(self, text, voice=None, rate="normal", fmt="mp3", ssml=None):
        self.voices.append(voice)
        data = _wav24()
        return SimpleNamespace(
            audio=data, content_type="audio/wav", provider=self.name,
            duration_ms=probe_audio(data).duration_ms, format="wav",
        )


def _patch_tts(client, monkeypatch, provider):
    base = build_providers()
    provider_set = ProviderSet(
        asr=base.asr, pa=base.pa or MockPA(), tts=provider,
        asr_chain=base.asr_chain, pa_chain=base.pa_chain, tts_chain=[provider],
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    return provider


def test_tts_voice_passthrough_and_cache_isolation(client, monkeypatch):
    provider = _patch_tts(client, monkeypatch, _CapturingTTS())
    payload = {"text": "你真棒", "format": "wav", "rate": "slow"}

    zh = client.post("/v1/tts", json={**payload, "voice": "zh-CN-XiaoxiaoNeural"})
    en = client.post("/v1/tts", json={**payload, "voice": "en-US-JennyNeural"})
    assert zh.status_code == 200 and en.status_code == 200
    assert provider.voices == ["zh-CN-XiaoxiaoNeural", "en-US-JennyNeural"], "voice 必须原样透传"
    assert zh.headers["X-Cache"] == "miss" and en.headers["X-Cache"] == "miss"
    assert zh.content == en.content  # 同一假 provider 产出相同字节，但 key 必须不同

    # 中英文缓存条目不互相污染
    audio_dir = get_settings().data_dir / "cache" / "audio"
    assert len(list(audio_dir.glob("*.wav"))) == 2, "中英文应是两条独立缓存"
    zh_again = client.post("/v1/tts", json={**payload, "voice": "zh-CN-XiaoxiaoNeural"})
    assert zh_again.headers["X-Cache"] == "hit"
    assert provider.voices == ["zh-CN-XiaoxiaoNeural", "en-US-JennyNeural"], "命中缓存不应再调 provider"


def test_tts_rejects_injected_voice(client):
    response = client.post(
        "/v1/tts",
        json={"text": "hello", "format": "wav", "voice": 'zh-CN-X"><script>alert(1)</script>'},
    )
    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "bad_request"
    assert "voice" in body["error"]["message"].lower()
