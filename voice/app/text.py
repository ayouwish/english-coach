"""文本工具：规范化、分词、发音词典（mock/模板用）、词级时间轴估计、序列比对。"""

from __future__ import annotations

import difflib
import re

from .phonemes import canonicalize_all

_WORD_RE = re.compile(r"[A-Za-z']+")
_SENT_SPLIT = re.compile(r"[.!?,;:]+")
_VOWELS = set("aeiouy")

# 小型 IPA 词典：覆盖儿童日常场景高频词（mock provider 与 hint 推导共用）。
PHONEME_LEXICON: dict[str, list[str]] = {
    "i": ["aɪ"],
    "a": ["ə"],
    "an": ["ə", "n"],
    "the": ["ð", "ə"],
    "is": ["ɪ", "z"],
    "are": ["ɑ", "ɹ"],
    "am": ["æ", "m"],
    "you": ["j", "u"],
    "your": ["j", "ɔ", "ɹ"],
    "my": ["m", "aɪ"],
    "me": ["m", "i"],
    "we": ["w", "i"],
    "he": ["h", "i"],
    "she": ["ʃ", "i"],
    "it": ["ɪ", "t"],
    "this": ["ð", "ɪ", "s"],
    "that": ["ð", "æ", "t"],
    "these": ["ð", "i", "z"],
    "those": ["ð", "oʊ", "z"],
    "think": ["θ", "ɪ", "ŋ", "k"],
    "thank": ["θ", "æ", "ŋ", "k"],
    "thanks": ["θ", "æ", "ŋ", "k", "s"],
    "three": ["θ", "ɹ", "i"],
    "thick": ["θ", "ɪ", "k"],
    "thin": ["θ", "ɪ", "n"],
    "thing": ["θ", "ɪ", "ŋ"],
    "weather": ["w", "ɛ", "ð", "ə", "ɹ"],
    "father": ["f", "ɑ", "ð", "ə", "ɹ"],
    "mother": ["m", "ʌ", "ð", "ə", "ɹ"],
    "brother": ["b", "ɹ", "ʌ", "ð", "ə", "ɹ"],
    "really": ["ɹ", "ɪ", "l", "i"],
    "nice": ["n", "aɪ", "s"],
    "today": ["t", "ə", "d", "eɪ"],
    "hello": ["h", "ə", "l", "oʊ"],
    "hi": ["h", "aɪ"],
    "good": ["ɡ", "ʊ", "d"],
    "morning": ["m", "ɔ", "ɹ", "n", "ɪ", "ŋ"],
    "afternoon": ["æ", "f", "t", "ə", "ɹ", "n", "u", "n"],
    "evening": ["i", "v", "n", "ɪ", "ŋ"],
    "night": ["n", "aɪ", "t"],
    "school": ["s", "k", "u", "l"],
    "friend": ["f", "ɹ", "ɛ", "n", "d"],
    "book": ["b", "ʊ", "k"],
    "apple": ["æ", "p", "l"],
    "banana": ["b", "ə", "n", "æ", "n", "ə"],
    "water": ["w", "ɔ", "t", "ə", "ɹ"],
    "coffee": ["k", "ɔ", "f", "i"],
    "hot": ["h", "ɑ", "t"],
    "iced": ["aɪ", "s", "t"],
    "cold": ["k", "oʊ", "l", "d"],
    "please": ["p", "l", "i", "z"],
    "want": ["w", "ɑ", "n", "t"],
    "like": ["l", "aɪ", "k"],
    "would": ["w", "ʊ", "d"],
    "can": ["k", "æ", "n"],
    "could": ["k", "ʊ", "d"],
    "what": ["w", "ʌ", "t"],
    "how": ["h", "aʊ"],
    "name": ["n", "eɪ", "m"],
    "fine": ["f", "aɪ", "n"],
    "and": ["æ", "n", "d"],
    "very": ["v", "ɛ", "ɹ", "i"],
    "well": ["w", "ɛ", "l"],
    "red": ["ɹ", "ɛ", "d"],
    "green": ["ɡ", "ɹ", "i", "n"],
    "blue": ["b", "l", "u"],
    "dog": ["d", "ɔ", "ɡ"],
    "cat": ["k", "æ", "t"],
    "play": ["p", "l", "eɪ"],
    "read": ["ɹ", "i", "d"],
    "write": ["ɹ", "aɪ", "t"],
    "listen": ["l", "ɪ", "s", "n"],
    "speak": ["s", "p", "i", "k"],
    "english": ["ɪ", "ŋ", "ɡ", "l", "ɪ", "ʃ"],
    "yes": ["j", "ɛ", "s"],
    "no": ["n", "oʊ"],
    "not": ["n", "ɑ", "t"],
    "one": ["w", "ʌ", "n"],
    "two": ["t", "u"],
    "verymuch": ["v", "ɛ", "ɹ", "i", "m", "ʌ", "tʃ"],
}

# 简易字素->音素（仅用于 mock 假数据 / 无词典词的兜底，不用于真实评测）
_DIGRAPHS = [
    ("tch", ["tʃ"]),
    ("dge", ["dʒ"]),
    ("ch", ["tʃ"]),
    ("sh", ["ʃ"]),
    ("ph", ["f"]),
    ("wh", ["w"]),
    ("th", ["θ"]),
    ("ck", ["k"]),
    ("ng", ["ŋ"]),
    ("qu", ["k", "w"]),
    ("oo", ["u"]),
    ("ee", ["i"]),
    ("ea", ["i"]),
    ("ai", ["eɪ"]),
    ("ay", ["eɪ"]),
    ("oa", ["oʊ"]),
    ("ow", ["aʊ"]),
    ("ou", ["aʊ"]),
    ("oi", ["ɔɪ"]),
    ("oy", ["ɔɪ"]),
]
_SINGLE = {
    "a": "æ",
    "e": "ɛ",
    "i": "ɪ",
    "o": "ɑ",
    "u": "ʌ",
    "y": "i",
    "b": "b",
    "c": "k",
    "d": "d",
    "f": "f",
    "g": "ɡ",
    "h": "h",
    "j": "dʒ",
    "k": "k",
    "l": "l",
    "m": "m",
    "n": "n",
    "p": "p",
    "q": "k",
    "r": "ɹ",
    "s": "s",
    "t": "t",
    "v": "v",
    "w": "w",
    "x": "k s".split()[0],
    "z": "z",
}


def normalize_text(text: str) -> str:
    return " ".join((text or "").lower().split())


def strip_terminal_punct(text: str) -> str:
    return re.sub(r"[\s.!?,;:]+$", "", (text or "").strip())


def tokens(text: str) -> list[str]:
    return [t.lower() for t in _WORD_RE.findall(text or "")]


def sentence_split(text: str) -> list[str]:
    parts = [p.strip() for p in _SENT_SPLIT.split(text or "") if p.strip()]
    return parts or ([text.strip()] if (text or "").strip() else [])


def syllable_count(word: str) -> int:
    word = (word or "").lower()
    count = 0
    prev_vowel = False
    for ch in word:
        is_vowel = ch in _VOWELS
        if is_vowel and not prev_vowel:
            count += 1
        prev_vowel = is_vowel
    if word.endswith("e") and count > 1:
        count -= 1
    return max(1, count)


def _word_phonemes_raw(word: str) -> list[str]:
    """Deterministic IPA-ish phonemes for a word (lexicon first, then grapheme rules)."""
    key = (word or "").lower().strip("'")
    key = re.sub(r"[^a-z']", "", key)
    if not key:
        return []
    if key in PHONEME_LEXICON:
        return list(PHONEME_LEXICON[key])
    contracted = key.replace("'", "")
    if contracted in PHONEME_LEXICON:
        return list(PHONEME_LEXICON[contracted])
    if key.endswith("'s") and key[:-2] in PHONEME_LEXICON:
        return list(PHONEME_LEXICON[key[:-2]]) + ["z"]

    out: list[str] = []
    i = 0
    while i < len(key):
        if i == len(key) - 1 and key[i] == "e" and out and any(ch in "aeiou" for ch in key[:-1]):
            i += 1  # silent final e
            continue
        for graph, phon in _DIGRAPHS:
            if key.startswith(graph, i):
                out.extend(phon)
                i += len(graph)
                break
        else:
            ch = key[i]
            if ch in _SINGLE:
                out.append(_SINGLE[ch])
            i += 1
    return out or ["ə"]


def word_phonemes(word: str) -> list[str]:
    """对外统一输出 canonical-v1 规范符号（去重保序），见 app/phonemes.py。"""
    return canonicalize_all(_word_phonemes_raw(word))


def estimate_word_timings(text: str, duration_ms: int, start_ms: int = 0) -> list[dict]:
    """按音节/字符权重把 duration 线性分配给各词（无 provider 时间戳时的兜底）。"""
    words = tokens(text)
    if not words:
        return []
    weights = [max(1.0, 0.7 * syllable_count(w) + 0.35 * len(w)) for w in words]
    total = sum(weights)
    usable = max(1, int(duration_ms))
    out: list[dict] = []
    cursor = float(start_ms)
    for word, weight in zip(words, weights):
        span = usable * weight / total
        out.append(
            {
                "word": word,
                "start_ms": int(round(cursor)),
                "end_ms": int(round(cursor + span)),
                "probability": None,
            }
        )
        cursor += span
    return out


def align_sequences(reference: list[str], hypothesis: list[str]) -> list[tuple[str, int, int, int, int]]:
    """difflib 比对 -> [('equal'|'replace'|'delete'|'insert', ref_i1, ref_i2, hyp_i1, hyp_i2)]"""
    matcher = difflib.SequenceMatcher(a=[w.lower() for w in reference], b=[w.lower() for w in hypothesis])
    return [(tag, i1, i2, j1, j2) for tag, i1, i2, j1, j2 in matcher.get_opcodes()]


def words_in_span(timings: list[dict], start_ms: int, end_ms: int) -> str:
    hits = []
    for timing in timings or []:
        mid = (timing.get("start_ms", 0) + timing.get("end_ms", 0)) / 2.0
        if start_ms <= mid <= end_ms:
            hits.append(str(timing.get("word", "")))
    if not hits:
        # 退回按重叠面积取词
        for timing in timings or []:
            if timing.get("end_ms", 0) > start_ms and timing.get("start_ms", 0) < end_ms:
                hits.append(str(timing.get("word", "")))
    return " ".join(h for h in hits if h)
