"""统一错误格式与错误码（见契约 §8）。"""

from __future__ import annotations

from typing import Any

STATUS_BY_CODE: dict[str, int] = {
    "bad_request": 400,
    "unsupported_audio": 422,
    "audio_too_long": 413,
    "payload_too_large": 413,
    "audio_not_found": 404,
    "provider_error": 502,
    "provider_timeout": 504,
    "no_provider": 503,
    "provider_unavailable": 503,  # task-25：/v1/ocr 依赖未安装（如未装 rapidocr）
    "internal_error": 500,
}

ERROR_CODES: tuple[str, ...] = tuple(STATUS_BY_CODE)


def error_payload(code: str, message: str, detail: Any | None = None) -> dict:
    return {"error": {"code": code, "message": message, "detail": detail if detail is not None else {}}}


class VoiceError(Exception):
    """Any non-2xx answer goes through this type so the shape stays frozen."""

    code = "internal_error"

    def __init__(self, message: str, code: str | None = None, detail: Any | None = None, status: int | None = None):
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        self.detail = detail if detail is not None else {}
        self.status = status if status is not None else STATUS_BY_CODE.get(self.code, 500)

    def payload(self) -> dict:
        return error_payload(self.code, self.message, self.detail)


class BadRequest(VoiceError):
    code = "bad_request"


class UnsupportedAudio(VoiceError):
    code = "unsupported_audio"


class AudioTooLong(VoiceError):
    code = "audio_too_long"


class PayloadTooLarge(VoiceError):
    code = "payload_too_large"


class AudioNotFound(VoiceError):
    code = "audio_not_found"


class ProviderError(VoiceError):
    code = "provider_error"

    def __init__(self, message: str, provider: str = "", detail: Any | None = None, code: str | None = None):
        payload_detail = {"provider": provider}
        if detail:
            payload_detail["reason"] = detail
        super().__init__(message, code=code, detail=payload_detail)
        self.provider = provider


class ProviderTimeout(ProviderError):
    code = "provider_timeout"


class ProviderUnavailable(ProviderError):
    """Provider 依赖缺失 / 未配置（例如没装 azure SDK、没有 key）。"""

    def __init__(self, message: str, provider: str = "", detail: Any | None = None):
        super().__init__(message, provider=provider, detail=detail, code="no_provider")
