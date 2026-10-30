"""task-44：禁止静默降级为 mock（线上事故回归）+ Azure SDK 依赖防回归 + health 不谎报。

背景：`requirements.txt` 曾漏掉 `--extra azure`，线上镜像没有 Azure 语音 SDK → TTS/ASR/PA 全部
静默回落 mock 并返回 200（用户把合成音当示范音）；`/v1/health` 还显示 providers=azure（谎报）。
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from app.audio_io import pcm16_wav_bytes, probe_audio
from app.config import get_settings, reset_settings_cache
from app.errors import ProviderUnavailable
from app.providers.base import Capabilities
from app.providers.mock import MockPA
from app.providers.registry import ProviderSet, build_providers, provider_availability, reset_providers

ROOT = Path(__file__).resolve().parent.parent


def _with_env(monkeypatch, **env):
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    reset_settings_cache()
    reset_providers()


def _wav(seconds: float = 1.0) -> bytes:
    t = np.arange(int(16000 * seconds)) / 16000.0
    return pcm16_wav_bytes(0.25 * np.sin(2 * np.pi * 220.0 * t), 16000)


# --------------------------------------------------------------------------------------
# A. 依赖防回归：requirements.txt 必须带 azure extra；Dockerfile 必须有构建期断言
# --------------------------------------------------------------------------------------
def test_requirements_include_azure_sdk():
    text = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if line.startswith("azure-cognitiveservices-speech==")]
    assert lines, "requirements.txt 丢了 azure-cognitiveservices-speech（事故根因：uv export 没带 --extra azure）"
    assert any(line.split("==")[1][0].isdigit() for line in lines)


def test_dockerfile_asserts_azure_sdk_importable():
    text = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "import azure.cognitiveservices.speech" in text, (
        "Dockerfile 必须有构建期 import 断言：SDK 缺失时镜像构建直接失败（task-44 防回归）"
    )
    assert "extra azure" in text or "--extra azure" in text, "Dockerfile 注释应说明 requirements 由 --extra azure 导出"


# --------------------------------------------------------------------------------------
# B. 非 mock 模式禁止静默降级：TTS/ASR/PA 均 503 provider_unavailable
# --------------------------------------------------------------------------------------
def test_cloud_mode_without_provider_returns_503_not_mock(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="cloud", AZURE_SPEECH_KEY=None)

    response = client.post("/v1/tts", json={"text": "think", "format": "wav"})
    assert response.status_code == 503, f"绝不能回落 mock 返回 200（实际 {response.status_code}）"
    body = response.json()
    assert body["error"]["code"] == "provider_unavailable"
    message = body["error"]["message"]
    assert "azure" in message.lower()
    assert "重建镜像" in message or "build voice" in message

    # 503 不得写入任何缓存
    cache_root = get_settings().data_dir / "cache"
    assert not list(cache_root.rglob("*.wav")) if cache_root.is_dir() else True


def test_asr_returns_503_when_provider_unavailable(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="cloud", AZURE_SPEECH_KEY=None)
    response = client.post("/v1/asr", files={"audio": ("a.wav", _wav(), "audio/wav")})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


def test_pronounce_returns_503_when_provider_unavailable(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="cloud", AZURE_SPEECH_KEY=None)
    response = client.post(
        "/v1/pronounce",
        files={"audio": ("a.wav", _wav(), "audio/wav")},
        data={"reference_text": "hello"},
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


def test_hybrid_mode_azure_sdk_missing_returns_503_with_actionable_message(client, monkeypatch):
    """复现线上事故：key 配了、但 SDK 缺失，且**本机也没有任何可用真实兜底**（NAS 的情况）→ 503。"""
    _with_env(monkeypatch, PROVIDER_MODE="hybrid", AZURE_SPEECH_KEY="fake-key", AZURE_SPEECH_REGION="eastasia")

    def no_sdk():
        raise ProviderUnavailable(
            "azure-cognitiveservices-speech is not installed; run `uv sync --extra azure`", provider="azure"
        )

    monkeypatch.setattr("app.providers.azure._speechsdk", no_sdk)

    from app.providers.mock import MockTTS

    failing = _FailingAzureTTS()
    mock = MockTTS()
    base = build_providers()
    provider_set = ProviderSet(
        asr=base.asr, pa=base.pa or MockPA(), tts=failing,
        asr_chain=base.asr_chain, pa_chain=base.pa_chain,
        tts_chain=[failing, mock],
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)

    response = client.post("/v1/tts", json={"text": "think", "format": "wav"})
    assert response.status_code == 503
    message = response.json()["error"]["message"]
    assert "not installed" in message, message
    assert "重建镜像" in message


def test_hybrid_real_fallback_is_allowed(client, monkeypatch):
    """hybrid 下 azure 不可用但**有真实本地兜底**（piper 等）→ 允许 200（不能把真语音也禁掉）。"""
    _with_env(monkeypatch, PROVIDER_MODE="hybrid", AZURE_SPEECH_KEY="fake-key", AZURE_SPEECH_REGION="eastasia")
    azure = _FailingAzureTTS()
    piper = _LocalTTS22k()
    base = build_providers()
    provider_set = ProviderSet(
        asr=base.asr, pa=base.pa or MockPA(), tts=azure,
        asr_chain=base.asr_chain, pa_chain=base.pa_chain, tts_chain=[azure, piper],
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    response = client.post("/v1/tts", json={"text": "think", "format": "wav"})
    assert response.status_code == 200
    assert response.headers["X-TTS-Provider"] == "piper"


def test_mock_mode_keeps_working(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", AZURE_SPEECH_KEY=None)
    response = client.post("/v1/tts", json={"text": "think", "format": "wav"})
    assert response.status_code == 200
    assert response.headers["X-TTS-Provider"] == "mock"


# --------------------------------------------------------------------------------------
# C. health 不谎报：degraded 如实上报（configured/effective/reason）
# --------------------------------------------------------------------------------------
def test_health_reports_degraded_honestly(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="cloud", AZURE_SPEECH_KEY=None)
    body = client.get("/v1/health").json()

    assert body["providers"]["tts"] == "azure"  # 配置值不变（契约字段语义不动）
    assert body["providers_effective"]["tts"] == "none"
    degraded = body["degraded"]
    assert set(degraded) == {"asr", "pa", "tts"}
    assert degraded["tts"]["configured"] == "azure"
    assert degraded["tts"]["effective"] == "none"
    assert "AZURE_SPEECH_KEY" in degraded["tts"]["reason"]


def test_health_degraded_reports_missing_sdk(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="hybrid", AZURE_SPEECH_KEY="fake-key", AZURE_SPEECH_REGION="eastasia")

    def no_sdk():
        raise ProviderUnavailable("azure-cognitiveservices-speech is not installed", provider="azure")

    monkeypatch.setattr("app.providers.azure._speechsdk", no_sdk)
    body = client.get("/v1/health").json()
    assert "not installed" in body["degraded"]["asr"]["reason"]


def test_health_healthy_in_mock_mode(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="mock", AZURE_SPEECH_KEY=None)
    body = client.get("/v1/health").json()
    assert body["degraded"] == {}
    assert body["providers_effective"] == {"asr": "mock", "pa": "mock", "tts": "mock", "llm": "template"}


# --------------------------------------------------------------------------------------
# D. 缓存污染：实际产出者与 key 里的 provider 不一致时不得写缓存
# --------------------------------------------------------------------------------------
class _FailingAzureTTS:
    name = "azure"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice=None, rate="normal", fmt="mp3", ssml=None):
        self.calls += 1
        raise ProviderUnavailable("azure-cognitiveservices-speech is not installed", provider="azure")


class _LocalTTS22k:
    name = "piper"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice=None, rate="normal", fmt="mp3", ssml=None):
        self.calls += 1
        sr = 22050
        t = np.arange(int(sr * 0.4)) / sr
        data = pcm16_wav_bytes(0.25 * np.sin(2 * np.pi * 220.0 * t), sr)
        return SimpleNamespace(
            audio=data, content_type="audio/wav", provider=self.name,
            duration_ms=probe_audio(data).duration_ms, format="wav",
        )


def test_producer_mismatch_is_not_cached(client, monkeypatch):
    """hybrid 回落到 piper（真实 provider，允许 200），但**不能**把 piper 音频写进 azure 的缓存 key。"""
    _with_env(monkeypatch, PROVIDER_MODE="hybrid", AZURE_SPEECH_KEY="fake-key", AZURE_SPEECH_REGION="eastasia")
    azure = _FailingAzureTTS()
    piper = _LocalTTS22k()
    base = build_providers()
    provider_set = ProviderSet(
        asr=base.asr,
        pa=base.pa or MockPA(),
        tts=azure,
        asr_chain=base.asr_chain,
        pa_chain=base.pa_chain,
        tts_chain=[azure, piper],
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)

    first = client.post("/v1/tts", json={"text": "think", "format": "wav"})
    assert first.status_code == 200
    assert first.headers["X-TTS-Provider"] == "piper"
    assert azure.calls == 1 and piper.calls == 1

    # azure 的 key 下不得出现 piper 的音频
    cache_root = get_settings().data_dir / "cache" / "audio"
    assert not list(cache_root.glob("*.wav")), "实际产出者与 key provider 不一致时不得写缓存"

    second = client.post("/v1/tts", json={"text": "think", "format": "wav"})
    assert second.status_code == 200
    assert piper.calls == 2, "未写缓存 → 第二次必须重新合成，而不是命中污染缓存"


# --------------------------------------------------------------------------------------
# E. provider_availability 本身
# --------------------------------------------------------------------------------------
def test_provider_availability_reports_reasons():
    ok, reason = provider_availability("tts", "mock")
    assert ok and reason is None
    ok, reason = provider_availability("tts", "no-such-provider")
    assert not ok and "未知 provider" in reason
