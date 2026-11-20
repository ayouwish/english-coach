"""回归测试：纠错必须针对学习者最后一句（dev/dialogue-correction-guard）。

背景：LLM 偶尔把上一轮的 correction 原样带回来，导致对话详情里
第二/三句纠错重复（原句对不上本轮输入）。sanitize_dialogue 现在会丢弃
与本轮 user 文本词重合 <50% 的纠错。
"""

from __future__ import annotations

from app.dialogue import _correction_matches, sanitize_dialogue


def _payload(user_text: str, correction_level: str = "gentle") -> dict:
    return {
        "history": [
            {"role": "assistant", "text": "Hi there! What can I get for you today?"},
            {"role": "user", "text": user_text},
        ],
        "turn_index": 1,
        "correction_level": correction_level,
        "learner": {"child_safe": False},
    }


def _data(correction: dict) -> dict:
    return {
        "reply": "Sure! Anything else?",
        "reply_zh": "好的！还要别的吗？",
        "correction": correction,
        "suggested_replies": ["A latte, please."],
        "target_words": ["latte"],
        "flag": "ok",
        "done": False,
    }


# ── 词重合判定 ────────────────────────────────────────────────────────────

def test_matches_exact_sentence():
    assert _correction_matches("I want a coffee.", "I want a coffee.") is True


def test_matches_close_fragment_with_extra_words():
    assert _correction_matches("I want a coffee", "I want a coffee, please.") is True


def test_matches_paraphrase_above_half():
    # original 4 个词里有 3 个出现在 user 文本 → 75% ≥ 50%
    assert _correction_matches("I want a big coffee", "I want a coffee") is True


def test_rejects_stale_correction_from_previous_turn():
    assert _correction_matches("I goed to school yesterday", "I want a coffee") is False


def test_empty_original_or_user_is_conservative():
    # 无法判定时不误杀（保留模型输出，交给 _normalize_correction 处理）
    assert _correction_matches("", "I want a coffee") is True
    assert _correction_matches("I want a coffee", "") is True


# ── sanitize_dialogue 集成 ────────────────────────────────────────────────

def test_stale_correction_is_dropped():
    body = sanitize_dialogue(
        _data(
            {
                "has_error": True,
                "type": "grammar",
                "original": "I goed to school yesterday",
                "better": "I went to school yesterday",
                "explain_zh": "过去式",
                "severity": "high",
            }
        ),
        _payload("I want a coffee."),
    )
    assert body["correction"]["has_error"] is False
    assert body["correction"]["type"] == "none"
    assert body["correction"]["original"] is None


def test_matching_correction_is_kept():
    body = sanitize_dialogue(
        _data(
            {
                "has_error": True,
                "type": "politeness",
                "original": "I want a coffee",
                "better": "I'd like a coffee, please.",
                "explain_zh": "更礼貌的说法",
                "severity": "low",
            }
        ),
        _payload("I want a coffee."),
    )
    assert body["correction"]["has_error"] is True
    assert body["correction"]["original"] == "I want a coffee"
    assert "I'd like" in body["correction"]["better"]


def test_correction_level_none_still_suppresses():
    body = sanitize_dialogue(
        _data(
            {
                "has_error": True,
                "type": "grammar",
                "original": "I want a coffee",
                "better": "I'd like a coffee.",
                "explain_zh": "更礼貌",
                "severity": "low",
            }
        ),
        _payload("I want a coffee.", correction_level="none"),
    )
    assert body["correction"]["has_error"] is False


def test_reply_and_targets_unaffected_by_drop():
    body = sanitize_dialogue(
        _data(
            {
                "has_error": True,
                "type": "grammar",
                "original": "old sentence from earlier turn",
                "better": "different sentence",
                "explain_zh": "旧纠错",
                "severity": "low",
            }
        ),
        _payload("I want a coffee."),
    )
    assert body["reply"] == "Sure! Anything else?"
    assert body["target_words"] == ["latte"]
    assert body["done"] is False
