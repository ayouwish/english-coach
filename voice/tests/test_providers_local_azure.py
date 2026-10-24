"""local / azure provider 的独立验证（不下载模型、不联网）。

重点：local provider 只能给**词级**分数，并且必须显式声明 phoneme_level_unavailable；
azure provider 在没装 SDK / 没 key 时只能抛 ProviderUnavailable，不能把请求打成 500。
"""

from __future__ import annotations

import sys

import pytest

from app.audio_io import decode_audio
from app.errors import ProviderUnavailable
from app.providers.base import WordTiming
from app.providers.local import LocalPA
from app.synth import synthesize_speech_wav


@pytest.fixture
def clip():
    return decode_audio(synthesize_speech_wav("I think the weather is nice"))


def test_local_pa_is_word_level_with_warning(monkeypatch, clip):
    """monkeypatch 掉 whisper：验证词级打分 + 显式 warning 的逻辑本身正确。"""
    from app.providers import local as local_module

    def fake_transcribe(_clip, language: str = "en"):
        return (
            "i think the weather is nice",
            [
                WordTiming("i", 0, 100, 0.95),
                WordTiming("think", 100, 340, 0.62),
                WordTiming("the", 340, 420, 0.88),
                WordTiming("weather", 420, 760, 0.80),
                WordTiming("is", 760, 820, 0.90),
                WordTiming("nice", 820, 1100, 0.86),
            ],
            {"model": "fake"},
        )

    monkeypatch.setattr(local_module, "transcribe_words", fake_transcribe)
    result = LocalPA().assess(clip, "I think the weather is nice", granularity="phoneme")

    assert result.provider == "local"
    assert result.granularity == "word", "provider 能力不足时必须自动降级为词级"
    assert "phoneme_level_unavailable" in result.warnings
    assert result.words
    for word in result.words:
        assert word.phonemes == [], "红线：local 绝不允许输出音素级分数"
        assert word.score is not None
    assert result.scores.pron is not None
    assert result.scores.prosody is None  # 由 route 的语调模块补齐


def test_local_pa_detects_omission_and_pause(monkeypatch, clip):
    from app.providers import local as local_module

    def fake_transcribe(_clip, language: str = "en"):
        # 漏掉 "weather"，并在中间留一个 600ms 停顿
        return (
            "i think the is nice",
            [
                WordTiming("i", 0, 100, 0.95),
                WordTiming("think", 100, 340, 0.62),
                WordTiming("the", 340, 420, 0.88),
                WordTiming("is", 1020, 1080, 0.90),
                WordTiming("nice", 1080, 1360, 0.86),
            ],
            {"model": "fake"},
        )

    monkeypatch.setattr(local_module, "transcribe_words", fake_transcribe)
    result = LocalPA().assess(clip, "I think the weather is nice")

    types = {issue.type for issue in result.issues}
    assert "Omission" in types, types
    omission = next(issue for issue in result.issues if issue.type == "Omission")
    assert omission.word == "weather"
    assert omission.hint_key == "omission"
    assert 0.0 <= result.scores.completeness < 100.0
    assert result.provider_meta["reference_alignment"] == "difflib"


def test_local_pa_unscripted_has_no_completeness(monkeypatch, clip):
    from app.providers import local as local_module

    monkeypatch.setattr(
        local_module,
        "transcribe_words",
        lambda _clip, language="en": ("hello there", [WordTiming("hello", 0, 200, 0.9), WordTiming("there", 200, 420, 0.8)], {}),
    )
    result = LocalPA().assess(clip, "", mode="unscripted")
    assert result.scores.completeness is None
    assert result.granularity == "word"
    assert "phoneme_level_unavailable" in result.warnings


def test_local_provider_requires_whisper_installed(clip, monkeypatch):
    """没装 faster-whisper 时必须是 ProviderUnavailable（可被链式兜底捕获），而不是崩。"""
    from app.providers import local as local_module

    local_module._MODEL_CACHE.clear()
    monkeypatch.setitem(sys.modules, "faster_whisper", None)  # 模拟 import 失败
    with pytest.raises(ProviderUnavailable):
        local_module.transcribe_words(clip)


def test_azure_provider_module_is_lazy(tmp_path):
    """导入 azure provider 模块 / 起服务都不该拉起 SDK（干净解释器里验证）。"""
    from tests._lazy_probe import run_probe

    result = run_probe(tmp_path)
    assert result.returncode == 0, result.stderr
    assert "LAZY_OK" in result.stdout


def test_azure_provider_fails_soft(clip):
    """没装 SDK 或没配 key 时，三个 provider 都只能抛 ProviderUnavailable（不崩、不 500）。"""
    from app.providers.azure import AzureASR, AzurePA, AzureTTS

    for provider in (AzurePA(), AzureASR(), AzureTTS()):
        with pytest.raises(ProviderUnavailable):
            if isinstance(provider, AzurePA):
                provider.assess(clip, "hello")
            elif isinstance(provider, AzureASR):
                provider.recognize(clip)
            else:
                provider.synthesize("hello")


def test_azure_capabilities_match_contract_matrix():
    from app.providers.azure import AzurePA, AzureTTS

    assert AzurePA.capabilities.phoneme_level is True
    assert AzurePA.capabilities.prosody is True
    assert AzurePA.capabilities.nbest_phonemes is True
    assert AzureTTS.capabilities.ssml is True
