"""task-51：/v1/story/retell（复述覆盖度评估，鼓励优先、不评发音分）。全部假 LLM。"""

from __future__ import annotations

import pytest

from app.config import reset_settings_cache
from app.llm import LLMOutcome
from app.providers.registry import reset_providers

STORY = [
    "Today I built a tall block tower with Ming.",
    "Hua knocked it down.",
    "I was very angry.",
]
TRANSCRIPT = "I build tower with Ming and Hua knock it down, I am angry"
NORMAL = {
    "coverage": 0.72,
    "covered_points": ["tower", "Ming", "knocked down", "angry"],
    "missing_points": ["it was very tall"],
    "feedback_zh": "你讲了积木塔、小明和生气，很棒！下次可以说说塔有多高。",
    "feedback_en": "Great job! You told me about the tower and Ming.",
}
NEGATIVE_WORDS = ("差", "错", "失败", "不行", "不好", "没有", "漏掉", "扣分")


def _body(**overrides):
    body = {"story_sentences": STORY, "transcript": TRANSCRIPT, "level": "A2"}
    body.update(overrides)
    return body


@pytest.fixture
def llm_env(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "deepseek-flash")
    reset_settings_cache()
    reset_providers()
    yield
    reset_settings_cache()
    reset_providers()


def _patch_llm(monkeypatch, responses):
    calls: list[dict] = []

    def fake_chat_json(self, system_prompt, user_prompt, timeout_s=None, max_tokens=900,
                       temperature=0.3, disable_thinking=False):
        calls.append({"system": system_prompt, "user": user_prompt, "max_tokens": max_tokens,
                      "disable_thinking": disable_thinking, "temperature": temperature})
        item = responses.pop(0) if responses else NORMAL
        if isinstance(item, LLMOutcome):
            return item
        return LLMOutcome(provider="deepseek", data=item, finish_reason="stop", thinking_disabled=True)

    monkeypatch.setattr("app.llm.LLMClient.chat_json", fake_chat_json)
    return calls


def _assert_positive(text: str):
    for word in NEGATIVE_WORDS:
        assert word not in text, f"反馈里不允许出现否定词 {word!r}: {text}"


# --------------------------------------------------------------------------------------
# 正常路径
# --------------------------------------------------------------------------------------
def test_retell_normal(client, llm_env, monkeypatch):
    calls = _patch_llm(monkeypatch, [NORMAL])
    response = client.post("/v1/story/retell", json=_body())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["coverage"] == 0.72
    assert body["covered_points"] == NORMAL["covered_points"]
    assert body["missing_points"] == NORMAL["missing_points"]
    assert body["feedback_zh"] == NORMAL["feedback_zh"]
    assert body["feedback_en"] == NORMAL["feedback_en"]
    assert body["warnings"] == []
    assert body["provider"] == "deepseek"
    assert len(calls) == 1
    assert calls[0]["disable_thinking"] is True, "必须关闭思考"
    assert calls[0]["max_tokens"] == 1200
    # 提示词必须包含故事/复述/级别，且要求只输出 JSON
    prompt = calls[0]["user"]
    for sentence in STORY:
        assert sentence in prompt
    assert TRANSCRIPT in prompt
    assert "A2" in prompt
    assert "JSON" in calls[0]["system"]


def test_retell_coverage_clamped(client, llm_env, monkeypatch):
    _patch_llm(monkeypatch, [{**NORMAL, "coverage": 1.7}])
    assert client.post("/v1/story/retell", json=_body()).json()["coverage"] == 1.0
    _patch_llm(monkeypatch, [{**NORMAL, "coverage": -0.4}])
    low = client.post("/v1/story/retell", json=_body()).json()
    assert low["coverage"] == 0.0


# --------------------------------------------------------------------------------------
# 鼓励优先 / 低覆盖度
# --------------------------------------------------------------------------------------
def test_retell_low_coverage_keeps_positive_tone(client, llm_env, monkeypatch):
    low_positive = {
        "coverage": 0.2,
        "covered_points": ["tower"],
        "missing_points": ["Ming", "angry"],
        "feedback_zh": "你开口讲了！你提到了 tower，我们再来一次，这次可以多说一点。",
        "feedback_en": "You spoke up! Let's try again together.",
    }
    _patch_llm(monkeypatch, [low_positive])
    body = client.post("/v1/story/retell", json=_body()).json()
    assert body["coverage"] == 0.2
    _assert_positive(body["feedback_zh"])
    assert "开口" in body["feedback_zh"]


def test_retell_negative_feedback_falls_back_to_template(client, llm_env, monkeypatch):
    bad = {
        "coverage": 0.2,
        "covered_points": ["tower"],
        "missing_points": ["Ming", "angry"],
        "feedback_zh": "你讲得不好，错了，漏掉了小明，不行。",
        "feedback_en": "You did wrong.",
    }
    calls = _patch_llm(monkeypatch, [bad, bad])
    body = client.post("/v1/story/retell", json=_body()).json()
    assert len(calls) == 2, "反馈违规应重试一次"
    assert "feedback_template" in body["warnings"]
    _assert_positive(body["feedback_zh"])
    assert "tower" in body["feedback_zh"], "模板必须提到孩子真讲到的点"


def test_retell_praise_missing_covered_point_triggers_retry(client, llm_env, monkeypatch):
    """中文 covered_points 却没在肯定句里提到 → 重试一次。"""
    no_praise = {
        "coverage": 0.5,
        "covered_points": ["积木塔", "小明"],
        "missing_points": [],
        "feedback_zh": "我们再来一次，这次可以多说一点。",
        "feedback_en": "Let's try again.",
    }
    calls = _patch_llm(monkeypatch, [no_praise, NORMAL])
    body = client.post("/v1/story/retell", json=_body()).json()
    assert len(calls) == 2
    assert body["feedback_zh"] == NORMAL["feedback_zh"]


# --------------------------------------------------------------------------------------
# LLM 异常
# --------------------------------------------------------------------------------------
def test_retell_invalid_json_retry_then_502(client, llm_env, monkeypatch):
    bad = LLMOutcome(provider="deepseek", error="invalid_json")
    calls = _patch_llm(monkeypatch, [bad, bad])
    response = client.post("/v1/story/retell", json=_body())
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "provider_error"
    assert len(calls) == 2


def test_retell_truncated_retries_bigger_max_tokens(client, llm_env, monkeypatch):
    truncated = LLMOutcome(provider="deepseek", data=None, error="invalid_json",
                           finish_reason="length", completion_tokens=1200)
    calls = _patch_llm(monkeypatch, [truncated, NORMAL])
    response = client.post("/v1/story/retell", json=_body())
    assert response.status_code == 200
    assert calls[1]["max_tokens"] == 2400


def test_retell_requires_llm(client, monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    reset_settings_cache()
    response = client.post("/v1/story/retell", json=_body())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


# --------------------------------------------------------------------------------------
# 请求校验
# --------------------------------------------------------------------------------------
def test_retell_request_validation(client, llm_env):
    assert client.post("/v1/story/retell", json=_body(story_sentences=[])).status_code == 400
    assert client.post("/v1/story/retell", json=_body(story_sentences=["x"] * 21)).status_code == 400
    assert client.post("/v1/story/retell", json=_body(story_sentences=["x" * 201])).status_code == 400
    assert client.post("/v1/story/retell", json=_body(transcript="")).status_code == 400
    assert client.post("/v1/story/retell", json=_body(transcript="x" * 1001)).status_code == 400
    assert client.post("/v1/story/retell", json=_body(level="C2")).status_code == 400  # C1 合法、C2 非法


# --------------------------------------------------------------------------------------
# task-55：retell 支持 C1
# --------------------------------------------------------------------------------------
def test_retell_c1_normal(client, llm_env, monkeypatch):
    calls = _patch_llm(monkeypatch, [NORMAL])
    response = client.post("/v1/story/retell", json=_body(level="C1"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["coverage"] == 0.72
    assert "C1" in calls[0]["user"]


def test_retell_c1_low_coverage_still_positive(client, llm_env, monkeypatch):
    low = {
        "coverage": 0.15,
        "covered_points": ["积木塔"],
        "missing_points": ["冲突", "和好"],
        "feedback_zh": "你开口讲了！你提到了积木塔，我们再来一次，这次可以多说一点。",
        "feedback_en": "You spoke up! Let's try again together.",
    }
    _patch_llm(monkeypatch, [low])
    body = client.post("/v1/story/retell", json=_body(level="C1")).json()
    assert body["coverage"] == 0.15
    for word in NEGATIVE_WORDS:
        assert word not in body["feedback_zh"]
    assert "开口" in body["feedback_zh"]
