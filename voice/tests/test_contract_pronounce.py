"""契约 §3：/v1/pronounce（核心接口）逐字段校验。"""

from __future__ import annotations

import re

import pytest

from app.hints import ERROR_TYPES, HINT_KEYS, SEVERITIES, WARNINGS
from app.intonation import ISSUE_TYPES
from tests.conftest import post_pronounce

RESPONSE_KEYS = {
    "provider",
    "granularity",
    "mode",
    "reference_text",
    "recognized_text",
    "duration_ms",
    "scores",
    "words",
    "issues",
    "intonation",
    "warnings",
    "provider_meta",
}
SCORE_KEYS = {"pron", "accuracy", "fluency", "completeness", "prosody"}
WORD_KEYS = {"word", "start_ms", "end_ms", "score", "error_type", "phonemes"}
PHONEME_KEYS = {"phoneme", "score", "start_ms", "end_ms", "nbest"}
ISSUE_KEYS = {"type", "severity", "word", "phoneme", "expected", "actual", "score", "start_ms", "end_ms", "hint_key"}
INTONATION_KEYS = {"available", "dtw_distance", "user_f0", "reference_f0", "worst_regions", "reference_audio_url"}
REGION_KEYS = {"start_ms", "end_ms", "text", "issue", "user_slope", "ref_slope"}
AUDIO_URL_RE = re.compile(r"^/voice/v1/audio/ref_[0-9a-f]{12}\.wav$")
SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2}

REFERENCE = "I think the weather is really nice today."


def _score(value):
    return value is None or (isinstance(value, (int, float)) and 0.0 <= float(value) <= 100.0)


def test_pronounce_full_contract(client, sweep):
    response = post_pronounce(client, sweep, REFERENCE, learner_age_band="child")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == RESPONSE_KEYS
    assert body["provider"] == "mock"
    assert body["granularity"] == "phoneme"
    assert body["mode"] == "scripted"
    assert body["reference_text"] == REFERENCE
    assert isinstance(body["recognized_text"], str)
    assert body["duration_ms"] > 0

    assert set(body["scores"]) == SCORE_KEYS
    for key, value in body["scores"].items():
        assert _score(value), f"scores.{key} out of range: {value}"
    assert body["scores"]["pron"] is not None

    for word in body["words"]:
        assert set(word) == WORD_KEYS
        assert word["error_type"] in ERROR_TYPES
        assert _score(word["score"])
        for phoneme in word["phonemes"]:
            assert set(phoneme) == PHONEME_KEYS
            assert _score(phoneme["score"])
            for candidate in phoneme["nbest"]:
                assert set(candidate) == {"phoneme", "score"}

    assert len(body["issues"]) <= 5
    ranks = []
    for issue in body["issues"]:
        assert set(issue) == ISSUE_KEYS
        assert issue["type"] in ERROR_TYPES
        assert issue["severity"] in SEVERITIES
        assert issue["hint_key"] in HINT_KEYS
        ranks.append(SEVERITY_RANK[issue["severity"]])
    assert ranks == sorted(ranks), "issues 必须按严重度降序"

    assert set(body["intonation"]) == INTONATION_KEYS
    for warning in body["warnings"]:
        assert warning in WARNINGS
    assert isinstance(body["provider_meta"], dict)


def test_pronounce_intonation_curve_alignment(client, sweep):
    body = post_pronounce(client, sweep, REFERENCE).json()
    intonation = body["intonation"]
    assert intonation["available"] is True
    assert intonation["dtw_distance"] is not None and intonation["dtw_distance"] >= 0
    user_f0, reference_f0 = intonation["user_f0"], intonation["reference_f0"]
    assert user_f0 and reference_f0
    assert len(user_f0) == len(reference_f0) <= 600
    assert [p[0] for p in user_f0] == [p[0] for p in reference_f0], "两条曲线必须使用同一时间轴"
    steps = {user_f0[i + 1][0] - user_f0[i][0] for i in range(len(user_f0) - 1)}
    assert steps and all(abs(step - 20) <= 1 for step in steps), f"20ms 步长被破坏: {sorted(steps)[:5]}"
    for pair in user_f0 + reference_f0:
        assert len(pair) == 2
        assert isinstance(pair[0], int)
        assert pair[1] is None or (isinstance(pair[1], float) and pair[1] > 0)
    for region in intonation["worst_regions"]:
        assert set(region) == REGION_KEYS
        assert region["issue"] in ISSUE_TYPES
        assert region["start_ms"] <= region["end_ms"]


def test_pronounce_generates_reference_audio_served_with_cache(client, sweep):
    body = post_pronounce(client, sweep, REFERENCE).json()
    url = body["intonation"]["reference_audio_url"]
    assert AUDIO_URL_RE.match(url), url
    # web 反代的同源路径 /voice/* -> voice 自己的 /v1/*
    audio = client.get(url.replace("/voice", "", 1))
    assert audio.status_code == 200
    assert audio.headers["content-type"].startswith("audio/")
    assert audio.headers["cache-control"] == "public, max-age=604800"
    assert len(audio.content) > 1000


def test_pronounce_mock_exposes_phoneme_issue_for_th(client, sweep):
    body = post_pronounce(client, sweep, REFERENCE).json()
    assert body["issues"], "mock provider 应给出确定性的教学 issue"
    phonemes = {issue["phoneme"] for issue in body["issues"]}
    assert phonemes & {"θ", "ð"}, phonemes
    hints = {issue["hint_key"] for issue in body["issues"]}
    assert hints & {"th_voiceless", "th_voiced"}, hints
    # 单词级热力图必须能拿到词级 score
    assert all(word["score"] is not None for word in body["words"])


def test_pronounce_without_intonation_returns_nulls(client, sweep):
    body = post_pronounce(client, sweep, REFERENCE, with_intonation="false").json()
    intonation = body["intonation"]
    assert intonation["available"] is False
    assert intonation["dtw_distance"] is None
    assert intonation["user_f0"] is None
    assert intonation["reference_f0"] is None
    assert intonation["worst_regions"] == []


def test_pronounce_word_granularity_has_no_phonemes(client, sweep):
    body = post_pronounce(client, sweep, REFERENCE, granularity="word").json()
    assert body["granularity"] == "word"
    assert body["words"]
    assert all(word["phonemes"] == [] for word in body["words"])
    assert body["issues"]


def test_pronounce_unscripted_mode(client, speech):
    body = post_pronounce(client, speech, "", mode="unscripted").json()
    assert body["mode"] == "unscripted"
    assert body["scores"]["completeness"] is None
    assert body["recognized_text"]


def test_pronounce_invalid_params(client, sweep):
    for data in (
        {"mode": "singing"},
        {"granularity": "syllable"},
        {"tts_rate": "fastest"},
        {"learner_age_band": "baby"},
    ):
        response = post_pronounce(client, sweep, REFERENCE, **data)
        assert response.status_code == 400, data
        assert response.json()["error"]["code"] == "bad_request"


def test_pronounce_nonperiodic_audio_degrades_intonation_not_500(client):
    """无基频结构的音频（白噪声 / 静音）：语调必须显式降级，HTTP 仍 200 且结构完整。"""
    import numpy as np

    from app.audio_io import pcm16_wav_bytes

    rng = np.random.default_rng(0)
    noise = pcm16_wav_bytes((0.4 * rng.standard_normal(16000 * 2)).astype(np.float32))
    response = post_pronounce(client, noise, REFERENCE)
    assert response.status_code == 200
    body = response.json()
    assert set(body) == RESPONSE_KEYS
    assert body["intonation"]["available"] is False
    assert body["intonation"]["dtw_distance"] is None
    assert body["intonation"]["user_f0"] is None
    assert body["intonation"]["reference_f0"] is None
    assert body["intonation"]["worst_regions"] == []
    assert "intonation_unavailable" in body["warnings"]
    assert "prosody_unavailable" in body["warnings"]
    assert body["scores"]["prosody"] is None, "语调不可用时 prosody 必须是 null，不许给假分数"
    assert body["scores"]["pron"] is not None  # 发音分仍可用（来自 provider）


def test_pronounce_undecodable_audio(client):
    response = client.post(
        "/v1/pronounce", files={"audio": ("clip.wav", b"\x00\x01\x02", "audio/wav")}, data={"reference_text": REFERENCE}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unsupported_audio"


@pytest.mark.parametrize("age_band", ["child", "teen", "adult"])
def test_pronounce_age_bands(client, sweep, age_band):
    body = post_pronounce(client, sweep, REFERENCE, learner_age_band=age_band).json()
    assert body["scores"]["fluency"] is not None
