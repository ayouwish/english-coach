"""降级路径：provider 故意抛错/超时，必须返回 200 + warnings，而不是 500。

这是契约 §8「降级优先于报错」的硬性验收。
"""

from __future__ import annotations

import time

import pytest

from app import execution
from app.audio_io import decode_audio
from app.config import reset_settings_cache
from app.execution import run_chain
from app.llm import LLMOutcome
from app.providers.base import Capabilities, PAScores
from app.providers.mock import MockPA
from app.providers.registry import ProviderSet, build_providers, reset_providers
from tests.conftest import post_pronounce


class BrokenPA:
    name = "broken_pa"
    capabilities = Capabilities(phoneme_level=True)

    def assess(self, *args, **kwargs):
        raise RuntimeError("boom from PA provider")


class SlowPA:
    name = "slow_pa"
    capabilities = Capabilities(phoneme_level=True)

    def assess(self, *args, **kwargs):
        time.sleep(3.0)
        raise AssertionError("should have timed out")


class BrokenASR:
    name = "broken_asr"
    capabilities = Capabilities()

    def recognize(self, *args, **kwargs):
        raise RuntimeError("boom from ASR provider")


class BrokenTTS:
    name = "broken_tts"
    capabilities = Capabilities()

    def synthesize(self, *args, **kwargs):
        raise RuntimeError("boom from TTS provider")


def _patch_providers(monkeypatch, **overrides):
    base = build_providers()
    provider_set = ProviderSet(
        asr=overrides.get("asr", base.asr),
        pa=overrides.get("pa", base.pa),
        tts=overrides.get("tts", base.tts),
        asr_chain=overrides.get("asr_chain", base.asr_chain),
        pa_chain=overrides.get("pa_chain", base.pa_chain),
        tts_chain=overrides.get("tts_chain", base.tts_chain),
        mode=base.mode,
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    return provider_set


# --------------------------------------------------------------------------------------
# pronounce
# --------------------------------------------------------------------------------------
def test_pronounce_pa_provider_error_falls_back_to_mock(client, monkeypatch, sweep):
    broken = BrokenPA()
    _patch_providers(monkeypatch, pa=broken, pa_chain=[broken, MockPA()])
    response = post_pronounce(client, sweep, "I think the weather is really nice today.")
    assert response.status_code == 200  # 不是 500
    body = response.json()
    assert "provider_fallback" in body["warnings"]
    assert body["provider"] == "mock"
    assert body["scores"]["pron"] is not None
    assert "broken_pa" in body["provider_meta"].get("primary_error", "")


def test_pronounce_all_pa_providers_broken_still_returns_200(client, monkeypatch, sweep):
    _patch_providers(monkeypatch, pa=BrokenPA(), pa_chain=[BrokenPA()])
    response = post_pronounce(client, sweep, "I think the weather is really nice today.")
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "degraded"
    assert "provider_fallback" in body["warnings"]
    assert "phoneme_level_unavailable" in body["warnings"], "词级兜底必须显式声明没有音素级"
    assert body["granularity"] == "word"
    assert all(word["phonemes"] == [] for word in body["words"])
    assert body["scores"]["pron"] is not None


def test_pronounce_pa_timeout_falls_back(client, monkeypatch, sweep):
    monkeypatch.setitem(execution.TIMEOUTS, "pronounce", 0.4)
    _patch_providers(monkeypatch, pa=SlowPA(), pa_chain=[SlowPA(), MockPA()])
    response = post_pronounce(client, sweep, "I think the weather is really nice today.")
    assert response.status_code == 200
    body = response.json()
    assert "provider_fallback" in body["warnings"]
    assert "provider_timeout" in body["provider_meta"].get("primary_error", "")


def test_pronounce_tts_failure_does_not_break_reference_audio(client, monkeypatch, sweep):
    _patch_providers(monkeypatch, tts=BrokenTTS(), tts_chain=[BrokenTTS()])
    response = post_pronounce(client, sweep, "I think the weather is really nice today.")
    assert response.status_code == 200
    body = response.json()
    assert "provider_fallback" in body["warnings"]
    url = body["intonation"]["reference_audio_url"]
    assert url, "TTS 挂了也必须给出可用的示范音频（本地合成兜底）"
    audio = client.get(url.replace("/voice", "", 1))
    assert audio.status_code == 200


# --------------------------------------------------------------------------------------
# asr / tts
# --------------------------------------------------------------------------------------
def test_asr_all_providers_broken_returns_502_unified_error(client, monkeypatch, speech):
    _patch_providers(monkeypatch, asr=BrokenASR(), asr_chain=[BrokenASR()])
    response = client.post("/v1/asr", files={"audio": ("clip.wav", speech, "audio/wav")})
    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "provider_error"
    assert set(body["error"]) == {"code", "message", "detail"}


def test_asr_provider_error_falls_back_to_mock_without_extra_error(client, monkeypatch, speech):
    _patch_providers(monkeypatch, asr=BrokenASR(), asr_chain=[BrokenASR(), build_providers().asr])
    response = client.post("/v1/asr", files={"audio": ("clip.wav", speech, "audio/wav")})
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "mock"
    assert "provider_fallback" in body.get("warnings", [])


def test_tts_all_providers_broken_falls_back_to_local_synthesis(client, monkeypatch):
    _patch_providers(monkeypatch, tts=BrokenTTS(), tts_chain=[BrokenTTS()])
    response = client.post("/v1/tts", json={"text": "think, thank, three"})
    assert response.status_code == 200
    assert response.headers["X-TTS-Provider"] == "degraded"
    assert response.headers["X-TTS-Fallback"] == "1"
    assert int(response.headers["X-Audio-Duration-Ms"]) > 0
    assert decode_audio(response.content).duration_ms > 300


# --------------------------------------------------------------------------------------
# LLM
# --------------------------------------------------------------------------------------
def test_feedback_llm_unreachable_falls_back_to_template(client, monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    reset_settings_cache()
    reset_providers()
    response = client.post(
        "/v1/feedback",
        json={
            "reference_text": "I think the weather is really nice today.",
            "scores": {"pron": 60},
            "issues": [{"type": "Mispronunciation", "word": "think", "phoneme": "θ", "actual": "s", "score": 40}],
            "learner": {"age_band": "child"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "template"
    assert body["points"]


def test_feedback_llm_success_is_sanitized(client, monkeypatch):
    class FakeLLM:
        available = True
        provider_name = "deepseek"

        def __init__(self, *args, **kwargs):
            pass

        def chat_json(self, *args, **kwargs):
            from app.llm import LLMOutcome

            return LLMOutcome(
                provider="deepseek",
                data={
                    "summary": "读得不错 👍",
                    "praise": "weather 很清楚。",
                    "closing": "再来一次？",
                    "points": [
                        {"title": "θ 音", "why": "舌尖没出来", "how": "伸舌尖", "practice_words": ["think"], "demo_text": "think", "severity": "high"},
                        {"title": "第二点", "why": "b", "how": "c", "practice_words": [], "demo_text": "x", "severity": "bogus"},
                        {"title": "第三点不该出现", "why": "b", "how": "c", "practice_words": [], "demo_text": "x", "severity": "low"},
                    ],
                },
            )

    monkeypatch.setattr("app.api.LLMClient", FakeLLM)
    body = client.post(
        "/v1/feedback",
        json={"reference_text": "I think.", "scores": {"pron": 70}, "issues": [], "learner": {"age_band": "child"}},
    ).json()
    assert body["provider"] == "deepseek"
    assert len(body["points"]) == 2, "LLM 返回 3 条也必须截断为 2 条"
    assert body["points"][1]["severity"] == "medium", "非法 severity 归一化"
    blob = " ".join(p["title"] for p in body["points"])
    assert "θ" not in blob, "儿童模式的 IPA 必须被剥离"


def test_dialogue_llm_success_path(client, monkeypatch):
    class FakeLLM:
        available = True
        provider_name = "ollama"

        def __init__(self, *args, **kwargs):
            pass

        def chat_json(self, *args, **kwargs):
            return LLMOutcome(
                provider="ollama",
                data={
                    "reply": "Sure! Hot or iced?",
                    "reply_zh": "好的！热的还是冰的？",
                    "correction": {"has_error": True, "type": "politeness", "original": "I want it.", "better": "I'd like it, please.", "explain_zh": "更礼貌。", "severity": "low"},
                    "suggested_replies": ["Hot, please.", "Iced, please."],
                    "target_words": ["hot", "iced"],
                    "flag": "ok",
                    "done": False,
                },
            )

    monkeypatch.setattr("app.api.LLMClient", FakeLLM)
    body = client.post(
        "/v1/dialogue",
        json={
            "scenario": {"id": "ordering_coffee", "role_prompt": "barista"},
            "learner": {"age_band": "child", "child_safe": True},
            "history": [{"role": "user", "text": "I want it."}],
            "correction_level": "gentle",
            "turn_index": 1,
        },
    ).json()
    assert body["provider"] == "ollama"
    assert body["reply"] == "Sure! Hot or iced?"
    assert body["correction"]["type"] == "politeness"
    assert len(body["suggested_replies"]) == 2


# --------------------------------------------------------------------------------------
# execution helpers
# --------------------------------------------------------------------------------------
def test_run_chain_collects_errors_and_reports_fallback():
    class Ok:
        name = "ok"

    class Bad:
        name = "bad"

    def factory(provider):
        if provider.name == "bad":
            raise RuntimeError("nope")
        return "value"

    result, name, fallback, errors = run_chain([Bad(), Ok()], factory, 2.0, kind="unit")
    assert result == "value"
    assert name == "ok"
    assert fallback is True
    assert errors and errors[0].startswith("bad:")

    result, name, fallback, errors = run_chain([Bad()], factory, 2.0, kind="unit")
    assert result is None and fallback is True and errors


@pytest.mark.parametrize("kind", ["asr", "pronounce", "tts", "feedback", "dialogue"])
def test_timeouts_match_contract(kind):
    expected = {"asr": 25.0, "pronounce": 50.0, "tts": 15.0, "feedback": 30.0, "dialogue": 30.0}
    assert execution.TIMEOUTS[kind] == expected[kind]


# --------------------------------------------------------------------------------------
# 契约 §4：scores.* 不可得必须是 null，不能是 0
# --------------------------------------------------------------------------------------
class ZeroScorePA:
    """模拟 Azure 在"听不到有效语音"时的行为：四项能力分全填 0。

    0 会被读成"读得一无是处"，而真实含义是"这次没法评"，所以必须转成 null。
    """

    name = "zero_pa"
    capabilities = Capabilities(phoneme_level=True)

    def __init__(self):
        self._inner = MockPA()

    def assess(self, *args, **kwargs):
        result = self._inner.assess(*args, **kwargs)
        result.scores = PAScores(pron=0.0, accuracy=0.0, fluency=0.0, completeness=0.0, prosody=None)
        return result


def test_all_zero_ability_scores_become_null(client, monkeypatch, sweep):
    fake = ZeroScorePA()
    _patch_providers(monkeypatch, pa=fake, pa_chain=[fake])
    body = post_pronounce(client, sweep, "I think the weather is really nice today.").json()

    for key in ("pron", "accuracy", "fluency", "completeness"):
        assert body["scores"][key] is None, f"scores.{key} 为 0 时必须返回 null（契约 §4）"
    assert "scores_unavailable" in body["warnings"], "必须告知前端这次没评出来"


def test_nonzero_scores_are_not_nulled(client, monkeypatch, sweep):
    """反向断言：正常分数不能被这条规则误清空。"""
    body = post_pronounce(client, sweep, "I think the weather is really nice today.").json()
    assert body["scores"]["pron"] is not None
