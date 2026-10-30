"""task-15 回归：TTS 输出格式真的生效 + `/v1/tts` 复用参考音缓存。

两个真实缺陷：
1. `config.speech_synthesis_output_format = ...` 静默失效（SDK 只有
   `set_speech_synthesis_output_format()`），于是无论请求 mp3 还是 wav，
   返回的都是默认 16kHz PCM（听起来发闷），而 `content_type` 仍标 mp3。
2. `/v1/tts` 完全不查 `WarmupCache` → 预热过的语料每次点「只听示范」仍真调一次云 TTS。
"""

from __future__ import annotations

import io
import time

import numpy as np
from pathlib import Path

import pytest

from app.audio_io import probe_audio
from app.cache import KEY_VERSION, cache_key, get_cache, legacy_v2_cache_key, reset_cache
from app.config import reset_settings_cache
from app.providers.base import Capabilities, TTSResult
from app.providers.registry import ProviderSet, build_providers
from app.audio_io import pcm16_wav_bytes
from app.synth import sweep_wav, synthesize_speech_wav, tone_wav

TEXT = "I think the weather is really nice today."
VOICE = "en-US-JennyNeural"
RATE = "normal"


def _fake_mp3(seconds: float = 0.4, freq: float = 220.0, sample_rate: int = 24000) -> bytes:
    """用 PyAV 编一段真 mp3（本机没有系统 ffmpeg，但 av 自带编码器）。"""
    import av
    import numpy as np

    buf = io.BytesIO()
    container = av.open(buf, mode="w", format="mp3")
    stream = container.add_stream("mp3", rate=sample_rate)
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    pcm = (0.3 * np.sin(2 * np.pi * freq * t) * 32767).astype("<i2").tobytes()
    frame = av.AudioFrame(format="s16", layout="mono", samples=t.size)
    frame.sample_rate = sample_rate
    frame.planes[0].update(pcm)
    for packet in stream.encode(frame):
        container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    return buf.getvalue()


class CountingTTS:
    """可计数/可延迟的假 TTS（name="mock" 以对齐真实 provider 名，便于 key 复用断言）。"""

    name = "mock"
    capabilities = Capabilities()

    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.calls = 0

    def synthesize(self, text: str, voice=None, rate="normal", fmt="mp3", ssml=None) -> TTSResult:
        self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        if fmt == "mp3":
            return TTSResult(audio=_fake_mp3(), content_type="audio/mpeg", provider=self.name, duration_ms=0, format="mp3")
        return TTSResult(
            audio=synthesize_speech_wav(text or "hello", voice=voice, rate=rate),
            content_type="audio/wav",
            provider=self.name,
            duration_ms=0,
            format="wav",
        )


def _patch_tts(monkeypatch, provider):
    base = build_providers()
    provider_set = ProviderSet(
        asr=base.asr,
        pa=base.pa,
        tts=provider,
        asr_chain=base.asr_chain,
        pa_chain=base.pa_chain,
        tts_chain=[provider],
        mode=base.mode,
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    monkeypatch.setattr("app.warmup.get_providers", lambda: provider_set)
    return provider


# --------------------------------------------------------------------------------------
# 1. /v1/tts 缓存：miss -> hit
# --------------------------------------------------------------------------------------
def test_tts_first_miss_then_hit(client, monkeypatch):
    provider = _patch_tts(monkeypatch, CountingTTS())

    first = client.post("/v1/tts", json={"text": TEXT, "voice": VOICE, "rate": RATE, "format": "wav"})
    assert first.status_code == 200
    assert first.headers["X-Cache"] == "miss"
    assert first.headers["X-TTS-Provider"] == "mock"
    assert int(first.headers["X-Audio-Duration-Ms"]) > 0, "契约要求 /v1/tts 始终带 X-Audio-Duration-Ms"
    assert provider.calls == 1

    second = client.post("/v1/tts", json={"text": TEXT, "voice": VOICE, "rate": RATE, "format": "wav"})
    assert second.status_code == 200
    assert second.headers["X-Cache"] == "hit"
    assert second.headers["X-TTS-Provider"] == "mock"
    assert int(second.headers["X-Audio-Duration-Ms"]) > 0, "命中缓存也必须带契约要求的头"
    assert provider.calls == 1, "命中缓存后不得再调用 TTS"
    assert second.content == first.content


def test_tts_cache_hit_is_faster(client, monkeypatch):
    provider = _patch_tts(monkeypatch, CountingTTS(delay=0.5))
    started = time.perf_counter()
    client.post("/v1/tts", json={"text": TEXT, "format": "wav"})
    first_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    response = client.post("/v1/tts", json={"text": TEXT, "format": "wav"})
    second_ms = (time.perf_counter() - started) * 1000
    assert response.headers["X-Cache"] == "hit"
    assert provider.calls == 1
    assert first_ms > 500
    assert second_ms < first_ms / 2, f"first={first_ms:.0f}ms second={second_ms:.0f}ms"


def test_tts_fmt_is_part_of_key_and_serves_matching_content_type(client, monkeypatch):
    provider = _patch_tts(monkeypatch, CountingTTS())
    wav = client.post("/v1/tts", json={"text": TEXT, "format": "wav"})
    mp3 = client.post("/v1/tts", json={"text": TEXT, "format": "mp3"})
    assert wav.headers["content-type"].startswith("audio/wav")
    assert mp3.headers["content-type"].startswith("audio/mpeg")
    assert wav.headers["X-Cache"] == mp3.headers["X-Cache"] == "miss", "两种格式是不同产物，必须各自 miss 一次"
    assert provider.calls == 2
    # 容器与标称必须一致（历史 bug 是"标 mp3、实物 wav"）
    assert probe_audio(wav.content).container == "wav"
    assert probe_audio(mp3.content).container == "mp3"
    assert wav.content != mp3.content

    key_wav = cache_key(TEXT, VOICE, RATE, "mock", "wav")
    key_mp3 = cache_key(TEXT, VOICE, RATE, "mock", "mp3")
    assert key_wav != key_mp3
    assert get_cache().get_audio(key_wav) is not None
    assert get_cache().get_audio(key_mp3) is not None


def test_tts_reuses_reference_cache_from_warmup(client, monkeypatch):
    """预热（pronounce/warmup 用的 wav 参考音）之后，/v1/tts?format=wav 必须直接命中。"""
    provider = _patch_tts(monkeypatch, CountingTTS())
    warmed = client.post("/v1/warmup", json={"items": [{"text": TEXT, "voice": None, "rate": RATE}]}).json()
    assert warmed["generated"] == 1
    assert provider.calls == 1

    response = client.post("/v1/tts", json={"text": TEXT, "format": "wav"})
    assert response.headers["X-Cache"] == "hit", "预热过的语料不应再真调一次 TTS"
    assert provider.calls == 1

    # mp3 是另一个产物：确实会 miss（这是"两条路只在同格式上打通"的诚实行为）
    mp3 = client.post("/v1/tts", json={"text": TEXT, "format": "mp3"})
    assert mp3.headers["X-Cache"] == "miss"
    assert provider.calls == 2


def test_tts_v2_legacy_cache_is_not_hit(client, monkeypatch):
    """v2 时代的缓存（含 provider、不含 fmt、且音频是 16kHz 坏产物）绝不能再命中。"""
    provider = _patch_tts(monkeypatch, CountingTTS())
    legacy_key = legacy_v2_cache_key(TEXT, VOICE, RATE, "mock")
    cache = get_cache()
    cache.audio_dir.mkdir(parents=True, exist_ok=True)
    legacy_file = cache.audio_dir / f"{legacy_key}.wav"
    legacy_file.write_bytes(sweep_wav(150.0, 250.0, 0.5))

    response = client.post("/v1/tts", json={"text": TEXT, "format": "wav"})
    assert response.headers["X-Cache"] == "miss"
    assert provider.calls == 1
    assert response.content != legacy_file.read_bytes()
    assert legacy_file.is_file()
    assert KEY_VERSION == "v3"


def test_tts_ssml_skips_cache(client, monkeypatch):
    provider = _patch_tts(monkeypatch, CountingTTS())
    ssml = '<speak version="1.0" xml:lang="en-US"><voice name="en-US-JennyNeural">hello there</voice></speak>'
    first = client.post("/v1/tts", json={"text": "", "ssml": ssml, "format": "wav"})
    second = client.post("/v1/tts", json={"text": "", "ssml": ssml, "format": "wav"})
    assert first.headers["X-Cache"] == second.headers["X-Cache"] == "disabled"
    assert provider.calls == 2, "SSML 无法用 text 做 key，必须每次都真的合成"
    assert get_cache().stats()["audio_entries"] == 0


def test_tts_cache_disabled_writes_nothing(client, monkeypatch):
    monkeypatch.setenv("CACHE_ENABLED", "false")
    reset_settings_cache()
    reset_cache()
    provider = _patch_tts(monkeypatch, CountingTTS())
    response = client.post("/v1/tts", json={"text": TEXT, "format": "wav"})
    assert response.status_code == 200
    assert response.headers["X-Cache"] == "disabled"
    assert provider.calls == 1
    assert get_cache().stats()["audio_entries"] == 0, "关闭缓存时绝不落盘"


def test_tts_fallback_audio_is_not_cached(client, monkeypatch):
    class BrokenTTS(CountingTTS):
        def synthesize(self, *args, **kwargs):
            self.calls += 1
            raise RuntimeError("tts down")

    provider = _patch_tts(monkeypatch, BrokenTTS())
    response = client.post("/v1/tts", json={"text": TEXT, "format": "wav"})
    assert response.status_code == 200
    assert response.headers["X-TTS-Fallback"] == "1"
    assert provider.calls == 1
    assert get_cache().get_audio(cache_key(TEXT, VOICE, RATE, "mock", "wav")) is None


# --------------------------------------------------------------------------------------
# 2. probe_audio：读真实容器/采样率（"标称 mp3、实物 16kHz PCM" 就是靠它发现的）
# --------------------------------------------------------------------------------------
def test_probe_audio_reads_real_container_and_rate():
    probe = probe_audio(tone_wav(180.0, 0.5))
    assert probe.container == "wav"
    assert probe.codec == "pcm_s16le"
    assert probe.sample_rate == 16000
    assert probe.duration_ms == pytest.approx(500, abs=20)

    mp3_probe = probe_audio(_fake_mp3(seconds=0.4, sample_rate=24000))
    assert mp3_probe.container == "mp3"
    assert mp3_probe.codec.startswith("mp3")
    assert mp3_probe.sample_rate == 24000


def test_probe_audio_rejects_garbage():
    from app.errors import UnsupportedAudio

    with pytest.raises(UnsupportedAudio):
        probe_audio(b"not audio")


# --------------------------------------------------------------------------------------
# 3. Azure 输出格式：必须调用 setter（防再次静默失效）
# --------------------------------------------------------------------------------------
class _FakeFuture:
    def __init__(self, value):
        self._value = value

    def get(self, *args, **kwargs):
        return self._value


class _FakeResult:
    class _Duration:
        def total_seconds(self):
            return 0.4

    def __init__(self, audio: bytes, reason: int = 1):
        self.audio_data = audio
        self.reason = reason
        self.text = "hi"
        self.json = "{}"
        self.audio_duration = self._Duration()


class _FakeSpeechConfig:
    """刻意**不提供** `speech_synthesis_output_format` 属性，与真实 SDK 一致。"""

    def __init__(self, subscription=None, region=None, endpoint=None):
        self.subscription = subscription
        self.region = region
        self.endpoint = endpoint
        self.output_format_calls: list = []

    def set_speech_synthesis_output_format(self, output_format):
        self.output_format_calls.append(output_format)


class _FakeSynthesizer:
    last_config = None
    audio = b""

    def __init__(self, speech_config=None, audio_config=None):
        _FakeSynthesizer.last_config = speech_config

    def speak_text_async(self, text):
        return _FakeFuture(_FakeResult(_FakeSynthesizer.audio))

    def speak_ssml_async(self, ssml):
        return _FakeFuture(_FakeResult(_FakeSynthesizer.audio))


class _FakeSpeechSDK:
    class SpeechSynthesisOutputFormat:
        Audio24Khz96KBitRateMonoMp3 = "MP3_24K"
        Riff24Khz16BitMonoPcm = "WAV_24K"

    class ResultReason:
        Canceled = 2
        NoMatch = 3

    SpeechConfig = _FakeSpeechConfig
    SpeechSynthesizer = _FakeSynthesizer

    class audio:  # noqa: N801 - 模拟 speechsdk.audio 子模块
        class AudioConfig:
            def __init__(self, filename=None):
                self.filename = filename


@pytest.fixture
def fake_azure(monkeypatch):
    monkeypatch.setenv("AZURE_SPEECH_KEY", "fake-key")
    monkeypatch.setenv("AZURE_SPEECH_REGION", "eastasia")
    reset_settings_cache()
    monkeypatch.setattr("app.providers.azure._speechsdk", lambda: _FakeSpeechSDK)
    _FakeSynthesizer.audio = pcm16_wav_bytes(np.linspace(0, 0, 24000 * 4 // 10, dtype=np.float32) + 0.2 * np.sin(2 * np.pi * 220.0 * np.arange(24000 * 4 // 10) / 24000), 24000)
    yield _FakeSpeechSDK
    reset_settings_cache()


@pytest.mark.parametrize(
    "fmt,expected_enum,expected_content_type",
    [
        ("mp3", "MP3_24K", "audio/mpeg"),
        ("wav", "WAV_24K", "audio/wav"),
    ],
)
def test_azure_tts_calls_output_format_setter(fake_azure, fmt, expected_enum, expected_content_type):
    from app.providers.azure import AzureTTS

    result = AzureTTS().synthesize("hello", voice="en-US-JennyNeural", rate="normal", fmt=fmt)
    config = _FakeSynthesizer.last_config
    assert config.output_format_calls == [expected_enum], config.output_format_calls
    assert not hasattr(config, "speech_synthesis_output_format"), (
        "绝不能再退回属性赋值：SpeechConfig 没有该属性，赋值会静默失效（历史 bug）"
    )
    assert result.content_type == expected_content_type
    assert probe_audio(result.audio).container == "wav"  # 假 SDK 返回的是真 WAV 字节


def test_azure_tts_raises_when_setter_missing(monkeypatch):
    """SDK 版本不兼容（没有 setter）时必须报错，而不是静默用默认 16kHz 格式。"""
    from app.errors import ProviderError
    from app.providers.azure import AzureTTS

    class NoSetterConfig(_FakeSpeechConfig):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.set_speech_synthesis_output_format = None  # 显式屏蔽

    class SDK(_FakeSpeechSDK):
        SpeechConfig = NoSetterConfig

    monkeypatch.setenv("AZURE_SPEECH_KEY", "fake-key")
    monkeypatch.setenv("AZURE_SPEECH_REGION", "eastasia")
    reset_settings_cache()
    monkeypatch.setattr("app.providers.azure._speechsdk", lambda: SDK)
    try:
        with pytest.raises(ProviderError):
            AzureTTS().synthesize("hello", fmt="mp3")
    finally:
        reset_settings_cache()


# --------------------------------------------------------------------------------------
# 4. 真实 Azure（本机有 key 时）验证采样率/容器 == 请求格式
# --------------------------------------------------------------------------------------
def _real_azure_credentials() -> tuple[str, str] | None:
    """从 voice/.env 里取真实 key（测试进程默认隔离了 .env）。"""
    import os

    from app.config import _parse_env_line

    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.is_file():
        return None
    values: dict[str, str] = {}
    for line in env_file.read_text(encoding="utf-8").splitlines():
        parsed = _parse_env_line(line)
        if parsed:
            values[parsed[0]] = parsed[1]
    key = os.environ.get("AZURE_SPEECH_KEY") or values.get("AZURE_SPEECH_KEY") or ""
    region = os.environ.get("AZURE_SPEECH_REGION") or values.get("AZURE_SPEECH_REGION") or ""
    if not key or not region:
        return None
    return key, region


@pytest.mark.skipif(
    bool(__import__("os").environ.get("VOICE_SKIP_REAL_AZURE")),
    reason="VOICE_SKIP_REAL_AZURE=1 时跳过（会真实调用 Azure，产生少量费用）",
)
@pytest.mark.skipif(_real_azure_credentials() is None, reason="需要真实 Azure key（voice/.env）")
def test_real_azure_tts_format_matches_request(tmp_path, monkeypatch):
    """① 真实 provider 返回的音频容器/采样率必须与请求格式相符。

    这条用例会真调 Azure（2 次短文本）；用 tmp_path 做 DATA_DIR，绝不碰 voice/data/**。
    """
    credentials = _real_azure_credentials()
    assert credentials is not None
    key, region = credentials
    monkeypatch.setenv("AZURE_SPEECH_KEY", key)
    monkeypatch.setenv("AZURE_SPEECH_REGION", region)
    monkeypatch.setenv("ENV_FILE", str(tmp_path / "none.env"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("MODEL_CACHE_DIR", str(tmp_path / "models"))
    reset_settings_cache()
    try:
        from app.providers.azure import AzureTTS

        provider = AzureTTS()
        mp3 = provider.synthesize("Hi there.", voice="en-US-JennyNeural", rate="normal", fmt="mp3")
        wav = provider.synthesize("Hi there.", voice="en-US-JennyNeural", rate="normal", fmt="wav")
    finally:
        reset_settings_cache()

    mp3_probe = probe_audio(mp3.audio)
    wav_probe = probe_audio(wav.audio)

    assert mp3.content_type == "audio/mpeg"
    assert mp3_probe.container == "mp3" or mp3_probe.codec.startswith("mp3"), mp3_probe
    assert wav.content_type == "audio/wav"
    assert wav_probe.container == "wav", wav_probe
    assert wav_probe.codec == "pcm_s16le", wav_probe
    # 修复前是 16kHz（发闷）；修复后请求的是 24kHz 档位
    assert mp3_probe.sample_rate >= 24000, mp3_probe
    assert wav_probe.sample_rate >= 24000, wav_probe
    assert mp3.audio != wav.audio, "两种格式必须是不同产物"
