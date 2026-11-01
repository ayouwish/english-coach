"""task-75：智谱 GLM-ASR（中文长音频）+ /v1/asr provider 选择。

全部假 httpx / 假 SDK，不联网。
"""

from __future__ import annotations

import io
import time

import httpx
import numpy as np
import pytest

from app.audio_io import AudioClip, decode_audio, pcm16_wav_bytes
from app.config import get_settings, reset_settings_cache
from app.errors import ProviderError, ProviderTimeout, ProviderUnavailable
from app.providers.base import ASRResult
from app.providers.registry import ProviderSet, asr_chain_for, build_providers, reset_providers
from app.providers.zhipu_asr import ZhipuASR, split_audio_by_silence


def _wav(seconds: float = 1.0, sample_rate: int = 16000, freq: float = 220.0) -> bytes:
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    return pcm16_wav_bytes((0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32), sample_rate)


def _clip(seconds: float = 2.0, sample_rate: int = 16000) -> AudioClip:
    return decode_audio(_wav(seconds, sample_rate), sample_rate, 300.0)


def _speechy_samples(seconds: float = 120.0, sample_rate: int = 16000) -> np.ndarray:
    samples = np.zeros(int(seconds * sample_rate), dtype=np.float32)
    for start in range(0, int(seconds) - 2, 4):
        samples[start * sample_rate : (start + 1) * sample_rate] = 0.1
    return samples


class _Response:
    def __init__(self, status_code: int = 200, payload=None, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class _FakeHttp:
    def __init__(self, responses, on_empty=None):
        self.responses = list(responses)
        self.on_empty = on_empty
        self.calls: list[dict] = []

    def __call__(self, url, headers=None, data=None, files=None, timeout=None):
        self.calls.append({"url": url, "headers": headers, "data": dict(data or {}), "files": files, "timeout": timeout})
        if not self.responses:
            if self.on_empty is not None:
                return self.on_empty(len(self.calls))
            return _Response(200, {"text": ""})
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _with_env(monkeypatch, **env):
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    reset_settings_cache()
    reset_providers()


@pytest.fixture
def zhipu_env(monkeypatch):
    _with_env(
        monkeypatch,
        PROVIDER_MODE="mock",
        ASR_PROVIDER="auto",
        ZHIPU_ASR_API_KEY="test-zhipu-key",
        IMAGE_API_KEY=None,
    )
    yield
    reset_settings_cache()
    reset_providers()


def _patch_http(monkeypatch, responses, on_empty=None):
    fake = _FakeHttp(responses, on_empty=on_empty)
    monkeypatch.setattr("app.providers.zhipu_asr.httpx.post", fake)
    sleeps: list[float] = []
    monkeypatch.setattr("app.providers.zhipu_asr.time.sleep", lambda seconds: sleeps.append(seconds))
    return fake, sleeps


def _post_asr(client, language: str = "zh", provider: str | None = None, audio: bytes | None = None):
    form = {"language": language}
    if provider is not None:
        form["provider"] = provider
    return client.post(
        "/v1/asr",
        files={"audio": ("a.wav", audio or _wav(1.0), "audio/wav")},
        data=form,
    )


# --------------------------------------------------------------------------------------
# A. 请求形状（官方文档：POST {base}/audio/transcriptions，multipart file+model，Bearer）
# --------------------------------------------------------------------------------------
def test_zhipu_request_shape(zhipu_env, monkeypatch):
    fake, _ = _patch_http(monkeypatch, [_Response(200, {"text": "你好，我是测试"})])
    settings = get_settings()
    result = ZhipuASR().recognize(_clip(2.0), language="zh-CN", prompt="之前的话")
    assert result.text == "你好，我是测试"
    assert result.provider == "zhipu"
    assert result.duration_ms == pytest.approx(2000, abs=20)
    assert result.words == [] and result.warnings == []

    call = fake.calls[0]
    assert call["url"] == "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions"
    assert call["headers"]["Authorization"] == "Bearer test-zhipu-key"
    assert call["data"]["model"] == "glm-asr-2512"
    assert call["data"]["stream"] == "false"
    assert call["data"]["prompt"] == "之前的话"
    assert "file" in call["files"]
    assert call["timeout"] == settings.zhipu_asr_timeout_s
    assert result.provider_meta["segments"] == 1


def test_zhipu_missing_key_raises_unavailable(monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", ZHIPU_ASR_API_KEY=None, IMAGE_API_KEY=None)
    with pytest.raises(ProviderUnavailable):
        ZhipuASR().recognize(_clip(1.0), language="zh")


def test_chinese_auto_uses_zhipu(client, zhipu_env, monkeypatch):
    fake, _ = _patch_http(monkeypatch, [_Response(200, {"text": "今天我和小明搭积木塔。"})])
    response = _post_asr(client, language="zh")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "zhipu"
    assert body["text"] == "今天我和小明搭积木塔。"
    assert body["language"] == "zh-CN"
    assert body["duration_ms"] == pytest.approx(1000, abs=30)
    assert len(fake.calls) == 1, "中文 auto 应只调智谱一次"
    assert "warnings" not in body


def test_english_auto_keeps_mode_primary(client, zhipu_env, monkeypatch):
    fake, _ = _patch_http(monkeypatch, [_Response(200, {"text": "should not be called"})])
    response = _post_asr(client, language="en")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "mock", "英文 auto 不应走智谱"
    assert fake.calls == []


def test_explicit_provider_override(client, zhipu_env, monkeypatch):
    fake, _ = _patch_http(monkeypatch, [_Response(200, {"text": "explicit zhipu"})])
    body = _post_asr(client, language="en", provider="zhipu").json()
    assert body["provider"] == "zhipu" and body["text"] == "explicit zhipu"
    assert len(fake.calls) == 1


def test_explicit_azure_override(client, zhipu_env, monkeypatch):
    from app.providers import registry

    calls: list[str] = []

    class FakeAzureASR:
        name = "azure"

        def recognize(self, clip, language="en", prompt=None):
            calls.append(language)
            return ASRResult(text="azure result", language=language, duration_ms=clip.duration_ms, provider="azure")

    real_make = registry._make

    def fake_make(kind, name):
        if kind == "asr" and name == "azure":
            return FakeAzureASR()
        return real_make(kind, name)

    monkeypatch.setattr(registry, "_make", fake_make)
    fake_http, _ = _patch_http(monkeypatch, [])
    body = _post_asr(client, language="zh", provider="azure").json()
    assert body["provider"] == "azure" and body["text"] == "azure result"
    assert fake_http.calls == [], "显式 azure 时不应调智谱"


def test_bogus_provider_returns_400(client, zhipu_env, monkeypatch):
    _patch_http(monkeypatch, [])
    response = _post_asr(client, language="zh", provider="whisper")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"


# --------------------------------------------------------------------------------------
# B. 无 key 回退（不静默冒充）
# --------------------------------------------------------------------------------------
def test_explicit_zhipu_without_key_falls_back_to_mock_honestly(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", ZHIPU_ASR_API_KEY=None, IMAGE_API_KEY=None)
    _patch_http(monkeypatch, [])
    body = _post_asr(client, language="zh", provider="zhipu").json()
    assert body["provider"] == "mock", "回退必须如实标注 provider，不能冒充 zhipu"
    assert body["text"]


def test_explicit_zhipu_without_key_cloud_mode_503(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="cloud", ASR_PROVIDER="auto", ZHIPU_ASR_API_KEY=None, IMAGE_API_KEY=None)
    _patch_http(monkeypatch, [])
    response = _post_asr(client, language="zh", provider="zhipu")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


# --------------------------------------------------------------------------------------
# C. 长音频切段（官方文档限制：音频 ≤ 30s）
# --------------------------------------------------------------------------------------
def test_segmentation_of_120s_audio(zhipu_env, monkeypatch):
    fake, _ = _patch_http(monkeypatch, [], on_empty=lambda n: _Response(200, {"text": f"part {n}"}))
    clip = AudioClip(_speechy_samples(120.0), 16000)
    result = ZhipuASR().recognize(clip, language="zh-CN")
    assert len(fake.calls) >= 4, f"120s 应切成多段，实际 {len(fake.calls)}"
    assert result.warnings == ["segmented"]
    assert result.duration_ms == pytest.approx(120000, abs=50)
    assert result.provider_meta["segments"] == len(fake.calls)
    assert result.text == " ".join(f"part {index}" for index in range(1, len(fake.calls) + 1))
    for call in fake.calls:
        chunk = call["files"]["file"][1]
        chunk_seconds = decode_audio(chunk).duration_s
        assert chunk_seconds <= 25.5, f"单段 {chunk_seconds:.1f}s 超过 GLM-ASR 30s 限制"


def test_long_audio_route_returns_segmented_warning(client, zhipu_env, monkeypatch):
    fake, _ = _patch_http(monkeypatch, [], on_empty=lambda n: _Response(200, {"text": f"part {n}"}))
    clip = AudioClip(_speechy_samples(120.0), 16000)
    wav = pcm16_wav_bytes(clip.samples, 16000)
    response = _post_asr(client, language="zh", audio=wav)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "zhipu"
    assert body["warnings"] == ["segmented"]
    assert body["duration_ms"] == pytest.approx(120000, abs=50)
    assert len(fake.calls) >= 4


def test_split_audio_by_silence_short_audio_untouched():
    samples = _speechy_samples(10.0)
    chunks = split_audio_by_silence(samples, 16000, 25.0)
    assert len(chunks) == 1
    assert chunks[0].size == samples.size


# --------------------------------------------------------------------------------------
# D. 重试 / 超时
# --------------------------------------------------------------------------------------
def test_429_retries_then_succeeds(zhipu_env, monkeypatch):
    fake, sleeps = _patch_http(
        monkeypatch,
        [_Response(429, {"error": {"code": "rate_limit", "message": "too many"}}), _Response(429, {}), _Response(200, {"text": "ok"})],
    )
    result = ZhipuASR().recognize(_clip(1.0), language="zh")
    assert result.text == "ok"
    assert len(fake.calls) == 3
    assert sleeps == [1.0, 2.0], "重试退避应为 1s/2s"


def test_429_exhausted_raises_provider_error(zhipu_env, monkeypatch):
    _patch_http(monkeypatch, [_Response(429, {}), _Response(429, {}), _Response(429, {})])
    with pytest.raises(ProviderError) as exc_info:
        ZhipuASR().recognize(_clip(1.0), language="zh")
    assert "3 attempts" in exc_info.value.message


def test_timeout_raises_provider_timeout(zhipu_env, monkeypatch):
    _patch_http(monkeypatch, [httpx.ReadTimeout("slow")])
    with pytest.raises(ProviderTimeout):
        ZhipuASR().recognize(_clip(1.0), language="zh")


def test_4xx_is_not_retried(zhipu_env, monkeypatch):
    fake, sleeps = _patch_http(monkeypatch, [_Response(400, {"error": {"code": "invalid_request", "message": "bad wav"}})])
    with pytest.raises(ProviderError):
        ZhipuASR().recognize(_clip(1.0), language="zh")
    assert len(fake.calls) == 1 and sleeps == []


# --------------------------------------------------------------------------------------
# E. health capabilities
# --------------------------------------------------------------------------------------
def test_health_asr_matrix(client, zhipu_env, monkeypatch):
    caps = client.get("/v1/health").json()["capabilities"]
    assert caps["asr_providers"] == ["azure", "zhipu"]
    assert caps["asr_effective"]["zh"] == "zhipu", "配了智谱 key 时中文生效 provider 应为 zhipu"
    assert caps["asr_effective"]["en"] == "mock"


def test_asr_chain_selection_unit(monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", ASR_PROVIDER="auto", ZHIPU_ASR_API_KEY="k", IMAGE_API_KEY=None)
    providers = build_providers()
    zh_chain = asr_chain_for(providers, "zh-CN", None)
    en_chain = asr_chain_for(providers, "en-US", None)
    assert zh_chain[0].name == "zhipu"
    assert en_chain[0].name == "mock"
    assert [p.name for p in asr_chain_for(providers, "zh-CN", "azure")][0] == "azure"
