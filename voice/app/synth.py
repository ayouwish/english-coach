"""离线语音合成：mock TTS 用「可被 praat 提取 F0 的浊音信号」模拟带语调的语音。

为什么不用白噪声/静音：语调模块要求任意 provider 下都能给出 F0 曲线与 worst_regions，
mock TTS 必须产出**真的有基频**的音频，否则 mock 模式的 /v1/pronounce 无法演示语调对比。
"""

from __future__ import annotations

import hashlib

import numpy as np

from .audio_io import TARGET_SR, pcm16_wav_bytes

_VOWELS = set("aeiouy")


def _syllable_count(word: str) -> int:
    count = 0
    prev_vowel = False
    for ch in word.lower():
        is_vowel = ch in _VOWELS
        if is_vowel and not prev_vowel:
            count += 1
        prev_vowel = is_vowel
    if word.lower().endswith("e") and count > 1:
        count -= 1
    return max(1, count)


def _base_pitch(voice: str | None) -> float:
    """Deterministic 'speaker' pitch per voice name."""
    name = (voice or "en-US-JennyNeural").lower()
    digest = hashlib.sha1(name.encode("utf-8")).digest()
    if "male" in name or name.endswith("guyneural") or "davis" in name:
        return 110.0 + digest[0] % 20
    if "child" in name or "ana" in name:
        return 240.0 + digest[0] % 30
    return 190.0 + digest[0] % 25


def synthesize_speech(
    text: str,
    voice: str | None = None,
    rate: str = "normal",
    sample_rate: int = TARGET_SR,
) -> np.ndarray:
    """Render a deterministic voiced "speech-like" waveform for ``text``.

    Prosody model: 每词一段，基频做短语下倾（declination），句末问号上扬、句号下降，
    逗号处轻微上扬；音节时长随文本长度变化，``rate='slow'`` 放慢 1.45 倍。
    """
    words = [w for w in (text or "").split() if w]
    if not words:
        words = ["hello"]
    slow = 1.45 if (rate or "normal").lower() == "slow" else 1.0
    base = _base_pitch(voice)
    rate_factor = float(np.clip(base / 190.0, 0.6, 1.6))

    segments: list[np.ndarray] = []
    total_words = len(words)
    for idx, raw_word in enumerate(words):
        word = raw_word.strip()
        clean = "".join(ch for ch in word if ch.isalnum() or ch == "'")
        syll = _syllable_count(clean) if clean else 1
        dur = (0.16 + 0.12 * syll) * slow
        n = max(1, int(sample_rate * dur))
        t = np.arange(n) / sample_rate

        progress = idx / max(1, total_words - 1) if total_words > 1 else 0.0
        # 短语下倾：整体缓慢下降；句末按标点决定升降
        declination = -2.2 * progress
        is_last = idx == total_words - 1
        trailing = raw_word[-1:] if raw_word else ""
        if is_last and trailing == "?":
            contour = np.linspace(0.0, 6.5, n)
        elif is_last and trailing in (",",):
            contour = np.linspace(0.0, 2.5, n)
        elif is_last:
            contour = np.linspace(0.5, -3.5, n)
        else:
            arc = np.sin(np.linspace(0, np.pi, n)) * 1.4
            contour = arc
        semitone = declination + contour
        f0 = base * np.power(2.0, semitone / 12.0)
        # 轻微 jitter，避免完全理想的正弦（更接近真实语音，也让 DTW 有区分度）
        h = hashlib.sha1(f"{clean}|{idx}".encode("utf-8")).digest()
        vibrato = 1.0 + 0.006 * np.sin(2 * np.pi * (4.5 + (h[0] % 5) * 0.2) * t)
        f0 = f0 * vibrato

        phase = 2 * np.pi * np.cumsum(f0) / sample_rate
        wave_out = np.zeros(n, dtype=np.float64)
        for harm, amp in ((1, 1.0), (2, 0.45), (3, 0.22), (4, 0.1), (5, 0.05)):
            wave_out += amp * np.sin(harm * phase)
        wave_out /= 1.82
        # 能量包络（起振/收尾）
        env = np.ones(n)
        ramp = max(1, int(0.012 * sample_rate * slow))
        ramp = min(ramp, n // 2) or 1
        env[:ramp] = np.linspace(0.0, 1.0, ramp)
        env[-ramp:] = np.linspace(1.0, 0.0, ramp)
        wave_out *= env * (0.55 if clean.lower() in ("a", "the", "and", "of", "to") else 0.75)
        segments.append(wave_out.astype(np.float32))
        gap = int(sample_rate * (0.055 * slow)) if not is_last else 0
        if gap:
            segments.append(np.zeros(gap, dtype=np.float32))

    samples = np.concatenate(segments) if segments else np.zeros(int(sample_rate * 0.2), dtype=np.float32)
    peak = float(np.max(np.abs(samples))) or 1.0
    samples = (samples / peak) * 0.85
    return samples.astype(np.float32)


def synthesize_speech_wav(text: str, voice: str | None = None, rate: str = "normal") -> bytes:
    return pcm16_wav_bytes(synthesize_speech(text, voice=voice, rate=rate), TARGET_SR)


def tone_wav(freq: float = 180.0, seconds: float = 1.0, sample_rate: int = TARGET_SR) -> bytes:
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    return pcm16_wav_bytes(0.4 * np.sin(2 * np.pi * freq * t), sample_rate)


def sweep_wav(start_hz: float, end_hz: float, seconds: float = 1.0, sample_rate: int = TARGET_SR) -> bytes:
    """线性扫频（相位连续积分）。"""
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    freq = np.linspace(start_hz, end_hz, t.size)
    phase = 2 * np.pi * np.cumsum(freq) / sample_rate
    return pcm16_wav_bytes(0.4 * np.sin(phase), sample_rate)
