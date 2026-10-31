"""多段音频按序拼接（task-67：对话训练结束后拼成一段连续音频）。

web 按对话顺序上传「用户每轮录音 + 助手每轮 TTS(wav)」，服务端逐段解码（PyAV，任意格式）、
插入固定静音间隔、输出 16kHz 单声道 PCM16 WAV。不落盘、不缓存。
"""

from __future__ import annotations

import logging

import numpy as np

from .audio_io import TARGET_SR, AudioTooLong, AudioClip, UnsupportedAudio, decode_audio, pcm16_wav_bytes
from .errors import BadRequest, PayloadTooLarge

logger = logging.getLogger("voice.audio_concat")

MAX_PARTS = 200
MAX_GAP_MS = 2000
MAX_PART_SECONDS = 300.0
MAX_TOTAL_SECONDS = 900.0  # 15 分钟
MAX_TOTAL_INPUT_BYTES = 200 * 1024 * 1024  # 200MB 输入上限（200 段 × 平均 1MB）


def concat_audio(segments: list[bytes], gap_ms: int = 250) -> tuple[bytes, int]:
    """按顺序拼接音频 -> (16kHz mono PCM16 WAV 字节, 总时长 ms)。

    - 段间插入 `gap_ms` 静音（0–2000ms）
    - 任一段解码失败 → `UnsupportedAudio`（message 含"第 N 段"），绝不静默跳过
    - 单段 >300s / 总时长 >900s → `AudioTooLong`；段数 >200 → `PayloadTooLarge`
    """
    if not isinstance(gap_ms, int) or gap_ms < 0 or gap_ms > MAX_GAP_MS:
        raise BadRequest(f"gap_ms must be an integer between 0 and {MAX_GAP_MS}, got {gap_ms!r}")
    if not segments:
        raise BadRequest("parts is required (at least one audio segment)")
    if len(segments) > MAX_PARTS:
        raise PayloadTooLarge(f"too many parts: {len(segments)} > {MAX_PARTS}")

    gap_samples = int(round(TARGET_SR * gap_ms / 1000.0))
    gap = np.zeros(gap_samples, dtype=np.float32)
    pieces: list[np.ndarray] = []
    total_samples = 0
    for index, data in enumerate(segments, start=1):
        try:
            clip: AudioClip = decode_audio(data, TARGET_SR, MAX_PART_SECONDS)
        except AudioTooLong as exc:
            raise AudioTooLong(
                f"第 {index} 段音频超过 {MAX_PART_SECONDS:.0f}s 上限：{exc.message}",
                detail={"part": index},
            ) from exc
        except UnsupportedAudio as exc:
            raise UnsupportedAudio(
                f"第 {index} 段音频无法解码：{exc.message}", detail={"part": index}, status=400
            ) from exc
        except Exception as exc:  # 防御：解码器的未知异常也按"该段坏"处理
            raise UnsupportedAudio(
                f"第 {index} 段音频无法解码：{type(exc).__name__}", detail={"part": index}, status=400
            ) from exc
        if clip.samples.size == 0:
            raise UnsupportedAudio(f"第 {index} 段音频没有可解码的采样", detail={"part": index}, status=400)
        if index > 1:
            pieces.append(gap)
            total_samples += gap_samples
        pieces.append(np.asarray(clip.samples, dtype=np.float32))
        total_samples += int(clip.samples.size)

    total_seconds = total_samples / float(TARGET_SR)
    if total_seconds > MAX_TOTAL_SECONDS:
        raise AudioTooLong(
            f"拼接后总时长 {total_seconds:.1f}s 超过 {MAX_TOTAL_SECONDS:.0f}s 上限（15 分钟）",
            detail={"total_seconds": round(total_seconds, 2)},
        )
    samples = np.concatenate(pieces) if len(pieces) > 1 else pieces[0]
    wav = pcm16_wav_bytes(samples, TARGET_SR)
    total_ms = int(round(total_samples / float(TARGET_SR) * 1000))
    logger.info("audio concat: segments=%d gap_ms=%d total_ms=%d", len(segments), gap_ms, total_ms)
    return wav, total_ms
