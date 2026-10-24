"""Provider 包：mock / azure / local + 注册表。"""

from .base import (  # noqa: F401
    ASRProvider,
    ASRResult,
    Capabilities,
    PAIssue,
    PAProvider,
    PAResult,
    PAScores,
    PhonemeScore,
    TTSProvider,
    TTSResult,
    WordScore,
    WordTiming,
)

__all__ = [
    "ASRProvider",
    "ASRResult",
    "Capabilities",
    "PAIssue",
    "PAProvider",
    "PAResult",
    "PAScores",
    "PhonemeScore",
    "TTSProvider",
    "TTSResult",
    "WordScore",
    "WordTiming",
]
