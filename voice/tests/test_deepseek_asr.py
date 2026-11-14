"""task-112：DeepSeek ASR（分片 / WAV 头 / 错误映射 / 回退 / usage），全部假 HTTP。"""

from __future__ import annotations

import io
import json
import wave

import httpx
import numpy as np
import pytest

from app.audio_io import AudioClip, decode_audio, pcm16_wav_bytes
from app.config import get_settings, reset_settings_cache
from app.errors import (
    ProviderError,
    ProviderTimeout,
    ProviderUnavailable,
    RateLimited,
)
from app.providers.deepseek_asr import DeepSeekASR, _limit_bytes
from app.providers.registry import asr_chain_for, asr_effective, build_providers, reset_providers

TICKS = 10000


def _with_env(monkeypatch, **env):
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, str(value))
    reset_settings_cache()
    reset_providers()


@pytest.fixture
def ds_env(monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", ASR_PROVIDER="deepseek", DEEPSEEK_ASR_API_KEY="ds-key")
    yield
    reset_settings_cache()
    reset_providers()


class _Response:
    def __init__(self, status_code: int = 200, payload=None, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class _FakeHttp:
    def __init__(self, responses, on_empty=None):
        self.responses = list(responses)
        self.on_empty = on_empty
        self.calls: list[dict] = []

    def __call__(self, url, headers=None, files=None, timeout=None, data=None):
        self.calls.append({"url": url, "headers": headers, "files": files, "timeout": timeout})
        if not self.responses:
            if self.on_empty is not None:
                return self.on_empty(len(self.calls))
            return _Response(200, {"text": ""})
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _patch_http(monkeypatch, responses, on_empty=None):
    fake = _FakeHttp(responses, on_empty=on_empty)
    monkeypatch.setattr("app.providers.deepseek_asr.httpx.post", fake)
    sleeps: list[float] = []
    monkeypatch.setattr("app.providers.deepseek_asr.time.sleep", lambda seconds: sleeps.append(seconds))
    return fake, sleeps


def _clip(seconds: float = 2.0, sample_rate: int = 16000) -> AudioClip:
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    return AudioClip(0.3 * np.sin(2 * np.pi * 220 * t).astype(np.float32), sample_rate)


def _speechy(seconds: float = 240.0, sample_rate: int = 16000) -> np.ndarray:
    samples = np.zeros(int(seconds * sample_rate), dtype=np.float32)
    for start in range(0, int(seconds) - 2, 4):
        samples[start * sample_rate : (start + 1) * sample_rate] = 0.1
    return samples


def _wav_info(data: bytes) -> tuple[int, int, int]:
    with wave.open(io.BytesIO(data), "rb") as handle:
        return handle.getnchannels(), handle.getsampwidth(), handle.getframerate()


def _post_asr(client, language: str = "en", provider: str | None = None, audio: bytes | None = None):
    form = {"language": language}
    if provider:
        form["provider"] = provider
    return client.post(
        "/v1/asr",
        files={"audio": ("a.wav", audio or pcm16_wav_bytes(np.zeros(16000, dtype=np.float32), 16000), "audio/wav")},
        data=form,
    )


# --------------------------------------------------------------------------------------
# 请求形状 / 单片
# --------------------------------------------------------------------------------------
def test_deepseek_request_shape_and_wav_header(ds_env, monkeypatch):
    fake, _ = _patch_http(monkeypatch, [_Response(200, {"text": "Hello world.", "duration_ms": 2000})])
    result = DeepSeekASR().recognize(_clip(2.0), language="en-US")
    assert result.text == "Hello world."
    assert result.provider == "deepseek"
    assert result.duration_ms == pytest.approx(2000, abs=20)
    assert result.words == [] and result.warnings == []
    call = fake.calls[0]
    assert call["url"] == "https://api.deepseek.com/v1/tools/asr"
    assert call["headers"]["Authorization"] == "Bearer ds-key"
    audio_bytes = call["files"]["file"][1]
    assert _wav_info(audio_bytes) == (1, 2, 16000), "必须是 16k/16bit/mono WAV"
    assert call["timeout"] == get_settings().deepseek_asr_timeout_s


def test_deepseek_base_url_custom(monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", DEEPSEEK_ASR_API_KEY="k",
              DEEPSEEK_ASR_BASE_URL="https://example.com/v1")
    fake, _ = _patch_http(monkeypatch, [_Response(200, {"text": "ok"})])
    DeepSeekASR().recognize(_clip(1.0))
    assert fake.calls[0]["url"] == "https://example.com/v1/tools/asr"


def test_deepseek_missing_key_raises_unavailable(monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", DEEPSEEK_ASR_API_KEY=None, LLM_API_KEY=None)
    with pytest.raises(ProviderUnavailable):
        DeepSeekASR().recognize(_clip(1.0))


# --------------------------------------------------------------------------------------
# 分片 / 拼接 / ≤8MiB
# --------------------------------------------------------------------------------------
def test_long_audio_segmented_and_text_joined(ds_env, monkeypatch):
    fake, _ = _patch_http(monkeypatch, [], on_empty=lambda n: _Response(200, {"text": f"part {n}"}))
    result = DeepSeekASR().recognize(AudioClip(_speechy(240.0), 16000), language="zh-CN")
    assert len(fake.calls) >= 3, f"240s 应切成多片，实际 {len(fake.calls)}"
    assert result.warnings == ["segmented"]
    assert result.provider_meta["segments"] == len(fake.calls)
    assert result.text == " ".join(f"part {i}" for i in range(1, len(fake.calls) + 1))
    for call in fake.calls:
        chunk = call["files"]["file"][1]
        assert _wav_info(chunk) == (1, 2, 16000)
        assert decode_audio(chunk).duration_s <= 110.5, "单片必须 ≤110s（DeepSeek 上限 120s）"
        assert len(chunk) <= 8 * 1024 * 1024


def test_chunk_bytes_limited_to_max(ds_env, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", DEEPSEEK_ASR_API_KEY="k",
              DEEPSEEK_ASR_MAX_BYTES=str(200 * 1024), DEEPSEEK_ASR_CHUNK_SECONDS="110")
    fake, _ = _patch_http(monkeypatch, [], on_empty=lambda n: _Response(200, {"text": "x"}))
    DeepSeekASR().recognize(_clip(30.0))
    assert len(fake.calls) >= 2, "单片超过 200KB 时应再切"
    for call in fake.calls:
        assert len(call["files"]["file"][1]) <= 200 * 1024


def test_limit_bytes_unit():
    chunks = [np.zeros(16000 * 10, dtype=np.float32)]
    limited = _limit_bytes(chunks, 16000, 100_000)
    assert len(limited) >= 2
    assert sum(chunk.size for chunk in limited) == chunks[0].size
    for chunk in limited:
        assert len(pcm16_wav_bytes(chunk, 16000)) <= 100_000


# --------------------------------------------------------------------------------------
# 错误映射 / 重试
# --------------------------------------------------------------------------------------
@pytest.mark.parametrize("status,expected", [
    (429, RateLimited),
    (503, ProviderUnavailable),
    (504, ProviderTimeout),
    (400, ProviderError),
])
def test_error_mapping(ds_env, monkeypatch, status, expected):
    _patch_http(monkeypatch, [_Response(status, {"error": {"message": "boom"}})] * 5)
    with pytest.raises(expected):
        DeepSeekASR().recognize(_clip(1.0))


def test_rate_limit_retries_then_succeeds(ds_env, monkeypatch):
    fake, sleeps = _patch_http(monkeypatch, [_Response(429, {}), _Response(429, {}), _Response(200, {"text": "ok"})])
    result = DeepSeekASR().recognize(_clip(1.0))
    assert result.text == "ok" and len(fake.calls) == 3
    assert sleeps == [1.0, 2.0]


def test_timeout_maps_to_provider_timeout(ds_env, monkeypatch):
    _patch_http(monkeypatch, [httpx.ReadTimeout("slow")])
    with pytest.raises(ProviderTimeout):
        DeepSeekASR().recognize(_clip(1.0))


def test_400_marks_no_fallback(ds_env, monkeypatch):
    _patch_http(monkeypatch, [_Response(400, {"error": {"message": "bad audio"}})])
    with pytest.raises(ProviderError) as exc_info:
        DeepSeekASR().recognize(_clip(1.0))
    assert getattr(exc_info.value, "no_fallback", False) is True


# --------------------------------------------------------------------------------------
# 路由 / 回退链 / usage / health
# --------------------------------------------------------------------------------------
class _FakeAzure:
    name = "azure"

    def recognize(self, clip, language="en", prompt=None):
        from app.providers.base import ASRResult

        return ASRResult(text="azure fallback text", language=language, duration_ms=clip.duration_ms, provider="azure")


def _route_env_with_azure_fallback(monkeypatch, fallback: bool = True):
    _with_env(
        monkeypatch,
        PROVIDER_MODE="cloud",
        ASR_PROVIDER="deepseek",
        ASR_FALLBACK="1" if fallback else "0",
        DEEPSEEK_ASR_API_KEY="ds-key",
        AZURE_SPEECH_KEY="azure-key",
        AZURE_SPEECH_REGION="eastasia",
    )
    from app.providers import registry

    real_make = registry._make

    def fake_make(kind, name):
        if kind == "asr" and name == "azure":
            return _FakeAzure()
        return real_make(kind, name)

    monkeypatch.setattr(registry, "_make", fake_make)


def test_route_fallback_from_deepseek_to_azure(client, monkeypatch):
    _route_env_with_azure_fallback(monkeypatch)
    _patch_http(monkeypatch, [_Response(503, {}), _Response(503, {}), _Response(503, {})])
    response = _post_asr(client, language="en")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "azure"
    assert body["fallback_from"] == "deepseek"
    assert "provider_fallback" in body["warnings"]
    assert body["usage"] == {"asr_seconds": 1.0}


def test_route_no_fallback_when_disabled(client, monkeypatch):
    _route_env_with_azure_fallback(monkeypatch, fallback=False)
    _patch_http(monkeypatch, [_Response(503, {}), _Response(503, {}), _Response(503, {})])
    response = _post_asr(client, language="en")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


def test_route_deepseek_success_usage(client, monkeypatch, ds_env):
    _patch_http(monkeypatch, [_Response(200, {"text": "你好，世界。", "duration_ms": 1000})])
    response = _post_asr(client, language="zh")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "deepseek"
    assert body["text"] == "你好，世界。"
    assert body["usage"] == {"asr_seconds": 1.0}
    assert "fallback_from" not in body


def test_health_reports_deepseek(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", ASR_PROVIDER="deepseek", DEEPSEEK_ASR_API_KEY="k")
    caps = client.get("/v1/health").json()["capabilities"]
    assert "deepseek" in caps["asr_providers"]
    assert caps["asr_providers"] == ["azure", "zhipu", "deepseek"]
    assert caps["asr_effective"] == {"zh": "deepseek", "en": "deepseek"}
    assert caps["asr_fallback"] is True


def test_chain_selection_unit(monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", ASR_PROVIDER="deepseek", DEEPSEEK_ASR_API_KEY="k")
    providers = build_providers()
    en_chain = asr_chain_for(providers, "en-US", None)
    assert en_chain[0].name == "deepseek"
    assert [provider.name for provider in en_chain][-1] == "mock"
    assert asr_effective(providers) == {"zh": "deepseek", "en": "deepseek"}
