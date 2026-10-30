"""契约 §7 / §8：音频只读接口与统一错误格式。"""

from __future__ import annotations


def test_audio_not_found_uses_unified_error(client):
    response = client.get("/v1/audio/ref_000000000000.wav")
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "audio_not_found"
    assert set(body["error"]) == {"code", "message", "detail"}


def test_audio_invalid_id_returns_400(client):
    response = client.get("/v1/audio/notes.txt")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"


def test_audio_path_traversal_is_rejected(client):
    response = client.get("/v1/audio/..%2F..%2Fetc%2Fpasswd")
    assert response.status_code in (400, 404)
    assert "error" in response.json()


def test_error_codes_are_frozen_set():
    from app.errors import ERROR_CODES

    assert set(ERROR_CODES) == {
        "bad_request",
        "unsupported_audio",
        "audio_too_long",
        "payload_too_large",
        "provider_error",
        "provider_timeout",
        "no_provider",
        "audio_not_found",
        "internal_error",
        "provider_unavailable",  # 契约 v1.5（task-25）：/v1/ocr 依赖未安装
        "content_unsafe",  # 契约 v2.0（task-52）：文生图内容被安全过滤
    }


def test_unknown_route_returns_unified_error_shape(client):
    response = client.get("/v1/nope")
    assert response.status_code == 404
    assert "error" in response.json()


def test_invalid_json_body_returns_400(client):
    response = client.post("/v1/tts", content=b"{not json", headers={"Content-Type": "application/json"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"
