"""契约 §4：/v1/tts（二进制 + 响应头 + 413）。"""

from __future__ import annotations

import io
import wave

from app.audio_io import decode_audio


def _duration_ms(payload: bytes, content_type: str) -> int:
    if "wav" in content_type:
        return decode_audio(payload).duration_ms
    with wave.open(io.BytesIO(payload)) as handle:
        return int(handle.getnframes() / handle.getframerate() * 1000)


def test_tts_returns_audio_with_headers(client):
    response = client.post("/v1/tts", json={"text": "think, thank, three", "voice": "en-US-JennyNeural", "rate": "normal"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/")
    assert response.headers["X-TTS-Provider"] == "mock"
    assert int(response.headers["X-Audio-Duration-Ms"]) > 0
    assert _duration_ms(response.content, response.headers["content-type"]) > 300
    assert response.headers["X-Audio-Duration-Ms"] == str(decode_audio(response.content).duration_ms)


def test_tts_slow_rate_is_longer(client):
    normal = client.post("/v1/tts", json={"text": "think thank three", "rate": "normal"})
    slow = client.post("/v1/tts", json={"text": "think thank three", "rate": "slow"})
    assert normal.status_code == slow.status_code == 200
    assert int(slow.headers["X-Audio-Duration-Ms"]) > int(normal.headers["X-Audio-Duration-Ms"])


def test_tts_ssml_is_accepted(client):
    ssml = '<speak version="1.0" xml:lang="en-US"><voice name="en-US-JennyNeural">hello there</voice></speak>'
    response = client.post("/v1/tts", json={"text": "", "ssml": ssml, "format": "wav"})
    assert response.status_code == 200
    assert response.headers["X-Audio-Duration-Ms"] != "0"


def test_tts_text_too_long_returns_413(client):
    response = client.post("/v1/tts", json={"text": "a" * 2001})
    assert response.status_code == 413
    body = response.json()
    assert body["error"]["code"] == "payload_too_large"


def test_tts_invalid_rate_returns_400(client):
    response = client.post("/v1/tts", json={"text": "hello", "rate": "superfast"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"


def test_tts_empty_text_returns_400(client):
    response = client.post("/v1/tts", json={"text": ""})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"
