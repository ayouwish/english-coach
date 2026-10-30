"""配置解析：PROVIDER_MODE -> provider 组合，以及无密钥时的 cloud/local 行为。"""

from __future__ import annotations

import sys

import pytest

from app.cache import reset_cache
from app.config import Settings, get_settings, reset_settings_cache
from app.providers.registry import build_providers, reset_providers
from tests.conftest import post_pronounce


def _with_env(monkeypatch, **env):
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    reset_settings_cache()
    reset_providers()
    reset_cache()


def test_default_mode_is_mock(monkeypatch):
    for key in ("PROVIDER_MODE", "VOICE_PA_PROVIDER", "VOICE_ASR_PROVIDER", "VOICE_TTS_PROVIDER"):
        monkeypatch.delenv(key, raising=False)
    reset_settings_cache()
    settings = get_settings()
    assert settings.mode == "mock"
    assert (settings.asr_provider, settings.pa_provider, settings.tts_provider) == ("mock", "mock", "mock")
    assert settings.llm_provider == "template"
    assert settings.llm_enabled is False


def test_invalid_mode_falls_back_to_mock(monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="turbo")
    assert get_settings().mode == "mock"


@pytest.mark.parametrize(
    "mode,expected",
    [
        ("mock", ("mock", "mock", "mock")),
        ("local", ("local", "local", "piper")),  # task-20：全本地；GOP 需 VOICE_PA_PROVIDER=gop 显式启用
        ("cloud", ("azure", "azure", "azure")),
        ("hybrid", ("local", "local", "piper")),  # 无 azure key -> 本地兜底（PA 用词级，GOP 显式启用）
    ],
)
def test_mode_provider_matrix(monkeypatch, mode, expected):
    _with_env(monkeypatch, PROVIDER_MODE=mode)
    settings = get_settings()
    assert (settings.asr_provider, settings.pa_provider, settings.tts_provider) == expected


def test_cloud_mode_without_azure_key_returns_503_not_mock(client, monkeypatch, sweep):
    """task-44：cloud 模式没有 AZURE_SPEECH_KEY 时**禁止静默回落 mock 返回 200** → 503 provider_unavailable。"""
    monkeypatch.delenv("AZURE_SPEECH_KEY", raising=False)
    _with_env(monkeypatch, PROVIDER_MODE="cloud")
    health = client.get("/v1/health").json()
    assert health["providers"]["pa"] == "azure"  # 配置值如实上报
    assert health["degraded"]["pa"]["configured"] == "azure"
    assert health["degraded"]["pa"]["effective"] == "none"
    response = post_pronounce(client, sweep, "I think the weather is really nice today.")
    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == "provider_unavailable"
    assert "重建镜像" in body["error"]["message"] or "build voice" in body["error"]["message"]


def test_local_mode_capabilities_and_lazy_model_load(client, monkeypatch):
    _with_env(monkeypatch, PROVIDER_MODE="local")
    health = client.get("/v1/health").json()
    assert health["providers"]["pa"] == "local"
    assert health["providers"]["tts"] == "piper"
    assert health["capabilities"]["phoneme_level"] is False, "默认 local PA 是词级（GOP 不可用，见 README §13.4）"
    assert health["capabilities"]["intonation_curve"] is True
    assert "faster_whisper" not in sys.modules, "没有真正评测前不允许加载本地模型"
    assert "onnxruntime" not in sys.modules, "Piper/GOP 的 onnxruntime 必须惰性导入"


def test_local_pa_declares_phoneme_level_unavailable(monkeypatch):
    from app.providers.local import LocalPA

    assert LocalPA.capabilities.phoneme_level is False
    assert LocalPA.capabilities.prosody is False
    assert LocalPA.capabilities.nbest_phonemes is False


def test_settings_data_and_model_dirs_are_writable(monkeypatch, tmp_path):
    _with_env(monkeypatch, DATA_DIR=str(tmp_path / "d"), MODEL_CACHE_DIR=str(tmp_path / "m"))
    settings = Settings.__dataclass_fields__  # noqa: F841  (smoke: dataclass intact)
    settings = get_settings()
    assert settings.audio_dir.exists()
    assert settings.model_cache_dir.exists()


def test_capabilities_shape_for_mock():
    reset_settings_cache()
    reset_providers()
    providers = build_providers()
    assert providers.capabilities == {
        "phoneme_level": True,
        "prosody": True,
        "intonation_curve": True,
        "nbest_phonemes": True,
        "ssml": False,
    }
