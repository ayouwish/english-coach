"""FastAPI 入口：``uvicorn app.main:app --host 0.0.0.0 --port 8100``。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api import router
from .config import get_settings
from .errors import STATUS_BY_CODE, VoiceError, error_payload
from .cache import reset_cache
from .providers.registry import reset_providers

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("voice")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.audio_dir   # 确保 $DATA_DIR/audio 存在
    settings.cache_dir   # 确保 $DATA_DIR/cache 存在（缓存关闭时不创建子目录）
    reset_providers()
    reset_cache()
    logger.info(
        "voice gateway ready: mode=%s asr=%s pa=%s tts=%s llm=%s data_dir=%s cache=%s",
        settings.mode,
        settings.asr_provider,
        settings.pa_provider,
        settings.tts_provider,
        settings.llm_provider,
        settings.data_dir,
        "on" if settings.cache_enabled else "off",
    )
    yield


app = FastAPI(
    title="english-coach voice gateway",
    description="ASR / 音素级发音评测 / TTS / LLM 反馈 / 对话（契约见 docs/api-contract.md）",
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(router, prefix="/v1")


@app.exception_handler(VoiceError)
async def _voice_error_handler(request: Request, exc: VoiceError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=exc.payload())


@app.exception_handler(RequestValidationError)
async def _validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    detail = [
        {"loc": [str(part) for part in item.get("loc", [])], "msg": str(item.get("msg", "")), "type": str(item.get("type", ""))}
        for item in exc.errors()[:8]
    ]
    return JSONResponse(status_code=400, content=error_payload("bad_request", "invalid request", {"errors": detail}))


@app.exception_handler(StarletteHTTPException)
async def _http_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if exc.status_code == 404:
        code = "audio_not_found"
    elif exc.status_code >= 500:
        code = "internal_error"
    else:
        code = "bad_request"
    return JSONResponse(status_code=exc.status_code, content=error_payload(code, str(exc.detail)))


@app.exception_handler(Exception)
async def _unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=STATUS_BY_CODE["internal_error"], content=error_payload("internal_error", "internal error"))


def main() -> None:  # pragma: no cover - 本地手动启动用
    import uvicorn

    settings = get_settings()
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":  # pragma: no cover
    main()
