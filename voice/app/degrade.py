"""最终降级实现：当整条 provider 链都挂掉时，仍然给出可用（但显式标注能力缺失）的结果。

这些函数**不依赖任何 provider / 模型 / 网络**，所以永远不会失败。
"""

from __future__ import annotations

import numpy as np

from .audio_io import AudioClip
from .providers.base import PAResult, PAScores, WordScore, build_issue, pron_score_from_words, sort_and_cap_issues
from .synth import synthesize_speech_wav
from .text import estimate_word_timings, syllable_count, tokens


def degraded_assessment(
    clip: AudioClip,
    reference_text: str,
    mode: str = "scripted",
    granularity: str = "phoneme",
    learner_age_band: str | None = None,
) -> PAResult:
    """无 provider 可用时的词级兜底：时长/停顿合理性 + 文本比对，绝不给音素分。"""
    ref_tokens = tokens(reference_text)
    duration_ms = clip.duration_ms
    timings = estimate_word_timings(" ".join(ref_tokens), max(300, duration_ms)) if ref_tokens else []
    words = [
        WordScore(
            word=item["word"],
            start_ms=item["start_ms"],
            end_ms=item["end_ms"],
            score=60.0,
            error_type="None",
            phonemes=[],
        )
        for item in timings
    ]
    syllables = sum(syllable_count(w) for w in ref_tokens) or 1
    seconds = max(0.25, duration_ms / 1000.0)
    rate = syllables / seconds
    ideal = 2.6 if (learner_age_band or "child") == "child" else 3.8
    fluency = float(round(min(100.0, max(40.0, 100.0 - 28.0 * abs(rate - ideal) / ideal)), 1))
    values = [w.score for w in words]
    issues = []
    if duration_ms < 300 and ref_tokens:
        issues.append(
            build_issue(
                word=ref_tokens[0],
                phoneme=None,
                expected=ref_tokens[0],
                actual=None,
                score=None,
                start_ms=0,
                end_ms=max(1, duration_ms),
                error_type="Omission",
            )
        )
    return PAResult(
        provider="degraded",
        granularity="word",
        mode=mode or "scripted",
        reference_text=reference_text or "",
        recognized_text="",
        duration_ms=duration_ms,
        scores=PAScores(
            pron=pron_score_from_words(values) if values else None,
            accuracy=float(round(float(np.mean(values)), 1)) if values else None,
            fluency=fluency,
            completeness=None,
            prosody=None,
        ),
        words=words,
        issues=sort_and_cap_issues(issues, limit=5),
        warnings=["phoneme_level_unavailable"],
        provider_meta={"degraded": True},
    )


def degraded_tts(text: str, voice: str | None = None, rate: str = "normal") -> tuple[bytes, str, int]:
    """最终 TTS 兜底：本地合成一段有基频的音频（语调模块仍然可用）。"""
    from .audio_io import decode_audio

    audio = synthesize_speech_wav(text or "hello", voice=voice, rate=rate)
    try:
        duration_ms = decode_audio(audio).duration_ms
    except Exception:
        duration_ms = 0
    return audio, "audio/wav", duration_ms
