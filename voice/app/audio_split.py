"""按静音切分长音频（task-75 抽自智谱 ASR，task-112 供 DeepSeek ASR 复用）。

- 从目标切点向前找连续 ≥150ms 的静音（20ms 帧 RMS < 阈值）作为切点，切在静音中间；
- 找不到静音 → 硬切（保证不超限，不静默截断）；
- 音频 ≤ max_seconds → 原样返回一段；`absolute_max_seconds` 是 provider 的硬上限。
"""

from __future__ import annotations

import numpy as np


def _frame_rms(samples: np.ndarray, frame: int, hop: int) -> np.ndarray:
    if samples.size == 0:
        return np.zeros(0, dtype=np.float32)
    count = 1 + max(0, (samples.size - frame) // hop)
    out = np.empty(count, dtype=np.float32)
    for index in range(count):
        window = samples[index * hop : index * hop + frame]
        out[index] = float(np.sqrt(np.mean(window * window))) if window.size else 0.0
    return out


def split_audio_by_silence(
    samples: np.ndarray,
    sample_rate: int,
    max_seconds: float = 25.0,
    absolute_max_seconds: float = 30.0,
) -> list[np.ndarray]:
    if samples.size == 0:
        return [samples]
    max_seconds = max(2.0, min(float(max_seconds), float(absolute_max_seconds)))
    max_samples = int(max_seconds * sample_rate)
    if samples.size <= max_samples:
        return [samples]

    hop = max(1, int(sample_rate * 0.01))  # 10ms
    frame = max(hop, int(sample_rate * 0.02))  # 20ms
    rms = _frame_rms(samples, frame, hop)
    threshold = max(0.008, float(np.percentile(rms, 25)) * 0.5)
    quiet_frames = 15  # 150ms

    def _is_quiet(index: int) -> bool:
        lo = max(0, index - quiet_frames // 2)
        hi = min(len(rms), index + quiet_frames // 2 + 1)
        return hi > lo and bool(np.all(rms[lo:hi] < threshold * 1.5))

    segments: list[np.ndarray] = []
    start = 0
    min_segment = int(4.0 * sample_rate)
    while samples.size - start > max_samples:
        target = start + max_samples
        search_floor = max(start + min_segment, target - int(8.0 * sample_rate))
        cut = target
        for pos in range(target, search_floor, -hop):
            index = pos // hop
            if index < len(rms) and _is_quiet(index):
                cut = int((index + 0.5) * hop)
                break
        cut = max(start + int(2.0 * sample_rate), min(cut, start + max_samples))
        segments.append(samples[start:cut])
        start = cut
    segments.append(samples[start:])
    return segments
