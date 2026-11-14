"""智谱 GLM-ASR（task-75）：中文/中英混杂长音频识别，官方文档（2026-11 核对）：

- 端点：`POST {base}/audio/transcriptions`（base = https://open.bigmodel.cn/api/paas/v4）
- 认证：`Authorization: Bearer <API_KEY>`
- multipart：`file`（binary，支持 .wav/.mp3）+ `model`（文档枚举 `glm-asr-2512`，默认值同）
- 其余可选：`prompt`（长文本上下文，建议 <8000 字）、`hotwords`、`stream=false`、`request_id`、`user_id`
- **限制**：文件 ≤ 25MB、音频时长 ≤ **30 秒** → 超长必须切段（本模块按静音切段后逐段识别再拼接）
- 响应 JSON：`{"id","created","model","text","request_id"}`；`stream=true` 时是 SSE delta
- 计费 0.06 元/分钟；V0 并发 5（遇到 429 按 1s/2s 重试，最多 2 次）

实现要点：不静默截断；切段时返回 `warnings=["segmented"]`，并带 `provider_meta.segments`。
"""

from __future__ import annotations

import logging
import time

import httpx
import numpy as np

from ..audio_io import AudioClip, pcm16_wav_bytes
from ..config import Settings, get_settings
from ..errors import ProviderError, ProviderTimeout, ProviderUnavailable
from .base import ASRResult, Capabilities

logger = logging.getLogger("voice.zhipu_asr")

ZHIPU_ASR_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
ZHIPU_ASR_DEFAULT_MODEL = "glm-asr-2512"
# 文档限制：音频 ≤ 30s；留安全余量 + 允许配置
ZHIPU_ASR_MAX_CHUNK_SECONDS = 30.0
ZHIPU_ASR_MAX_ATTEMPTS = 3  # 首次 + 2 次重试（429/5xx，1s/2s 退避）
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def zhipu_asr_available(settings: Settings | None = None) -> tuple[bool, str | None]:
    """健康检查用：智谱 ASR 是否配置齐全（ZHIPU_ASR_API_KEY 或 IMAGE_API_KEY）。"""
    settings = settings or get_settings()
    key = settings.zhipu_asr_api_key or settings.image_api_key
    if not key:
        return False, "ZHIPU_ASR_API_KEY / IMAGE_API_KEY 未配置"
    return True, None


def _api_key(settings: Settings) -> str:
    key = settings.zhipu_asr_api_key or settings.image_api_key
    if not key:
        raise ProviderUnavailable(
            "智谱 ASR 未配置 key：请在 .env 设置 ZHIPU_ASR_API_KEY（或复用 IMAGE_API_KEY）并重建镜像",
            provider="zhipu",
        )
    return key


from ..audio_split import split_audio_by_silence as _generic_split_audio_by_silence


def split_audio_by_silence(samples, sample_rate: int, max_seconds: float = 25.0):
    """智谱 ASR 的切段（硬上限 30s，文档限制）。通用实现见 app/audio_split.py。"""
    return _generic_split_audio_by_silence(
        samples, sample_rate, max_seconds, absolute_max_seconds=ZHIPU_ASR_MAX_CHUNK_SECONDS
    )


def _join_texts(texts: list[str]) -> str:
    """中文段之间直接拼接；含英文的段用空格拼接（避免拼音/英文粘连）。"""
    cleaned = [text.strip() for text in texts if text and text.strip()]
    if not cleaned:
        return ""
    has_ascii_letters = any(any("a" <= ch.lower() <= "z" for ch in text) for text in cleaned)
    joiner = " " if has_ascii_letters else ""
    return joiner.join(cleaned)


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


class ZhipuASR:
    name = "zhipu"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def recognize(self, clip: AudioClip, language: str = "en", prompt: str | None = None) -> ASRResult:
        settings = get_settings()
        key = _api_key(settings)
        # 中文/中英混杂：GLM-ASR 自行判断语言，不用传 language（文档没有该参数）
        chunks = split_audio_by_silence(clip.samples, clip.sample_rate, settings.zhipu_asr_chunk_seconds)
        texts: list[str] = []
        for chunk_samples in chunks:
            wav = pcm16_wav_bytes(chunk_samples, clip.sample_rate)
            text = self._transcribe(wav, settings, key, prompt=prompt)
            if text:
                texts.append(text)
            prompt = None  # 上下文只在第一段传，避免把前文重复塞给后续段
        warnings = ["segmented"] if len(chunks) > 1 else []
        return ASRResult(
            text=_join_texts(texts),
            language=language,
            duration_ms=clip.duration_ms,
            words=[],
            provider=self.name,
            provider_meta={
                "model": settings.zhipu_asr_model,
                "segments": len(chunks),
                "chunk_seconds": settings.zhipu_asr_chunk_seconds,
            },
            warnings=warnings,
        )

    def _transcribe(self, wav_bytes: bytes, settings: Settings, key: str, prompt: str | None = None) -> str:
        url = settings.zhipu_asr_base_url.rstrip("/") + "/audio/transcriptions"
        data = {"model": settings.zhipu_asr_model, "stream": "false"}
        if prompt:
            data["prompt"] = prompt[:8000]
        headers = {"Authorization": f"Bearer {key}"}
        files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
        last_detail = ""
        for attempt in range(1, ZHIPU_ASR_MAX_ATTEMPTS + 1):
            try:
                response = httpx.post(
                    url, headers=headers, data=data, files=files, timeout=settings.zhipu_asr_timeout_s
                )
            except httpx.TimeoutException as exc:
                raise ProviderTimeout(
                    f"zhipu asr timed out after {settings.zhipu_asr_timeout_s:.0f}s", provider="zhipu"
                ) from exc
            except httpx.HTTPError as exc:
                last_detail = f"{type(exc).__name__}: {exc}"
                if attempt < ZHIPU_ASR_MAX_ATTEMPTS:
                    logger.warning("zhipu asr transport error (attempt %d): %s", attempt, last_detail)
                    time.sleep(float(attempt))
                    continue
                raise ProviderError(f"zhipu asr request failed: {last_detail}", provider="zhipu") from exc

            if response.status_code == 200:
                try:
                    payload = response.json()
                except ValueError as exc:
                    raise ProviderError("zhipu asr returned non-JSON body", provider="zhipu") from exc
                text = ""
                if isinstance(payload, dict):
                    text = str(payload.get("text") or "").strip()
                return text

            last_detail = f"HTTP {response.status_code}: {_error_detail(response)}"
            if response.status_code in RETRYABLE_STATUS and attempt < ZHIPU_ASR_MAX_ATTEMPTS:
                logger.warning("zhipu asr %s (attempt %d), retrying", response.status_code, attempt)
                time.sleep(float(attempt))  # 1s, 2s
                continue
            if response.status_code in RETRYABLE_STATUS:
                raise ProviderError(
                    f"zhipu asr failed after {ZHIPU_ASR_MAX_ATTEMPTS} attempts: {last_detail}",
                    provider="zhipu",
                    detail={"status": response.status_code},
                )
            raise ProviderError(f"zhipu asr error: {last_detail}", provider="zhipu", detail={"status": response.status_code})
        raise ProviderError(f"zhipu asr failed: {last_detail}", provider="zhipu")
