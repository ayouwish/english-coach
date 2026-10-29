"""task-39：TTS 输出裁首尾静音（Azure 短词尾部 ~1.3s 低电平噪声）。

**不联网**：Azure SDK 用假对象；缓存/F0 用构造 WAV。
"""

from __future__ import annotations

import io
import wave
from types import SimpleNamespace

import numpy as np
import pytest

from app.audio_io import pcm16_wav_bytes, probe_audio, trim_wav_silence, wav_speech_span_ms
from app.config import get_settings, reset_settings_cache
from app.providers.azure import AzureTTS
from app.providers.base import Capabilities
from app.providers.mock import MockPA
from app.providers.registry import ProviderSet, build_providers

SR = 24000


def _tone(count: int, freq: float = 220.0, amp: float = 0.25) -> np.ndarray:
    t = np.arange(count) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _padded_wav(speech_s: float = 0.19, leading_s: float = 0.30, trailing_s: float = 1.33) -> bytes:
    """模拟 Azure "think"：总 1.82s，语音 0.19s，首 0.30s + 尾 1.33s 静音。"""
    total = int((leading_s + speech_s + trailing_s) * SR)
    samples = np.zeros(total, dtype=np.float32)
    start = int(leading_s * SR)
    tone = _tone(int(speech_s * SR))
    samples[start : start + tone.size] = tone
    return pcm16_wav_bytes(samples, SR)


# --------------------------------------------------------------------------------------
# 裁剪工具本身
# --------------------------------------------------------------------------------------
def test_trim_removes_leading_and_trailing_silence():
    raw = _padded_wav()
    assert probe_audio(raw).duration_ms == 1820
    trimmed, changed = trim_wav_silence(raw, threshold_db=-50.0, keep_ms=50)
    assert changed
    assert probe_audio(trimmed).duration_ms == pytest.approx(290, abs=15)
    # 语音段完整保留（0.19s），首尾各留 ~50ms
    span = wav_speech_span_ms(trimmed)
    assert span is not None
    start_ms, end_ms, speech_ms = span
    assert speech_ms == pytest.approx(190, abs=15)
    assert start_ms == pytest.approx(50, abs=15)
    assert end_ms == pytest.approx(240, abs=15)
    assert end_ms - start_ms <= speech_ms + 150, "余量不超过 0.15s"


def test_keep_ms_controls_padding():
    raw = _padded_wav()
    durations = {}
    for keep in (0, 50, 60):
        trimmed, changed = trim_wav_silence(raw, keep_ms=keep)
        assert changed
        durations[keep] = probe_audio(trimmed).duration_ms
    assert durations[0] == pytest.approx(190, abs=15)
    assert durations[50] == pytest.approx(290, abs=15)
    assert durations[60] == pytest.approx(310, abs=15)
    assert durations[0] < durations[50] < durations[60]


def test_threshold_keeps_quiet_tail():
    """真实轻声收尾（-45dB）高于 -50dB 阈值时应保留；-60dB 的底噪应被裁掉。"""
    samples = np.zeros(int(1.0 * SR), dtype=np.float32)
    samples[0:1200] = _tone(1200, amp=0.3)          # 正常语音 50ms
    samples[1200:2400] = _tone(1200, amp=0.006)     # -44dB 轻声收尾
    samples[2400:] = _tone(int(0.9 * SR), amp=0.001)  # -60dB 底噪
    wav = pcm16_wav_bytes(samples, SR)
    trimmed, changed = trim_wav_silence(wav, threshold_db=-50.0, keep_ms=50)
    assert changed
    # 轻声部分（到 100ms）应保留，底噪段被裁掉
    assert probe_audio(trimmed).duration_ms == pytest.approx(150, abs=20)


def test_all_silence_returns_unchanged():
    wav = pcm16_wav_bytes(np.zeros(int(0.5 * SR), dtype=np.float32), SR)
    trimmed, changed = trim_wav_silence(wav)
    assert not changed
    assert trimmed == wav


def test_full_amplitude_audio_unchanged():
    wav = pcm16_wav_bytes(_tone(int(0.5 * SR)), SR)
    trimmed, changed = trim_wav_silence(wav)
    assert not changed
    assert trimmed == wav


def test_very_short_audio_not_broken():
    """<30ms 的音频：不能裁坏（要么原样，要么保留 ≥10ms）。"""
    wav = pcm16_wav_bytes(_tone(int(0.02 * SR)), SR)
    trimmed, changed = trim_wav_silence(wav)
    assert not changed and trimmed == wav
    assert probe_audio(wav).duration_ms > 0


def test_non_wav_bytes_unchanged():
    mp3_like = b"ID3\x04\x00" + b"\x00" * 100
    trimmed, changed = trim_wav_silence(mp3_like)
    assert not changed and trimmed == mp3_like
    assert trim_wav_silence(b"") == (b"", False)


def test_stereo_wav_unchanged():
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(b"\x00\x00" * 2000)
    trimmed, changed = trim_wav_silence(buffer.getvalue())
    assert not changed


# --------------------------------------------------------------------------------------
# Azure provider：WAV 裁、MP3 不裁、可用环境变量关掉
# --------------------------------------------------------------------------------------
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
    def __init__(self, audio: bytes):
        self._audio = audio

    def speak_text_async(self, text):
        return _FakeFuture(_FakeResult(self._audio))

    def speak_ssml_async(self, ssml):
        return _FakeFuture(_FakeResult(self._audio))


def _patch_azure_sdk(monkeypatch, audio: bytes):
    fake_sdk = SimpleNamespace(
        ResultReason=SimpleNamespace(Canceled="Canceled"),
        SpeechSynthesisOutputFormat=SimpleNamespace(
            Riff24Khz16BitMonoPcm=object(), Audio24Khz96KBitRateMonoMp3=object()
        ),
        SpeechSynthesizer=lambda **kwargs: _FakeSynthesizer(audio),
    )
    fake_config = SimpleNamespace(
        speech_synthesis_voice_name="en-US-JennyNeural",
        speech_recognition_language="en-US",
        set_speech_synthesis_output_format=lambda value: None,
    )
    monkeypatch.setattr("app.providers.azure._speechsdk", lambda: fake_sdk)
    monkeypatch.setattr("app.providers.azure._speech_config", lambda settings, sdk: fake_config)
    return fake_sdk


def test_azure_wav_output_is_trimmed(monkeypatch):
    raw = _padded_wav()
    _patch_azure_sdk(monkeypatch, raw)
    monkeypatch.delenv("TTS_TRIM_SILENCE", raising=False)
    reset_settings_cache()
    result = AzureTTS().synthesize("think", fmt="wav")
    assert result.format == "wav"
    assert result.duration_ms == pytest.approx(290, abs=20), "duration_ms 必须是裁剪后的时长"
    assert len(result.audio) < len(raw)
    assert probe_audio(result.audio).duration_ms == pytest.approx(290, abs=20)


def test_azure_mp3_output_is_not_trimmed(monkeypatch):
    raw = _padded_wav()
    _patch_azure_sdk(monkeypatch, raw)
    reset_settings_cache()
    result = AzureTTS().synthesize("think", fmt="mp3")
    assert result.format == "mp3"
    assert result.audio == raw, "mp3 不裁剪（无 ffmpeg，不重编码）"


def test_azure_trim_can_be_disabled(monkeypatch):
    raw = _padded_wav()
    _patch_azure_sdk(monkeypatch, raw)
    monkeypatch.setenv("TTS_TRIM_SILENCE", "0")
    reset_settings_cache()
    try:
        result = AzureTTS().synthesize("think", fmt="wav")
    finally:
        monkeypatch.delenv("TTS_TRIM_SILENCE", raising=False)
        reset_settings_cache()
    assert result.audio == raw
    assert result.duration_ms == pytest.approx(1820, abs=30)


# --------------------------------------------------------------------------------------
# 缓存：存的必须是裁剪后的字节；同一 key 两次请求字节一致
# --------------------------------------------------------------------------------------
class _TrimmingFakeTTS:
    """模拟 Azure 的行为：合成出带尾部噪声的 WAV，再裁剪后返回。"""

    name = "faketts"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice=None, rate="normal", fmt="mp3", ssml=None):
        self.calls += 1
        raw = _padded_wav()
        trimmed, _changed = trim_wav_silence(raw)
        return SimpleNamespace(
            audio=trimmed,
            content_type="audio/wav",
            provider=self.name,
            duration_ms=probe_audio(trimmed).duration_ms,
            format="wav",
        )


def test_tts_cache_stores_trimmed_bytes(client, monkeypatch):
    fake = _TrimmingFakeTTS()
    base = build_providers()
    provider_set = ProviderSet(
        asr=base.asr,
        pa=base.pa or MockPA(),
        tts=fake,
        asr_chain=base.asr_chain,
        pa_chain=base.pa_chain,
        tts_chain=[fake],
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)

    payload = {"text": "think", "format": "wav", "rate": "normal"}
    first = client.post("/v1/tts", json=payload)
    second = client.post("/v1/tts", json=payload)
    assert first.status_code == 200 and second.status_code == 200
    assert first.content == second.content, "同一 key 两次请求必须字节一致（缓存的是裁剪后的字节）"
    assert first.headers["X-Cache"] == "miss"
    assert second.headers["X-Cache"] == "hit"
    duration = int(second.headers["X-Audio-Duration-Ms"])
    assert duration == pytest.approx(290, abs=20), "header 必须是裁剪后时长"
    assert fake.calls == 1, "第二次应命中缓存，不重复合成"

    # 缓存文件落盘的也必须是裁剪后的字节
    audio_dir = get_settings().data_dir / "cache" / "audio"
    cached = [path for path in audio_dir.glob("*.wav")]
    assert cached, "应写入了 wav 缓存"
    assert cached[0].read_bytes() == first.content


# --------------------------------------------------------------------------------------
# F0 参考音分析不受影响
# --------------------------------------------------------------------------------------
def test_f0_analysis_unaffected_by_trim():
    from app.audio_io import decode_audio
    from app.intonation import extract_f0

    raw = _padded_wav()
    trimmed, _ = trim_wav_silence(raw)
    clip_raw = decode_audio(raw)
    clip_trimmed = decode_audio(trimmed)
    f0_raw = extract_f0(clip_raw.samples, clip_raw.sample_rate)
    f0_trimmed = extract_f0(clip_trimmed.samples, clip_trimmed.sample_rate)
    voiced_raw = f0_raw.f0[np.isfinite(f0_raw.f0)]
    voiced_trimmed = f0_trimmed.f0[np.isfinite(f0_trimmed.f0)]
    assert voiced_trimmed.size > 0, "裁剪后仍必须能提取 F0"
    assert np.median(voiced_trimmed) == pytest.approx(np.median(voiced_raw), abs=5.0)
    assert voiced_trimmed.size >= voiced_raw.size * 0.6
