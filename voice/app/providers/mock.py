"""mock provider：确定性、离线、零模型依赖，用于 E2E 测试与无密钥开发。

红线：mock 数据是**假数据**，但字段结构与枚举完全按契约，且可复现（同输入 -> 同输出）。
"""

from __future__ import annotations

import hashlib

import numpy as np

from ..audio_io import AudioClip, decode_audio
from ..hints import LIKELY_SUBSTITUTION, error_type_from_score
from ..phonemes import canonicalize_phoneme
from ..synth import synthesize_speech_wav
from ..text import estimate_word_timings, syllable_count, tokens, word_phonemes
from .base import (
    ASRResult,
    Capabilities,
    PAIssue,
    PAResult,
    PAScores,
    PhonemeScore,
    TTSResult,
    WordScore,
    WordTiming,
    build_issue,
    pron_score_from_words,
    sort_and_cap_issues,
)

CANNED_SENTENCES = (
    "I think the weather is really nice today",
    "Can I have a glass of water please",
    "My name is Lily and I am seven years old",
    "The dog is playing in the green park",
)

# 规范空间（canonical-v1）里的"容易读错"音素
_DIFFICULT_PHONEMES = ("θ", "ð", "r", "l", "v", "æ", "ɪ", "ʃ", "ŋ", "ɜ", "ɑ")

_RAW_SUBSTITUTE_ALTS = {
    "θ": ("s", "f", "t"),
    "ð": ("z", "d", "v"),
    "ɹ": ("w", "l", "ɹ"),
    "l": ("ʊ", "w", "n"),
    "v": ("w", "b", "f"),
    "æ": ("ɛ", "e", "ʌ"),
    "ɪ": ("i", "e", "ə"),
    "s": ("ʃ", "θ", "z"),
    "ʃ": ("s", "tʃ", "ʒ"),
    "ŋ": ("n", "ŋ", "ɡ"),
    "ə": ("ʌ", "ɪ", "ɔ"),
}

# 键/值统一规范化：mock 产出的 nbest 备选也必须是规范符号
_SUBSTITUTE_ALTS = {
    canonicalize_phoneme(key): tuple(canonicalize_phoneme(item) for item in values)
    for key, values in _RAW_SUBSTITUTE_ALTS.items()
}


def _digest_int(*parts: str) -> int:
    return int(hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:8], 16)


def _jitter(seed: str, span: int = 4) -> int:
    return (_digest_int(seed) % (2 * span + 1)) - span


class MockASR:
    name = "mock"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def recognize(self, clip: AudioClip, language: str = "en", prompt: str | None = None) -> ASRResult:
        digest = hashlib.sha1(clip.samples.tobytes()[:4096] or b"mock").hexdigest()
        text = CANNED_SENTENCES[int(digest[:8], 16) % len(CANNED_SENTENCES)]
        timings = estimate_word_timings(text, max(200, clip.duration_ms))
        words = []
        for idx, item in enumerate(timings):
            prob = 0.70 + (_digest_int(text, item["word"], str(idx)) % 29) / 100.0
            words.append(
                WordTiming(
                    word=item["word"],
                    start_ms=item["start_ms"],
                    end_ms=min(item["end_ms"], clip.duration_ms),
                    probability=min(0.99, prob),
                )
            )
        return ASRResult(
            text=text,
            language=language or "en",
            duration_ms=clip.duration_ms,
            words=words,
            provider=self.name,
            provider_meta={"synthetic": True},
        )


class MockPA:
    name = "mock"
    capabilities = Capabilities(phoneme_level=True, prosody=True, nbest_phonemes=True, ssml=False)

    # -- deterministic fake scoring rules ------------------------------------------------
    @staticmethod
    def _word_score(word: str, seed: str) -> float:
        low = word.lower()
        if "th" in low:
            base = 52.0
        elif any(ch in low for ch in "rl"):
            base = 74.0
        elif len(low) >= 7:
            base = 82.0
        elif low in ("i", "a", "the", "is", "and"):
            base = 94.0
        else:
            base = 88.0
        return float(min(100.0, max(8.0, base + _jitter(f"{seed}:{low}"))))

    def _word_entry(self, word: str, timing: dict, seed: str, want_phonemes: bool) -> WordScore:
        score = self._word_score(word, seed)
        error_type = error_type_from_score(score)
        phonemes: list[PhonemeScore] = []
        if want_phonemes:
            phoneme_seq = word_phonemes(word)
            if phoneme_seq:
                # 最容易出错的音素 = 出错点（θ/ð/ɹ/l...），其余音素给更高的分
                culprit = next((i for i, p in enumerate(phoneme_seq) if p in _DIFFICULT_PHONEMES), 0)
                span = max(1, (timing["end_ms"] - timing["start_ms"]) // len(phoneme_seq))
                for idx, phoneme in enumerate(phoneme_seq):
                    start = timing["start_ms"] + idx * span
                    end = min(timing["end_ms"], start + span)
                    if idx == culprit and error_type != "None":
                        p_score = max(5.0, score - 6.0 + _jitter(f"ph:{seed}:{word}:{phoneme}", 3))
                        actual = LIKELY_SUBSTITUTION.get(phoneme, "ə")
                        nbest = [{"phoneme": actual, "score": 100.0}]
                        for alt in _SUBSTITUTE_ALTS.get(phoneme, ("ə",))[:2]:
                            if alt != actual:
                                nbest.append({"phoneme": alt, "score": 55.0 + _jitter(f"alt:{alt}:{word}")})
                    else:
                        p_score = min(100.0, score + 12.0 + _jitter(f"phok:{seed}:{word}:{phoneme}", 4))
                        actual = None
                        nbest = [{"phoneme": phoneme, "score": 100.0}]
                    phonemes.append(
                        PhonemeScore(
                            phoneme=phoneme,
                            score=p_score,
                            start_ms=int(start),
                            end_ms=int(end),
                            nbest=nbest if _digest_int(seed, word, phoneme) % 4 != 3 else [{"phoneme": phoneme, "score": 100.0}],
                        )
                    )
                if phonemes:
                    scores = [p.score for p in phonemes]
                    score = float(round(sum(scores) / len(scores), 1))
                    error_type = error_type_from_score(min(scores))
        return WordScore(
            word=word,
            start_ms=int(timing["start_ms"]),
            end_ms=int(timing["end_ms"]),
            score=round(score, 1),
            error_type=error_type,
            phonemes=phonemes,
        )

    def assess(
        self,
        clip: AudioClip,
        reference_text: str,
        mode: str = "scripted",
        granularity: str = "phoneme",
        with_intonation: bool = True,
        learner_age_band: str | None = None,
    ) -> PAResult:
        duration_ms = clip.duration_ms
        ref_tokens = tokens(reference_text)
        scripted = bool(ref_tokens) and mode != "unscripted"
        want_phonemes = granularity == "phoneme"

        if scripted:
            spoken = ref_tokens
            completeness: float | None = 100.0
            recognized_text = " ".join(ref_tokens)
        else:
            asr = MockASR().recognize(clip)
            recognized_text = asr.text
            spoken = tokens(recognized_text)
            completeness = None

        seed = hashlib.sha1(("|".join(ref_tokens) or recognized_text).encode("utf-8")).hexdigest()[:10]
        timings = estimate_word_timings(recognized_text, max(300, duration_ms))
        words: list[WordScore] = [
            self._word_entry(timing["word"], timing, seed, want_phonemes) for timing in timings
        ]

        issues: list[PAIssue] = []
        for word in words:
            if word.error_type == "None":
                continue
            culprit = None
            if word.phonemes:
                culprit = min(word.phonemes, key=lambda p: p.score)
            issues.append(
                build_issue(
                    word=word.word,
                    phoneme=culprit.phoneme if culprit else None,
                    expected=culprit.phoneme if culprit else None,
                    actual=(
                        culprit.nbest[0]["phoneme"]
                        if culprit and culprit.nbest and culprit.nbest[0].get("phoneme") != culprit.phoneme
                        else LIKELY_SUBSTITUTION.get(culprit.phoneme, None) if culprit else None
                    ),
                    score=culprit.score if culprit else word.score,
                    start_ms=culprit.start_ms if culprit else word.start_ms,
                    end_ms=culprit.end_ms if culprit else word.end_ms,
                    error_type=word.error_type,
                )
            )

        word_scores = [w.score for w in words]
        accuracy = round(float(np.mean(word_scores)), 1) if word_scores else None
        pron = pron_score_from_words(word_scores)
        fluency = self._fluency(recognized_text, duration_ms, learner_age_band)

        return PAResult(
            provider=self.name,
            granularity="phoneme" if (want_phonemes and scripted) else "word",
            mode=mode or "scripted",
            reference_text=reference_text or "",
            recognized_text=recognized_text,
            duration_ms=duration_ms,
            scores=PAScores(
                pron=pron,
                accuracy=accuracy,
                fluency=fluency,
                completeness=completeness,
                prosody=None,  # 由 route 用与 provider 无关的语调模块补齐
            ),
            words=words,
            issues=sort_and_cap_issues(issues, limit=5),
            warnings=[],
            provider_meta={"synthetic": True, "seed": seed},
        )

    @staticmethod
    def _fluency(text: str, duration_ms: int, learner_age_band: str | None) -> float:
        syllables = sum(syllable_count(w) for w in tokens(text)) or 1
        seconds = max(0.25, duration_ms / 1000.0)
        rate = syllables / seconds
        ideal = 2.6 if (learner_age_band or "child") == "child" else 3.8
        score = 100.0 - 30.0 * abs(rate - ideal) / ideal
        return float(round(min(100.0, max(45.0, score)), 1))


class MockTTS:
    name = "mock"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        rate: str = "normal",
        fmt: str = "mp3",
        ssml: str | None = None,
    ) -> TTSResult:
        payload_text = _text_from_ssml(ssml) if ssml else text
        audio = synthesize_speech_wav(payload_text, voice=voice, rate=rate)
        try:
            duration_ms = decode_audio(audio).duration_ms
        except Exception:
            duration_ms = 0
        return TTSResult(audio=audio, content_type="audio/wav", provider=self.name, duration_ms=duration_ms, format="wav")


def _text_from_ssml(ssml: str) -> str:
    import re

    return " ".join(re.sub(r"<[^>]+>", " ", ssml or "").split()) or "hello"
