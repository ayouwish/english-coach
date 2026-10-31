"""task-17 回归：对话 prompt 质量（年龄/连续性/纠错分级）+ 健壮性 + 降级可见性。

全部用**假 LLM**（monkeypatch `app.llm.httpx.post`），不真调外部 API。
"""

from __future__ import annotations

import json

import pytest

from app import dialogue as dlg
from app.dialogue import (
    DIALOGUE_SYSTEM_PROMPT,
    done_turn_index,
    is_done,
    MAX_HISTORY,
    STRICT_JSON_REMINDER,
    build_dialogue_user_prompt,
    complete_dialogue,
    detect_correction,
    sanitize_dialogue,
    template_dialogue,
    trim_history,
)
from app.llm import LLMClient, LLMOutcome

SCENARIO = {
    "id": "ordering_coffee",
    "title": "Ordering coffee",
    "title_zh": "在咖啡店点单",
    "setting_zh": "你是一名咖啡店店员，学习者是顾客。",
    "role_prompt": "You are a friendly barista. Keep each reply under 15 words. Ask one question at a time.",
    "opening_line": "Hi there! What can I get for you today?",
    "level": "A2",
    "min_age": 6,
}
CHILD = {"age_band": "child", "level": "A2", "native_language": "zh", "child_safe": True}
ADULT = {"age_band": "adult", "level": "B1", "native_language": "zh", "child_safe": False}


def _payload(age_band="child", turn_index=2, correction_level="gentle", user_text="I want a coffee.", history_extra=None):
    history = [
        {"role": "assistant", "text": SCENARIO["opening_line"]},
        {"role": "user", "text": user_text},
    ]
    if history_extra:
        history = history_extra
    return {
        "scenario": SCENARIO,
        "learner": CHILD if age_band == "child" else ADULT,
        "history": history,
        "correction_level": correction_level,
        "turn_index": turn_index,
    }


def _good_llm_json(**overrides) -> str:
    data = {
        "reply": "Sure, one coffee. Would you like it hot or iced?",
        "reply_zh": "好的，一杯咖啡。你要热的还是冰的？",
        "correction": {
            "has_error": True,
            "type": "politeness",
            "original": "I want a coffee.",
            "better": "I'd like a coffee, please.",
            "explain_zh": "点单时说 I'd like ... please 更自然。",
            "severity": "low",
        },
        "suggested_replies": ["Hot, please.", "Iced, please.", "Milk, please."],
        "target_words": ["coffee", "hot", "iced"],
        "flag": "ok",
        "done": False,
    }
    data.update(overrides)
    return json.dumps(data, ensure_ascii=False)


# --------------------------------------------------------------------------------------
# 假 LLM：monkeypatch httpx.post（走真实的 LLMClient 解析/重试/降级逻辑）
# --------------------------------------------------------------------------------------
class _FakeResponse:
    def __init__(self, content: str):
        self._content = content

    def raise_for_status(self):
        return None

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


@pytest.fixture
def fake_llm(monkeypatch):
    """把 httpx.post 换成按队列返回的假实现；返回 (calls, queue)。"""
    calls: list[dict] = []
    queue: list[object] = []

    def fake_post(url, headers=None, json=None, timeout=None):  # noqa: A002 - 与 httpx 签名一致
        calls.append({"url": url, "headers": headers, "body": json})
        item = queue.pop(0) if queue else _FakeResponse(_good_llm_json())
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr("app.llm.httpx.post", fake_post)
    return calls, queue


@pytest.fixture
def llm_configured(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "deepseek-chat")
    from app.config import reset_settings_cache

    reset_settings_cache()
    yield
    reset_settings_cache()


def _fake_response(content: str) -> _FakeResponse:
    return _FakeResponse(content)


def _run(client, payload) -> dict:
    response = client.post("/v1/dialogue", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------------------------
# 1) prompt 质量：年龄适配 / 连续性 / 不重复 / 纠错分级 / few-shot
# --------------------------------------------------------------------------------------
def test_system_prompt_has_age_continuity_and_fewshot():
    prompt = DIALOGUE_SYSTEM_PROMPT
    # 年龄适配
    assert "[AGE_BAND=child]" in prompt and "A1" in prompt
    assert "<= 12 words" in prompt
    assert "ONE simple question" in prompt
    assert "teen|adult" in prompt and "CEFR" in prompt
    # 连续性 + 禁止万能句
    assert "CONTINUITY" in prompt
    assert '"Tell me more"' in prompt and '"That sounds good"' in prompt
    assert "FORBIDDEN" in prompt
    # 不重复
    assert "ALREADY_ASKED" in prompt
    # 纠错分级
    for level in ("gentle", "standard", "none"):
        assert level in prompt
    assert "NEVER invent" in prompt
    # 儿童安全 & suggested_replies & few-shot
    assert "CHILD SAFETY" in prompt
    assert "<= 6 words" in prompt
    assert '"suggested_replies"' in prompt
    assert "EXAMPLE A" in prompt and "EXAMPLE B" in prompt
    # few-shot 示例必须是合法 JSON（防止示例本身带坏格式）
    start = prompt.index("EXAMPLE A")
    example = prompt[start:].split("{", 1)[1]
    example = "{" + example.split("}\n\nEXAMPLE B")[0] + "}"
    json.loads(example)


def test_user_prompt_carries_age_band_and_applied_rules():
    child_prompt = build_dialogue_user_prompt(_payload("child"))
    assert "AGE_BAND: child" in child_prompt
    assert "apply this block" in child_prompt
    assert "CHILD_SAFE: True" in child_prompt
    adult_prompt = build_dialogue_user_prompt(_payload("adult"))
    assert "AGE_BAND: adult" in adult_prompt


def test_user_prompt_lists_already_asked_questions():
    payload = _payload(
        history_extra=[
            {"role": "assistant", "text": SCENARIO["opening_line"]},
            {"role": "user", "text": "A coffee."},
            {"role": "assistant", "text": "Hot or iced?"},
            {"role": "user", "text": "Hot."},
        ]
    )
    prompt = build_dialogue_user_prompt(payload)
    assert "ALREADY_ASKED" in prompt
    assert "Hot or iced?" in prompt
    assert SCENARIO["opening_line"] in prompt


def test_history_is_trimmed_to_last_8():
    history = [{"role": "user", "text": f"line-{index}"} for index in range(12)]
    payload = _payload(history_extra=history)
    trimmed = trim_history(payload["history"])
    assert len(trimmed) == MAX_HISTORY == 8
    prompt = build_dialogue_user_prompt(payload)
    assert "line-0" not in prompt and "line-3" not in prompt
    assert "line-4" in prompt and "line-11" in prompt


def test_history_trimmed_in_llm_request_body(client, monkeypatch, fake_llm, llm_configured):
    calls, _queue = fake_llm
    history = [{"role": "user", "text": f"line-{index}"} for index in range(12)]
    _run(client, _payload(history_extra=history))
    sent = calls[0]["body"]["messages"][1]["content"]
    assert "line-4" in sent and "line-11" in sent
    assert "line-0" not in sent and "line-3" not in sent


def test_correction_levels_differ_in_template_path():
    text = "I very much like it."  # 只有 standard 才纠（语序/用词类）
    assert detect_correction(text, "none")["has_error"] is False
    assert detect_correction(text, "gentle")["has_error"] is False
    standard = detect_correction(text, "standard")
    assert standard["has_error"] is True and standard["type"] == "vocabulary"
    # 基础错在 gentle 下也要纠
    assert detect_correction("I is happy.", "gentle")["has_error"] is True
    assert detect_correction("I want a coffee.", "gentle")["type"] == "politeness"


# --------------------------------------------------------------------------------------
# 2) LLM 路径：正常 / 重试一次 / 降级
# --------------------------------------------------------------------------------------
def test_llm_success_sets_provider_and_not_degraded(client, fake_llm, llm_configured):
    calls, _queue = fake_llm
    body = _run(client, _payload("adult"))
    assert body["provider"] == "deepseek"
    assert body["degraded_llm"] is False
    assert "hot or iced" in body["reply"].lower()
    # 请求体：JSON 模式 + 模型名 + 系统/用户两条消息
    request = calls[0]["body"]
    assert request["response_format"] == {"type": "json_object"}
    assert request["model"] == "deepseek-chat"
    assert request["messages"][0]["role"] == "system"
    assert "AGE_BAND" in request["messages"][1]["content"]


def test_invalid_json_retries_once_then_degrades(client, fake_llm, llm_configured):
    calls, queue = fake_llm
    queue.extend([_fake_response("not json at all"), _fake_response("still not json")])
    body = _run(client, _payload())
    assert len(calls) == 2, "第一次非法 JSON 后必须重试一次"
    assert "previous answer was not valid JSON" in calls[1]["body"]["messages"][0]["content"]
    assert body["provider"] == "template", "降级时不能伪装成 LLM"
    assert body["degraded_llm"] is True
    assert body["reply"]


def test_invalid_json_then_valid_on_retry(client, fake_llm, llm_configured):
    calls, queue = fake_llm
    queue.extend([_fake_response("oops"), _fake_response(_good_llm_json())])
    body = _run(client, _payload("adult"))
    assert len(calls) == 2
    assert body["provider"] == "deepseek"
    assert body["degraded_llm"] is False


def test_missing_reply_key_also_triggers_retry(client, fake_llm, llm_configured):
    calls, queue = fake_llm
    queue.extend([_fake_response(json.dumps({"reply_zh": "只有中文"})), _fake_response(_good_llm_json())])
    body = _run(client, _payload("adult"))
    assert len(calls) == 2
    assert body["degraded_llm"] is False


def test_llm_transport_error_degrades_honestly(client, fake_llm, llm_configured):
    _calls, queue = fake_llm
    queue.extend([RuntimeError("connection reset"), RuntimeError("connection reset")])
    body = _run(client, _payload())
    assert body["provider"] == "template"
    assert body["degraded_llm"] is True


def test_no_llm_configured_is_degraded_true(client):
    body = _run(client, _payload())
    assert body["provider"] == "template"
    assert body["degraded_llm"] is True


# --------------------------------------------------------------------------------------
# 3) sanitize 兜底
# --------------------------------------------------------------------------------------
def test_single_suggestion_is_topped_up():
    cleaned = sanitize_dialogue({"reply": "Sure! Hot or iced?", "suggested_replies": ["Hot, please."]}, _payload())
    assert 2 <= len(cleaned["suggested_replies"]) <= 3
    assert len({s.lower() for s in cleaned["suggested_replies"]}) == len(cleaned["suggested_replies"])


def test_suggestions_over_six_words_and_duplicates_are_dropped():
    raw = ["Hot, please.", "hot, please.", "I would like a large hot coffee with milk please.", "Iced, please."]
    cleaned = sanitize_dialogue({"reply": "Hot or iced?", "suggested_replies": raw}, _payload())
    suggestions = cleaned["suggested_replies"]
    assert 2 <= len(suggestions) <= 3
    assert len({s.lower().rstrip(".") for s in suggestions}) == len(suggestions)
    assert all(len(s.rstrip(".").split()) <= 6 for s in suggestions), suggestions


def test_reply_zh_missing_becomes_empty_string_not_null():
    cleaned = sanitize_dialogue({"reply": "Hot or iced?"}, _payload())
    assert cleaned["reply_zh"] == ""


def test_overlong_reply_is_truncated_with_warning(caplog):
    long_reply = "word " * 200  # 1000 chars
    with caplog.at_level("WARNING", logger="voice.dialogue"):
        cleaned = sanitize_dialogue({"reply": long_reply, "reply_zh": "x"}, _payload())
    assert len(cleaned["reply"]) <= dlg.MAX_REPLY_CHARS + 1
    assert any("过长" in record.message for record in caplog.records)


def test_noop_correction_is_dropped():
    """"纠正"没改变任何东西 => 视为无错（宁可 has_error=false，也不挑刺）。"""
    cleaned = sanitize_dialogue(
        {
            "reply": "Sure.",
            "correction": {"has_error": True, "type": "grammar", "original": "I like it.", "better": "I like it.", "severity": "low"},
        },
        _payload("adult"),
    )
    assert cleaned["correction"]["has_error"] is False
    assert cleaned["correction"]["type"] == "none"


def test_correction_level_none_forces_has_error_false(client, fake_llm, llm_configured):
    """即使 LLM 说有错，correction_level=none 也必须 has_error=false。"""
    _calls, queue = fake_llm
    queue.append(_fake_response(_good_llm_json()))
    body = _run(client, _payload("adult", correction_level="none"))
    assert body["degraded_llm"] is False
    assert body["correction"]["has_error"] is False
    assert body["correction"]["type"] == "none"


def test_target_words_capped_to_three():
    cleaned = sanitize_dialogue(
        {"reply": "Hot or iced?", "target_words": ["a", "b", "c", "d", "e"]},
        _payload(),
    )
    assert 1 <= len(cleaned["target_words"]) <= 3


# --------------------------------------------------------------------------------------
# 4) done / 儿童安全
# --------------------------------------------------------------------------------------
def test_done_boundary_default_is_unlimited(client):
    """task-69：默认不因轮数结束；只有显式 CHAT_DONE_TURN_INDEX>0 才保留轮数收尾。"""
    for turn in (5, 6, 9):
        assert _run(client, _payload(turn_index=turn))["done"] is False


def test_done_boundary_when_configured(client, monkeypatch):
    from app.config import reset_settings_cache

    monkeypatch.setenv("CHAT_DONE_TURN_INDEX", "6")
    reset_settings_cache()
    try:
        assert _run(client, _payload(turn_index=5))["done"] is False
        assert _run(client, _payload(turn_index=6))["done"] is True
        assert _run(client, _payload(turn_index=9))["done"] is True
    finally:
        reset_settings_cache()


def test_default_config_ten_turns_never_done(client, fake_llm, llm_configured):
    """默认配置连续 10 轮（fake LLM 每次 done=false）→ 全部 done=false。"""
    _calls, queue = fake_llm
    for turn in range(10):
        queue.append(_fake_response(_good_llm_json(done=False)))
        assert _run(client, _payload(turn_index=turn))["done"] is False, turn


def test_prompt_no_turn_based_ending():
    prompt = DIALOGUE_SYSTEM_PROMPT
    assert "from turn_index >= 5" not in prompt
    assert "wrap up naturally" not in prompt.lower()
    assert "naturally reached its end" in prompt
    assert "NEVER set done=true just because there have been many turns" in prompt


def test_config_default_and_override(monkeypatch):
    from app.config import get_settings, reset_settings_cache

    reset_settings_cache()
    assert get_settings().chat_done_turn_index == 0
    assert done_turn_index() == 0
    assert is_done(50, False) is False
    monkeypatch.setenv("CHAT_DONE_TURN_INDEX", "6")
    reset_settings_cache()
    try:
        assert get_settings().chat_done_turn_index == 6
        assert done_turn_index() == 6
        assert is_done(5, False) is False
        assert is_done(6, False) is True
        assert is_done(1, True) is True, "模型语义 done 始终透传"
    finally:
        reset_settings_cache()


def test_llm_done_flag_is_respected(client, fake_llm, llm_configured):
    _calls, queue = fake_llm
    queue.append(_fake_response(_good_llm_json(done=True)))
    assert _run(client, _payload("adult"))["done"] is True


def test_child_unsafe_reply_is_filtered(client, fake_llm, llm_configured):
    _calls, queue = fake_llm
    queue.append(_fake_response(_good_llm_json(reply="Let's kill the monster now!")))
    body = _run(client, _payload("child"))
    assert body["flag"] == "unsafe_filtered"
    assert "kill" not in body["reply"].lower()
    assert body["reply"]


def test_unsafe_suggestions_are_filtered():
    cleaned = sanitize_dialogue(
        {"reply": "Hot or iced?", "suggested_replies": ["Kill it.", "Hot, please.", "Iced, please."]},
        _payload(),
    )
    assert all("kill" not in s.lower() for s in cleaned["suggested_replies"])
    assert len(cleaned["suggested_replies"]) >= 2


# --------------------------------------------------------------------------------------
# 5) 同一句：template vs 假 LLM（质量对比，供汇报用）
# --------------------------------------------------------------------------------------
def test_template_vs_llm_reply_differ_on_same_input(client, fake_llm, llm_configured):
    template_body = template_dialogue(_payload("adult", user_text="I want a coffee."))
    assert template_body["degraded_llm"] is True
    llm_body = _run(client, _payload("adult", user_text="I want a coffee."))
    assert llm_body["degraded_llm"] is False
    assert llm_body["reply"] != template_body["reply"]
    # 连续性：LLM 回复必须包含对学习者内容的回应（不能只是万能句）
    assert llm_body["reply"].lower() != "nice! tell me more."


def test_complete_dialogue_falls_back_when_llm_unavailable():
    class Unavailable:
        available = False

    out = complete_dialogue(Unavailable(), _payload())
    assert out["provider"] == "template" and out["degraded_llm"] is True


def test_llm_outcome_provider_is_preserved():
    class FakeLLM:
        available = True

        def chat_json(self, *args, **kwargs):
            return LLMOutcome(provider="ollama", data=json.loads(_good_llm_json()))

    out = complete_dialogue(FakeLLM(), _payload("adult"))
    assert out["provider"] == "ollama" and out["degraded_llm"] is False
