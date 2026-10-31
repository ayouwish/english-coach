"""task-67：POST /v1/audio/concat（多段音频按序拼成一段 WAV）。"""

from __future__ import annotations

import io
import wave

import numpy as np
import pytest

from app.audio_io import decode_audio, pcm16_wav_bytes, probe_audio
from app.config import get_settings


def _wav(seconds: float = 1.0, sample_rate: int = 16000, freq: float = 220.0) -> bytes:
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    return pcm16_wav_bytes((0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32), sample_rate)


def _mp3(seconds: float = 0.4, sample_rate: int = 24000, freq: float = 330.0) -> bytes:
    """用 PyAV 编一段真 mp3（不依赖系统 ffmpeg）。"""
    import av

    buffer = io.BytesIO()
    container = av.open(buffer, mode="w", format="mp3")
    stream = container.add_stream("mp3", rate=sample_rate)
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    pcm = (0.3 * np.sin(2 * np.pi * freq * t) * 32767).astype("<i2").tobytes()
    frame = av.AudioFrame(format="s16", layout="mono", samples=t.size)
    frame.sample_rate = sample_rate
    frame.planes[0].update(pcm)
    for packet in stream.encode(frame):
        container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    return buffer.getvalue()


def _post(client, parts: list[tuple[str, bytes]], gap_ms: int | None = None, normalize: bool = False):
    files = [("parts", (name, data, "application/octet-stream")) for name, data in parts]
    data = {}
    if gap_ms is not None:
        data["gap_ms"] = str(gap_ms)
    if normalize:
        data["normalize"] = "1"
    return client.post("/v1/audio/concat", files=files, data=data)


def _wav_info(data: bytes) -> tuple[int, int, int]:
    with wave.open(io.BytesIO(data), "rb") as handle:
        return handle.getnchannels(), handle.getsampwidth(), handle.getframerate()


# --------------------------------------------------------------------------------------
# 正常拼接
# --------------------------------------------------------------------------------------
def test_concat_two_segments(client):
    response = _post(client, [("a.wav", _wav(1.0)), ("b.wav", _wav(1.0))], gap_ms=250)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers["x-total-ms"] == "2250"
    assert response.content.startswith(b"RIFF")
    assert _wav_info(response.content) == (1, 2, 16000)
    assert decode_audio(response.content).duration_ms == pytest.approx(2250, abs=20)


def test_concat_three_segments_and_gaps(client):
    parts = [("a.wav", _wav(0.5)), ("b.wav", _wav(0.5)), ("c.wav", _wav(0.5))]
    zero = _post(client, parts, gap_ms=0)
    assert zero.headers["x-total-ms"] == "1500"
    default = _post(client, parts)  # 默认 gap 250ms
    assert default.headers["x-total-ms"] == "2000"
    big = _post(client, parts, gap_ms=2000)
    assert big.headers["x-total-ms"] == "5500"
    assert decode_audio(big.content).duration_ms == pytest.approx(5500, abs=30)


def test_concat_mixed_wav_and_mp3(client):
    response = _post(client, [("a.wav", _wav(1.0)), ("b.mp3", _mp3(0.4))], gap_ms=0)
    assert response.status_code == 200, response.text
    total = int(response.headers["x-total-ms"])
    assert total == pytest.approx(1400, abs=60)
    assert probe_audio(response.content).container == "wav"
    assert probe_audio(response.content).sample_rate == 16000


def test_concat_webm_user_recording(client):
    """用户录音是 webm/opus（PyAV 解码）→ 也能和 TTS wav 拼接。"""
    import av

    buffer = io.BytesIO()
    container = av.open(buffer, mode="w", format="webm")
    stream = container.add_stream("libopus", rate=16000, layout="mono")
    t = np.arange(16000) / 16000
    pcm = (0.3 * np.sin(2 * np.pi * 220 * t) * 32767).astype("<i2").tobytes()
    frame = av.AudioFrame(format="s16", layout="mono", samples=t.size)
    frame.sample_rate = 16000
    frame.planes[0].update(pcm)
    for packet in stream.encode(frame):
        container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    response = _post(client, [("user.webm", buffer.getvalue()), ("tts.wav", _wav(0.5))], gap_ms=100)
    assert response.status_code == 200, response.text
    assert int(response.headers["x-total-ms"]) >= 1400


def test_normalize_param_accepted_but_noop(client):
    response = _post(client, [("a.wav", _wav(0.5))], normalize=True)
    assert response.status_code == 200
    assert response.headers["x-normalize"] == "1"


# --------------------------------------------------------------------------------------
# 错误语义
# --------------------------------------------------------------------------------------
def test_bad_second_segment_returns_400_with_index(client):
    response = _post(client, [("a.wav", _wav(0.5)), ("b.wav", b"this is not audio")], gap_ms=0)
    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "unsupported_audio"
    assert "第 2 段" in body["error"]["message"], body["error"]["message"]


def test_empty_segment_returns_400(client):
    response = _post(client, [("a.wav", _wav(0.5)), ("b.wav", b"")], gap_ms=0)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "unsupported_audio"


@pytest.mark.parametrize("gap_ms", [-1, 5000])
def test_invalid_gap_returns_400(client, gap_ms):
    response = _post(client, [("a.wav", _wav(0.5))], gap_ms=gap_ms)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"


def test_empty_parts_returns_400(client):
    response = client.post("/v1/audio/concat", files={})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"


def test_too_many_parts_returns_413(client):
    parts = [(f"p{i}.wav", _wav(0.05)) for i in range(201)]
    response = _post(client, parts, gap_ms=0)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_total_duration_over_limit_returns_413(client, monkeypatch):
    """总时长上限 900s → 413（用假解码结果快速模拟 200×5s）。"""
    from app.audio_io import AudioClip
    from app import audio_concat

    def fake_decode(data, target_sr=16000, max_seconds=None):
        return AudioClip(np.zeros(target_sr * 5, dtype=np.float32), target_sr)

    monkeypatch.setattr(audio_concat, "decode_audio", fake_decode)
    parts = [(f"p{i}.wav", _wav(0.05)) for i in range(200)]
    response = _post(client, parts, gap_ms=0)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "audio_too_long"


def test_single_part_over_300s_returns_413(client, monkeypatch):
    from app.audio_io import AudioTooLong
    from app import audio_concat

    def fake_decode(data, target_sr=16000, max_seconds=None):
        raise AudioTooLong("audio too long: 301.0s > 300s")

    monkeypatch.setattr(audio_concat, "decode_audio", fake_decode)
    response = _post(client, [("a.wav", _wav(0.5))])
    assert response.status_code == 413
    assert "第 1 段" in response.json()["error"]["message"]


# --------------------------------------------------------------------------------------
# 不落盘
# --------------------------------------------------------------------------------------
def test_concat_writes_nothing_to_disk(client):
    data_dir = get_settings().data_dir
    before = sorted(str(path) for path in data_dir.rglob("*"))
    response = _post(client, [("a.wav", _wav(0.5)), ("b.wav", _wav(0.5))], gap_ms=250)
    assert response.status_code == 200
    after = sorted(str(path) for path in data_dir.rglob("*"))
    assert after == before, f"拼接不应写盘: {set(after) - set(before)}"
