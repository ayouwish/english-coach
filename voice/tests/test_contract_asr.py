"""契约 §2：/v1/asr。"""

from __future__ import annotations

from tests.conftest import audio_files

ASR_KEYS = {"text", "language", "duration_ms", "words", "provider"}
WORD_KEYS = {"word", "start_ms", "end_ms", "probability"}


def test_asr_mock_contract(client, speech):
    response = client.post("/v1/asr", files=audio_files(speech), data={"language": "en"})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == ASR_KEYS
    assert isinstance(body["text"], str) and body["text"]
    assert body["language"] == "en"
    assert body["duration_ms"] > 0
    assert body["provider"] == "mock"
    assert body["words"], "words must not be empty"
    for word in body["words"]:
        assert set(word) == WORD_KEYS
        assert isinstance(word["word"], str) and word["word"]
        assert 0 <= word["start_ms"] <= word["end_ms"] <= body["duration_ms"]
        assert word["probability"] is None or 0.0 <= word["probability"] <= 1.0
    # 词时间轴单调不减
    starts = [w["start_ms"] for w in body["words"]]
    assert starts == sorted(starts)


def test_asr_accepts_prompt_and_language(client, speech):
    response = client.post(
        "/v1/asr", files=audio_files(speech), data={"language": "en", "prompt": "weather, think"}
    )
    assert response.status_code == 200
    assert response.json()["language"] == "en"


def test_asr_is_deterministic(client, speech):
    first = client.post("/v1/asr", files=audio_files(speech)).json()
    second = client.post("/v1/asr", files=audio_files(speech)).json()
    assert first == second


def test_asr_rejects_undecodable_audio(client):
    response = client.post("/v1/asr", files={"audio": ("clip.wav", b"not-audio-at-all", "audio/wav")})
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "unsupported_audio"
    assert set(body["error"]) == {"code", "message", "detail"}


def test_asr_missing_field_uses_unified_error(client):
    response = client.post("/v1/asr")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"
