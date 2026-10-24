"""契约 §6：/v1/dialogue（模板降级、纠错枚举、done、安全过滤）。"""

from __future__ import annotations

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
LEARNER = {"age_band": "child", "level": "A2", "native_language": "zh", "child_safe": True}
DIALOGUE_KEYS = {
    "provider",
    "degraded_llm",  # 契约 v1.4 新增（可选、向后兼容）：本条回复是不是"没接大模型"
    "reply",
    "reply_zh",
    "correction",
    "suggested_replies",
    "target_words",
    "flag",
    "done",
}
CORRECTION_KEYS = {"has_error", "type", "original", "better", "explain_zh", "severity"}


def _payload(user_text: str = "I want a coffee.", turn_index: int = 1, correction_level: str = "gentle") -> dict:
    return {
        "scenario": SCENARIO,
        "learner": LEARNER,
        "history": [
            {"role": "assistant", "text": SCENARIO["opening_line"]},
            {"role": "user", "text": user_text},
        ],
        "correction_level": correction_level,
        "turn_index": turn_index,
    }


def test_dialogue_template_fallback_contract(client):
    response = client.post("/v1/dialogue", json=_payload())
    assert response.status_code == 200
    body = response.json()
    assert set(body) == DIALOGUE_KEYS
    assert body["provider"] == "template"
    assert body["degraded_llm"] is True, "没配 LLM 时必须如实告诉前端" 
    assert body["reply"] and body["reply_zh"]
    assert set(body["correction"]) == CORRECTION_KEYS
    assert body["correction"]["type"] in ("grammar", "vocabulary", "politeness", "pronunciation", "none")
    assert 2 <= len(body["suggested_replies"]) <= 3, "儿童模式必须给 2-3 条可跟读的应答"
    assert isinstance(body["target_words"], list)
    assert body["flag"] in ("ok", "unsafe_filtered", "off_topic")
    assert body["done"] is False


def test_dialogue_politeness_correction(client):
    body = client.post("/v1/dialogue", json=_payload("I want a coffee.")).json()
    correction = body["correction"]
    assert correction["has_error"] is True
    assert correction["type"] == "politeness"
    assert correction["original"] == "I want a coffee."
    assert "I'd like" in correction["better"]
    assert correction["explain_zh"]
    assert correction["severity"] in ("high", "medium", "low")


def test_dialogue_correction_level_none_disables_correction(client):
    body = client.post("/v1/dialogue", json=_payload("I is happy.", correction_level="none")).json()
    assert body["correction"]["has_error"] is False
    assert body["correction"]["type"] == "none"
    assert body["correction"]["better"] is None


def test_dialogue_grammar_correction(client):
    body = client.post("/v1/dialogue", json=_payload("I is happy today.")).json()
    assert body["correction"]["has_error"] is True
    assert body["correction"]["type"] == "grammar"


def test_dialogue_done_after_turn_six(client):
    assert client.post("/v1/dialogue", json=_payload(turn_index=5)).json()["done"] is False
    assert client.post("/v1/dialogue", json=_payload(turn_index=6)).json()["done"] is True
    assert client.post("/v1/dialogue", json=_payload(turn_index=9)).json()["done"] is True


def test_dialogue_unsafe_input_is_filtered(client):
    body = client.post("/v1/dialogue", json=_payload("I want to kill the monster.")).json()
    assert body["flag"] == "unsafe_filtered"
    assert "kill" not in body["reply"].lower()


def test_dialogue_unknown_scenario_has_fallback(client):
    payload = _payload()
    payload["scenario"] = {**SCENARIO, "id": "totally_unknown_scenario"}
    body = client.post("/v1/dialogue", json=payload).json()
    assert body["provider"] == "template"
    assert body["reply"]
    assert 2 <= len(body["suggested_replies"]) <= 3


def test_dialogue_invalid_correction_level(client):
    response = client.post("/v1/dialogue", json=_payload(correction_level="harsh"))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"
