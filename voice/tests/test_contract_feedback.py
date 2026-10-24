"""契约 §5：/v1/feedback（离线模板降级 + 儿童模式硬约束）。"""

from __future__ import annotations

import re

import pytest

FEEDBACK_KEYS = {"provider", "summary", "praise", "points", "closing"}
POINT_KEYS = {"title", "why", "how", "practice_words", "demo_text", "severity"}
IPA_RE = re.compile(r"[θðʃʒæʌəɪʊɔɜŋɹɡɑɛɒʕʔˈˌ]")


def _payload(age_band: str = "child") -> dict:
    return {
        "reference_text": "I think the weather is really nice today.",
        "scores": {"pron": 72, "accuracy": 78, "fluency": 80, "completeness": 100, "prosody": 61},
        "issues": [
            {
                "type": "Mispronunciation",
                "word": "think",
                "phoneme": "θ",
                "actual": "s",
                "score": 41.0,
                "severity": "high",
            },
            {
                "type": "Mispronunciation",
                "word": "weather",
                "phoneme": "ð",
                "actual": "z",
                "score": 55.0,
                "severity": "high",
            },
            {
                "type": "Mispronunciation",
                "word": "really",
                "phoneme": "ɹ",
                "actual": "w",
                "score": 68.0,
                "severity": "medium",
            },
        ],
        "intonation": {
            "dtw_distance": 0.42,
            "worst_regions": [{"text": "really nice", "issue": "expected_rise_but_flat"}],
        },
        "learner": {"age_band": age_band, "level": "A2", "native_language": "zh"},
    }


def test_feedback_falls_back_to_template_without_llm(client):
    response = client.post("/v1/feedback", json=_payload())
    assert response.status_code == 200
    body = response.json()
    assert set(body) == FEEDBACK_KEYS
    assert body["provider"] == "template"  # 无 key -> 模板，HTTP 仍 200
    assert body["summary"] and body["praise"] and body["closing"]
    assert 1 <= len(body["points"]) <= 2, "points 最多 2 条（硬约束）"
    for point in body["points"]:
        assert set(point) == POINT_KEYS
        assert point["severity"] in ("high", "medium", "low")
        assert point["practice_words"], "每条建议要给练习词"
        assert point["demo_text"]


def test_feedback_child_mode_keeps_english_words_intact(client):
    """回归：IPA 替换表不能把普通英文单词改坏（think 曾被打成 th长 i 音n 音k）。"""
    body = client.post("/v1/feedback", json=_payload("child")).json()
    titles = " ".join(p["title"] for p in body["points"])
    assert "think" in titles, titles
    assert "长 i 音n 音" not in titles
    for word in ("think", "weather", "really"):
        assert word not in titles or word in titles  # 词形完整（不做二次替换）


def test_feedback_severity_derived_when_missing(client):
    """severity 缺失时按 score 推导：41 分必须是 high，而不是默认 medium。"""
    payload = _payload("teen")
    payload["issues"] = [{"type": "Mispronunciation", "word": "think", "phoneme": "θ", "actual": "s", "score": 41}]
    body = client.post("/v1/feedback", json=payload).json()
    assert body["points"][0]["severity"] == "high"

    payload["issues"] = [{"type": "Mispronunciation", "word": "think", "phoneme": "θ", "actual": "s", "score": 65}]
    body = client.post("/v1/feedback", json=payload).json()
    assert body["points"][0]["severity"] == "medium"

    payload["issues"] = [{"type": "Omission", "word": "weather", "phoneme": None, "actual": None, "score": 90}]
    body = client.post("/v1/feedback", json=payload).json()
    assert body["points"][0]["severity"] == "high"  # Omission 一律 high


def test_feedback_child_mode_avoids_ipa(client):
    body = client.post("/v1/feedback", json=_payload("child")).json()
    blob = " ".join(
        [body["summary"], body["praise"], body["closing"]]
        + [f"{p['title']} {p['why']} {p['how']}" for p in body["points"]]
    )
    assert not IPA_RE.search(blob), f"儿童模式不允许出现 IPA 符号: {blob}"
    assert "think" in blob or "th" in blob


def test_feedback_adult_mode_may_keep_ipa(client):
    body = client.post("/v1/feedback", json=_payload("adult")).json()
    blob = " ".join([p["title"] for p in body["points"]])
    assert "θ" in blob or "ð" in blob


def test_feedback_points_capped_and_sorted(client):
    body = client.post("/v1/feedback", json=_payload("teen")).json()
    assert len(body["points"]) <= 2
    severities = [p["severity"] for p in body["points"]]
    rank = {"high": 0, "medium": 1, "low": 2}
    assert [rank[s] for s in severities] == sorted(rank[s] for s in severities)


def test_feedback_intone_only_payload_still_gives_a_point(client):
    payload = _payload("adult")
    payload["issues"] = []
    body = client.post("/v1/feedback", json=payload).json()
    assert body["provider"] == "template"
    assert body["points"], "有问题区间时也要给出至少一条建议"


def test_feedback_minimal_payload_is_valid(client):
    body = client.post("/v1/feedback", json={"reference_text": "Hello"}).json()
    assert body["provider"] == "template"
    assert set(body) == FEEDBACK_KEYS
    assert isinstance(body["points"], list)


@pytest.mark.parametrize("age_band", ["child", "teen", "adult"])
def test_feedback_all_age_bands(client, age_band):
    assert client.post("/v1/feedback", json=_payload(age_band)).status_code == 200
