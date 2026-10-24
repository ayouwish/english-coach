"""hint_key / error_type / severity 的映射规则（契约 §3.1：映射由 voice 决定，web 不重算）。

音素符号统一走 `app/phonemes.py` 的规范空间：这里的表在 import 时会被规范化，
所以表里可以继续写 `ɹ`/`ɛ` 这类变体（会被折叠到 `r`/`e`），下游只需认识规范符号。
"""

from __future__ import annotations

from .phonemes import canonicalize_phoneme, looks_like_phoneme

# 冻结枚举
ERROR_TYPES: tuple[str, ...] = (
    "None",
    "Mispronunciation",
    "Omission",
    "Insertion",
    "UnexpectedBreak",
    "MissingBreak",
    "Monotone",
)

SEVERITIES: tuple[str, ...] = ("high", "medium", "low")

HINT_KEYS: tuple[str, ...] = (
    "th_voiceless",
    "th_voiced",
    "r_l_v",
    "v_w",
    "short_i_long_i",
    "ae_e",
    "s_sh",
    "n_ng",
    "l_dark",
    "schwa",
    "final_consonant",
    "consonant_cluster",
    "stress_wrong",
    "monotone",
    "pause_wrong",
    "omission",
    "insertion",
)

WARNINGS: tuple[str, ...] = (
    "phoneme_level_unavailable",
    "prosody_unavailable",
    "intonation_unavailable",
    "low_snr",
    "too_short",
    "asr_mismatch",
    "provider_fallback",
)

# IPA -> hint_key（键会被规范化到 canonical-v1，例如 ɹ 与 r 折叠成同一个键）
_RAW_PHONEME_HINT: dict[str, str] = {
    "θ": "th_voiceless",
    "ð": "th_voiced",
    "ɹ": "r_l_v",
    "r": "r_l_v",
    "l": "r_l_v",
    "v": "v_w",
    "w": "v_w",
    "ɪ": "short_i_long_i",
    "i": "short_i_long_i",
    "æ": "ae_e",
    "ɛ": "ae_e",
    "e": "ae_e",
    "s": "s_sh",
    "ʃ": "s_sh",
    "n": "n_ng",
    "ŋ": "n_ng",
    "ə": "schwa",
    "ʌ": "schwa",
}

# 常见「听上去像」的错误替代（用于 nbest / actual 展示，也用于 hint 推导）
_RAW_LIKELY_SUBSTITUTION: dict[str, str] = {
    "θ": "s",
    "ð": "z",
    "ɹ": "w",
    "l": "ʊ",
    "v": "w",
    "w": "v",
    "æ": "ɛ",
    "ɪ": "i",
    "i": "ɪ",
    "s": "ʃ",
    "ʃ": "s",
    "ŋ": "n",
    "n": "ŋ",
    "ə": "ʌ",
}

# 键/值都规范化：保证下游查表用的都是 canonical-v1 符号
PHONEME_HINT: dict[str, str] = {canonicalize_phoneme(k): v for k, v in _RAW_PHONEME_HINT.items()}
LIKELY_SUBSTITUTION: dict[str, str] = {
    canonicalize_phoneme(k): canonicalize_phoneme(v) for k, v in _RAW_LIKELY_SUBSTITUTION.items()
}

ERROR_TYPE_BY_HINT: dict[str, str] = {
    "omission": "Omission",
    "insertion": "Insertion",
    "pause_wrong": "UnexpectedBreak",
    "monotone": "Monotone",
}

_ENDS_CONSONANT = set("bcdfghjklmnpqrstvwxyz")


def severity_from_score(score: float | None, error_type: str = "Mispronunciation") -> str:
    if error_type in ("Omission", "Insertion"):
        return "high" if error_type == "Omission" else "medium"
    if error_type == "Monotone":
        return "low"
    if score is None:
        return "medium"
    if score < 50.0:
        return "high"
    if score < 70.0:
        return "medium"
    return "low"


def severity_rank(severity: str) -> int:
    return {"high": 0, "medium": 1, "low": 2}.get(severity, 3)


def error_type_from_score(score: float | None) -> str:
    if score is None:
        return "None"
    return "Mispronunciation" if score < 70.0 else "None"


def derive_hint_key(
    phoneme: str | None = None,
    actual: str | None = None,
    word: str = "",
    error_type: str = "Mispronunciation",
    explicit: str | None = None,
) -> str:
    """把 issue 映射到一个合法的 hint_key（必须在 HINT_KEYS 内）。

    入口先做音素符号归一化，所以无论调用方给的是 Azure 变体（ɹ/ɛ/ɝ）还是语料符号（ɒ/ɑː），
    都会落到同一张 hint 表上（同一个错误 -> 同一条教学提示）。
    """
    if explicit and explicit in HINT_KEYS:
        return explicit
    if looks_like_phoneme(phoneme):
        phoneme = canonicalize_phoneme(phoneme)
    if looks_like_phoneme(actual):
        actual = canonicalize_phoneme(actual)
    if error_type == "Omission":
        return "omission"
    if error_type == "Insertion":
        return "insertion"
    if error_type in ("UnexpectedBreak", "MissingBreak"):
        return "pause_wrong"
    if error_type == "Monotone":
        return "monotone"
    if phoneme and phoneme in PHONEME_HINT:
        return PHONEME_HINT[phoneme]
    if actual and actual in PHONEME_HINT:
        return PHONEME_HINT[actual]

    low = (word or "").lower()
    if "th" in low:
        return "th_voiced" if low in ("the", "this", "that", "these", "those", "they", "them", "there") else "th_voiceless"
    if "ng" in low:
        return "n_ng"
    if "sh" in low or "ch" in low:
        return "s_sh"
    if "v" in low or "w" in low:
        return "v_w"
    if "r" in low or "l" in low:
        return "r_l_v"
    if low and low[-1] in _ENDS_CONSONANT:
        return "final_consonant"
    return "schwa"


def dedupe_warnings(warnings: list[str]) -> list[str]:
    """只保留契约允许的 warning，保持首次出现顺序。"""
    seen: list[str] = []
    for item in warnings:
        if item in WARNINGS and item not in seen:
            seen.append(item)
    return seen
