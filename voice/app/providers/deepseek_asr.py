"""DeepSeek ASR（task-112）：官方文档（2026-11 核对）

- 端点：`POST {base}/v1/tools/asr`（base 默认 https://api.deepseek.com），multipart `file`
- 格式：16-bit PCM WAV / Ogg Opus；WAV 8k–48k、单声道；**≤8 MiB、≤120 秒**、不支持流式
- 返回：`{request_id, text, duration_ms}` —— 无时间戳/置信度/音素；语种自动识别
- 计费：¥0.78/小时（限时 0.39）
- 本 provider 只负责"任意输入 → 16k/16bit/mono WAV 分片 → 逐片识别 → 拼接"；
  usage.asr_seconds 由 /v1/asr 路由统一按实际时长给出（task-100 约定）
- 错误映射：429 → RateLimited、503 → ProviderUnavailable、504 → ProviderTimeout、400 → ProviderError
  （400 等非回退类错误标 `no_fallback`，不会被调用链静默换成别的 provider）
"""

from __future__ import annotations

import logging
import time

import httpx
import numpy as np

from ..audio_io import AudioClip, pcm16_wav_bytes
from ..audio_split import split_audio_by_silence
from ..config import Settings, get_settings
from ..errors import (
    ProviderError,
    ProviderTimeout,
    ProviderUnavailable,
    RateLimited,
)
from .base import ASRResult, Capabilities

logger = logging.getLogger("voice.deepseek_asr")

DEEPSEEK_ASR_MAX_SECONDS = 120.0  # 官方上限（留 110s 配置余量）
DEEPSEEK_ASR_MAX_ATTEMPTS = 3  # 首次 + 2 次重试（429/5xx，1s/2s）
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def deepseek_asr_available(settings: Settings | None = None) -> tuple[bool, str | None]:
    settings = settings or get_settings()
    key = settings.deepseek_asr_api_key or settings.llm_api_key
    if not key:
        return False, "DEEPSEEK_ASR_API_KEY / LLM_API_KEY 未配置"
    return True, None


def _api_key(settings: Settings) -> str:
    key = settings.deepseek_asr_api_key or settings.llm_api_key
    if not key:
        raise ProviderUnavailable(
            "DeepSeek ASR 未配置 key：请在 .env 设置 DEEPSEEK_ASR_API_KEY（或复用 LLM_API_KEY）",
            provider="deepseek",
            code="provider_unavailable",
        )
    return key


def _endpoint(settings: Settings) -> str:
    base = (settings.deepseek_asr_base_url or "https://api.deepseek.com").rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    return base + "/tools/asr"


def _join_texts(texts: list[str]) -> str:
    cleaned = [text.strip() for text in texts if text and text.strip()]
    if not cleaned:
        return ""
    has_ascii_letters = any(any("a" <= ch.lower() <= "z" for ch in text) for text in cleaned)
    return (" " if has_ascii_letters else "").join(cleaned)


def _limit_bytes(chunks: list[np.ndarray], sample_rate: int, max_bytes: int) -> list[np.ndarray]:
    """每片 WAV 必须 ≤ max_bytes（官方 8MiB）；正常 110s ≈ 3.5MB，这里做兜底硬切。"""
    if max_bytes <= 0:
        return chunks
    limited: list[np.ndarray] = []
    for chunk in chunks:
        pending = [chunk]
        while pending:
            current = pending.pop(0)
            size = len(pcm16_wav_bytes(current, sample_rate))
            if size <= max_bytes or current.size <= sample_rate:
                limited.append(current)
                continue
            middle = current.size // 2
            pending.insert(0, current[:middle])
            pending.insert(1, current[middle:])
    return limited


class DeepSeekASR:
    name = "deepseek"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def recognize(self, clip: AudioClip, language: str = "en", prompt: str | None = None) -> ASRResult:
        settings = get_settings()
        key = _api_key(settings)
        chunks = split_audio_by_silence(
            clip.samples,
            clip.sample_rate,
            settings.deepseek_asr_chunk_seconds,
            absolute_max_seconds=DEEPSEEK_ASR_MAX_SECONDS,
        )
        chunks = _limit_bytes(chunks, clip.sample_rate, settings.deepseek_asr_max_bytes)
        texts: list[str] = []
        for index, samples in enumerate(chunks, start=1):
            wav = pcm16_wav_bytes(samples, clip.sample_rate)
            try:
                text, _duration_ms = self._transcribe(wav, settings, key)
            except ProviderError as exc:
                exc.detail = {**(exc.detail or {}), "part": index, "parts": len(chunks)}
                raise
            if text:
                texts.append(text)
        warnings = ["segmented"] if len(chunks) > 1 else []
        return ASRResult(
            text=_join_texts(texts),
            language=language,
            duration_ms=clip.duration_ms,
            words=[],
            provider=self.name,
            provider_meta={
                "model": "deepseek-asr",
                "segments": len(chunks),
                "chunk_seconds": settings.deepseek_asr_chunk_seconds,
            },
            warnings=warnings,
        )

    def _transcribe(self, wav_bytes: bytes, settings: Settings, key: str) -> tuple[str, int | None]:
        url = _endpoint(settings)
        headers = {"Authorization": f"Bearer {key}"}
        files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
        last_detail = ""
        for attempt in range(1, DEEPSEEK_ASR_MAX_ATTEMPTS + 1):
            try:
                response = httpx.post(
                    url, headers=headers, files=files, timeout=settings.deepseek_asr_timeout_s
                )
            except httpx.TimeoutException as exc:
                raise ProviderTimeout(
                    f"deepseek asr timed out after {settings.deepseek_asr_timeout_s:.0f}s", provider="deepseek"
                ) from exc
            except httpx.HTTPError as exc:
                last_detail = f"{type(exc).__name__}: {exc}"
                error = ProviderError(f"deepseek asr request failed: {last_detail}", provider="deepseek")
                if attempt < DEEPSEEK_ASR_MAX_ATTEMPTS:
                    logger.warning("deepseek asr transport error (attempt %d): %s", attempt, last_detail)
                    time.sleep(float(attempt))
                    continue
                error.no_fallback = True
                raise error from exc

            if response.status_code == 200:
                try:
                    payload = response.json()
                except ValueError as exc:
                    raise ProviderError("deepseek asr returned non-JSON body", provider="deepseek") from exc
                text = str((payload or {}).get("text") or "").strip() if isinstance(payload, dict) else ""
                duration_ms = (payload or {}).get("duration_ms") if isinstance(payload, dict) else None
                try:
                    duration_ms = int(duration_ms) if duration_ms is not None else None
                except (TypeError, ValueError):
                    duration_ms = None
                return text, duration_ms

            last_detail = _error_detail(response)
            if response.status_code in RETRYABLE_STATUS and attempt < DEEPSEEK_ASR_MAX_ATTEMPTS:
                logger.warning("deepseek asr %s (attempt %d), retrying", response.status_code, attempt)
                time.sleep(float(attempt))  # 1s, 2s
                continue
            raise _map_error(response.status_code, last_detail)
        raise ProviderError(f"deepseek asr failed: {last_detail}", provider="deepseek")


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception:
        return (response.text or "")[:300]
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return f"{error.get('code', '')}: {error.get('message', '')}".strip(": ")
        if "message" in payload:
            return str(payload.get("message"))[:300]
    return str(payload)[:300]


def _map_error(status: int, detail: str) -> ProviderError:
    """错误码映射（task-112）：429→RateLimited / 503→ProviderUnavailable / 504→ProviderTimeout / 其它→ProviderError。

    只有 429/503/504 允许回退（fallback 链）；400/401/500 等标 no_fallback，不静默换 provider。
    """
    message = f"deepseek asr http {status}: {detail}"
    if status == 429:
        error: ProviderError = RateLimited(message, provider="deepseek")
    elif status == 503:
        error = ProviderUnavailable(message, provider="deepseek", code="provider_unavailable")
    elif status == 504:
        error = ProviderTimeout(message, provider="deepseek")
    else:
        error = ProviderError(message, provider="deepseek", detail={"status": status})
    if status not in (429, 503, 504):
        error.no_fallback = True
    return error
