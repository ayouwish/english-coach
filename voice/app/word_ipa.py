"""单词 → IPA 音标（task-86）：cmudict（ARPAbet）→ 美式 GA IPA。

- 全量词典（约 12.6 万词，用户故事里的任意常见词都能查），**不裁剪**
- **惰性加载**：只有真正调用 `/v1/words/ipa` 时才 `import cmudict` + 读词典（启动不加载，冷启动快）
- 多发音最多返回 2 个去重变体；`syllables` 用元音数估算
- 重音标记：多音节词按 cmudict 的 `1`（主）`2`（次）放到音节 onset 前；单音节词不标重音（think → θɪŋk）

映射（与项目 canonical 风格一致）：AA→ɑ AE→æ AH→ʌ AH0→ə AO→ɔ AW→aʊ AY→aɪ
B→b CH→tʃ D→d DH→ð EH→e ER→ɜr（ER0→ər）EY→eɪ F→f G→ɡ HH→h IH→ɪ IY→i JH→dʒ
K→k L→l M→m N→n NG→ŋ OW→əʊ OY→ɔɪ P→p R→r S→s SH→ʃ T→t TH→θ UH→ʊ UW→u
V→v W→w Y→j Z→z ZH→ʒ
"""

from __future__ import annotations

import re
from functools import lru_cache

from .errors import BadRequest, NotFound

MAX_WORD_CHARS = 64
MAX_VARIANTS = 2

ARPABET_TO_IPA: dict[str, str] = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "EH": "e", "ER": "ɜr",
    "EY": "eɪ", "F": "f", "G": "ɡ", "HH": "h", "IH": "ɪ", "IY": "i",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ",
    "OW": "əʊ", "OY": "ɔɪ", "P": "p", "R": "r", "S": "s", "SH": "ʃ",
    "T": "t", "TH": "θ", "UH": "ʊ", "UW": "u", "V": "v", "W": "w",
    "Y": "j", "Z": "z", "ZH": "ʒ",
}
VOWEL_BASES = {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"}
_STRESS_MARK = {"1": "ˈ", "2": "ˌ"}
# 允许：纯字母，可含撇号/连字符（don't、well-known）
_WORD_PATTERN = re.compile(r"^[a-z]+(?:['-][a-z]+)*$")
_PHONE_PATTERN = re.compile(r"^([A-Z]+)([0-2])?$")


@lru_cache(maxsize=1)
def _dictionary() -> dict:
    """惰性加载 cmudict（12.6 万词，~10MB 内存）；import 本模块时不会加载。"""
    import cmudict

    return cmudict.dict()


def _parse_phones(phones: list[str]) -> list[tuple[str, int | None]] | None:
    parsed: list[tuple[str, int | None]] = []
    for raw in phones:
        match = _PHONE_PATTERN.match(str(raw))
        if not match:
            return None
        base = match.group(1)
        if base not in ARPABET_TO_IPA:
            return None
        stress = int(match.group(2)) if match.group(2) is not None else None
        parsed.append((base, stress))
    return parsed or None


def _phone_ipa(base: str, stress: int | None) -> str:
    if base == "AH":
        return "ə" if stress == 0 else "ʌ"
    if base == "ER":
        return "ər" if stress == 0 else "ɜr"
    return ARPABET_TO_IPA[base]


def _syllabify(phones: list[tuple[str, int | None]]) -> list[list[tuple[str, int | None]]]:
    """按"最大 onset（最多 2 个辅音）"粗略分音节；只用于把重音标记放到音节前。"""
    vowel_indices = [index for index, (base, _stress) in enumerate(phones) if base in VOWEL_BASES]
    if len(vowel_indices) <= 1:
        return [phones]
    syllables: list[list[tuple[str, int | None]]] = []
    start = 0
    for order, vowel in enumerate(vowel_indices):
        if order == len(vowel_indices) - 1:
            syllables.append(phones[start:])
            break
        next_vowel = vowel_indices[order + 1]
        cluster = next_vowel - vowel - 1
        if cluster >= 3:
            coda = cluster - 2  # "computer": M | P Y → 上一音节收 M，下一音节 onset P Y
        elif cluster == 2:
            coda = 1  # "winter": N | T；避免把 ln 这类非法组合都当 onset
        else:
            coda = 0
        cut = next_vowel - (cluster - coda)
        syllables.append(phones[start:cut])
        start = cut
    return syllables


def _pronunciation_to_ipa(phones: list[str]) -> tuple[str, int] | None:
    """一条 cmudict 发音 → (IPA, 音节数)。"""
    parsed = _parse_phones(phones)
    if parsed is None:
        return None
    syllables = _syllabify(parsed)
    multi_syllable = len(syllables) > 1
    pieces: list[str] = []
    for syllable in syllables:
        mark = ""
        if multi_syllable:
            for base, stress in syllable:
                if base in VOWEL_BASES and stress in (1, 2):
                    mark = _STRESS_MARK[str(stress)]
                    break
        pieces.append(mark + "".join(_phone_ipa(base, stress) for base, stress in syllable))
    return "".join(pieces), len(syllables)


def normalize_word(word: str | None) -> str:
    """校验并小写化；非法 → 400（空/超长/非字母）。"""
    value = " ".join(str(word or "").split()).strip()
    if not value:
        raise BadRequest("word is required")
    lowered = value.lower()
    if len(lowered) > MAX_WORD_CHARS:
        raise BadRequest(f"word too long: {len(lowered)} > {MAX_WORD_CHARS} chars")
    if not _WORD_PATTERN.match(lowered):
        raise BadRequest("word must contain only English letters (apostrophes / hyphens allowed), got " f"{word!r}")
    return lowered


def _lookup(word: str) -> list[tuple[str, int]]:
    """查询一个（可含连字符的）词 → [(ipa, syllables)]，最多 MAX_VARIANTS 条。"""
    dictionary = _dictionary()
    if word in dictionary:
        results: list[tuple[str, int]] = []
        seen: set[str] = set()
        for phones in dictionary[word]:
            converted = _pronunciation_to_ipa(phones)
            if converted is None or converted[0] in seen:
                continue
            seen.add(converted[0])
            results.append(converted)
            if len(results) >= MAX_VARIANTS:
                break
        return results
    if "-" in word:
        parts = word.split("-")
        parts_results = [_lookup(part) for part in parts]
        if any(not item for item in parts_results):
            return []
        variants: list[tuple[str, int]] = []
        seen = set()
        for index in range(MAX_VARIANTS):
            pieces = []
            syllables = 0
            for item in parts_results:
                ipa, count = item[min(index, len(item) - 1)]
                pieces.append(ipa)
                syllables += count
            variant = ("-".join(pieces), syllables)
            if variant[0] not in seen:
                seen.add(variant[0])
                variants.append(variant)
        return variants
    if word.endswith("'s") and len(word) > 2:
        # 所有格：Ming's -> Ming + z（cmudict 常不收录人名所有格）
        base_results = _lookup(word[:-2])
        if base_results:
            return [(f"{ipa}z", count) for ipa, count in base_results[:MAX_VARIANTS]]
    return []


def word_ipa(word: str | None) -> dict:
    """GET /v1/words/ipa 的实现：返回契约 JSON；未收录 → 404 not_found。"""
    normalized = normalize_word(word)
    results = _lookup(normalized)
    if not results:
        raise NotFound("词典里没有这个词，可以听发音")
    variants = [ipa for ipa, _count in results]
    return {
        "word": normalized,
        "ipa": variants[0],
        "variants": variants,
        "source": "cmudict",
        "syllables": results[0][1],
    }


__all__ = ["word_ipa", "normalize_word", "MAX_WORD_CHARS", "ARPABET_TO_IPA"]
