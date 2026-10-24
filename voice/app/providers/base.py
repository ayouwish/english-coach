"""Provider 抽象：ASR / 发音评测(PA) / TTS 三类接口 + 契约数据结构。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from ..audio_io import AudioClip
from ..hints import derive_hint_key, error_type_from_score, severity_from_score

# --------------------------------------------------------------------------------------
# 数据结构（与契约响应字段一一对应）
# --------------------------------------------------------------------------------------


@dataclass
class Capabilities:
    phoneme_level: bool = False
    prosody: bool = False
    nbest_phonemes: bool = False
    ssml: bool = False

    def as_dict(self) -> dict:
        return {
            "phoneme_level": self.phoneme_level,
            "prosody": self.prosody,
            "nbest_phonemes": self.nbest_phonemes,
            "ssml": self.ssml,
        }


@dataclass
class WordTiming:
    word: str
    start_ms: int
    end_ms: int
    probability: float | None = None

    def to_contract(self) -> dict:
        return {
            "word": self.word,
            "start_ms": int(self.start_ms),
            "end_ms": int(self.end_ms),
            "probability": None if self.probability is None else round(float(self.probability), 3),
        }


@dataclass
class ASRResult:
    text: str
    language: str
    duration_ms: int
    words: list[WordTiming] = field(default_factory=list)
    provider: str = "mock"
    provider_meta: dict = field(default_factory=dict)

    def to_contract(self) -> dict:
        return {
            "text": self.text,
            "language": self.language,
            "duration_ms": int(self.duration_ms),
            "words": [w.to_contract() for w in self.words],
            "provider": self.provider,
        }


@dataclass
class PhonemeScore:
    phoneme: str
    score: float
    start_ms: int
    end_ms: int
    nbest: list[dict] = field(default_factory=list)

    def to_contract(self) -> dict:
        return {
            "phoneme": self.phoneme,
            "score": None if self.score is None else round(float(self.score), 1),
            "start_ms": int(self.start_ms),
            "end_ms": int(self.end_ms),
            "nbest": [
                {"phoneme": item.get("phoneme"), "score": None if item.get("score") is None else round(float(item["score"]), 1)}
                for item in self.nbest
            ],
        }


@dataclass
class WordScore:
    word: str
    start_ms: int
    end_ms: int
    score: float | None
    error_type: str = "None"
    phonemes: list[PhonemeScore] = field(default_factory=list)

    def to_contract(self) -> dict:
        return {
            "word": self.word,
            "start_ms": int(self.start_ms),
            "end_ms": int(self.end_ms),
            "score": None if self.score is None else round(float(self.score), 1),
            "error_type": self.error_type,
            "phonemes": [p.to_contract() for p in self.phonemes],
        }


@dataclass
class PAIssue:
    type: str
    severity: str
    word: str
    phoneme: str | None
    expected: str | None
    actual: str | None
    score: float | None
    start_ms: int
    end_ms: int
    hint_key: str | None = None

    def to_contract(self) -> dict:
        return {
            "type": self.type,
            "severity": self.severity,
            "word": self.word,
            "phoneme": self.phoneme,
            "expected": self.expected,
            "actual": self.actual,
            "score": None if self.score is None else round(float(self.score), 1),
            "start_ms": int(self.start_ms),
            "end_ms": int(self.end_ms),
            "hint_key": self.hint_key
            or derive_hint_key(self.phoneme, self.actual, self.word, self.type),
        }


@dataclass
class PAScores:
    pron: float | None = None
    accuracy: float | None = None
    fluency: float | None = None
    completeness: float | None = None
    prosody: float | None = None

    def to_contract(self) -> dict:
        def r(value):
            return None if value is None else round(float(value), 1)

        return {
            "pron": r(self.pron),
            "accuracy": r(self.accuracy),
            "fluency": r(self.fluency),
            "completeness": r(self.completeness),
            "prosody": r(self.prosody),
        }


@dataclass
class PAResult:
    provider: str
    granularity: str
    mode: str
    reference_text: str
    recognized_text: str
    duration_ms: int
    scores: PAScores = field(default_factory=PAScores)
    words: list[WordScore] = field(default_factory=list)
    issues: list[PAIssue] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    provider_meta: dict = field(default_factory=dict)


@dataclass
class TTSResult:
    audio: bytes
    content_type: str
    provider: str
    duration_ms: int = 0
    format: str = "wav"


# --------------------------------------------------------------------------------------
# 公共打分工具
# --------------------------------------------------------------------------------------
def pron_score_from_words(word_scores: list[float | None]) -> float | None:
    """scores.pron 兜底公式：0.4*最差 + 0.2*次差 + 0.2*第三 + 0.2*最好（四项时）。"""
    values = sorted(float(v) for v in word_scores if v is not None)
    if not values:
        return None
    if len(values) >= 4:
        worst = values[0]
        middle = values[1:3]
        best = values[-1]
        score = 0.4 * worst + 0.2 * middle[0] + 0.2 * middle[1] + 0.2 * best
    else:
        score = sum(values) / len(values)
    return round(min(100.0, max(0.0, score)), 1)


def sort_and_cap_issues(issues: list[PAIssue], limit: int = 5) -> list[PAIssue]:
    from ..hints import severity_rank

    ordered = sorted(issues, key=lambda i: (severity_rank(i.severity), i.score if i.score is not None else 100.0))
    return ordered[:limit]


def build_issue(
    word: str,
    phoneme: str | None,
    expected: str | None,
    actual: str | None,
    score: float | None,
    start_ms: int,
    end_ms: int,
    error_type: str,
    hint_key: str | None = None,
) -> PAIssue:
    return PAIssue(
        type=error_type,
        severity=severity_from_score(score, error_type),
        word=word,
        phoneme=phoneme,
        expected=expected,
        actual=actual,
        score=score,
        start_ms=start_ms,
        end_ms=end_ms,
        hint_key=derive_hint_key(phoneme, actual, word, error_type, explicit=hint_key),
    )


# --------------------------------------------------------------------------------------
# Protocols
# --------------------------------------------------------------------------------------
class ASRProvider(Protocol):
    name: str
    capabilities: Capabilities

    def recognize(self, clip: AudioClip, language: str = "en", prompt: str | None = None) -> ASRResult: ...


class PAProvider(Protocol):
    name: str
    capabilities: Capabilities

    def assess(
        self,
        clip: AudioClip,
        reference_text: str,
        mode: str = "scripted",
        granularity: str = "phoneme",
        with_intonation: bool = True,
        learner_age_band: str | None = None,
    ) -> PAResult: ...


class TTSProvider(Protocol):
    name: str
    capabilities: Capabilities

    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        rate: str = "normal",
        fmt: str = "mp3",
        ssml: str | None = None,
    ) -> TTSResult: ...


__all__ = [
    "Capabilities",
    "WordTiming",
    "ASRResult",
    "PhonemeScore",
    "WordScore",
    "PAIssue",
    "PAScores",
    "PAResult",
    "TTSResult",
    "ASRProvider",
    "PAProvider",
    "TTSProvider",
    "pron_score_from_words",
    "sort_and_cap_issues",
    "build_issue",
    "error_type_from_score",
]
