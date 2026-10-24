"""音素符号归一化接缝（v1.2）——保护 `phoneme_mastery` / `srs_cards` 的 key 一致性。

## 为什么

`focus_phonemes` 是 `srs_cards(kind=phoneme)` 的 key，也是 web 侧 `hintKeyForPhoneme()` 的依据。
语料标注用英式 RP 符号（`ɒ ɑː ɔː ɜː iː uː əʊ`），而全链路目标是 **en-US**，
云 provider（Azure）返回的 IPA 很可能用另一套写法（`ɹ ɛ ɝ ɚ` 等）。
若不归一化：同一个发音错误（例如 "hot" 的元音）会生成 `ɒ` 和 `ɑ` **两张卡**，
`phoneme_mastery` 的长期曲线会静默断链——不报错，只是数据慢慢失去意义。

## 规范空间（canonical space · canonical-v1）

本模块把各种变体映射到下面这套**唯一**符号集，voice 对外（`/v1/pronounce` 响应）只输出这套符号：

- 辅音：`p b t d k ɡ f v θ ð s z ʃ ʒ h m n ŋ l r j w tʃ dʒ`（注意 `ɡ` 是 U+0261，不是 ASCII `g`）
- 单元音：`i ɪ e æ ʌ ə ɜ ɑ ɔ ʊ u`
- 双元音：`eɪ aɪ ɔɪ əʊ aʊ`

### 已知取舍（写在这里，避免以后再猜）

1. **`ɒ → ɑ`（cot–caught 合并）**：RP 的 `ɒ` 与 GA 的 `ɑ/ɑː` 合并成一个 key。
   理由：产品的教学目标是"能听懂/说清 en-US"，而 6–9 岁阶段区分 cot/caught 不是教学目标；
   更重要的是**一个音只能有一张卡**，否则长期追踪必然断链。若将来要与语料严格对齐 ɒ/ɑ 两分，
   只改这一张表（`CANONICAL_MAP`）即可，其它代码不需要动。
2. **`oʊ → əʊ`**：这是**字形选择**（跟语料已有的 `əʊ` 对齐），不代表音值判断；GA 实际音值接近 [oʊ]。
3. **长度符统一去掉**（`ː : ˑ`）：RP 的 `iː/uː/ɔː/ɜː/ɑː` 与 GA 的 `i/u/ɔ/ɜ/ɑ` 归为同一个 key，
   避免"同一张卡因一个冒号分裂成两张"。
4. **`ɝ → ɜ`、`ɚ → ə`**：GA 的卷舌元音与 RP 的对应元音合并；`r` 色彩在这套标记里由独立的 `r` 音素承担。
5. **未在表中的符号原样返回**（不丢信息、不猜测），同时记进 `seen_unknown_phonemes()` 并打一条 WARNING，
   方便 Azure 联调时"照着日志补表"。

## Azure 联调时怎么改（只改一张表）

打开本文件，往 `CANONICAL_MAP` 里加条目即可；值必须是 `CANONICAL_PHONEMES` 里的符号
（import 时断言会检查，写错会立刻报错）：

```python
CANONICAL_MAP = {
    ...
    # --- Azure Speech IPA 实测补充（2026-xx-xx 联调）---
    "ɐ": "ʌ",      # 例如 Azure 把 "cup" 的元音标成 ɐ
    "ɜ˞": "ɜ",     # 带卷舌附加符的写法
}
```

排查遗漏：日志里会出现 `unmapped phoneme symbol 'xx'`，或用 `seen_unknown_phonemes()` 取集合。
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger("voice.phonemes")

PHONEME_SPACE_ID = "canonical-v1"

# --------------------------------------------------------------------------------------
# 单一映射表：变体 -> 规范符号（唯一的"事实来源"，联调时只改这里）
# --------------------------------------------------------------------------------------
CANONICAL_MAP: dict[str, str] = {
    # ---- 辅音变体 ----
    "ɹ": "r",
    "ɻ": "r",
    "ɾ": "t",          # GA 闪音（water 的 tt）是 /t/ 的音位变体，教学上归到 t
    "ʤ": "dʒ",
    "ʧ": "tʃ",
    "t͡ʃ": "tʃ",        # 带连接符（tie bar）的写法
    "d͡ʒ": "dʒ",
    "t͜ʃ": "tʃ",
    "d͜ʒ": "dʒ",
    "g": "ɡ",          # ASCII g -> U+0261 ɡ
    # ---- 元音变体 ----
    "ɛ": "e",
    "ɝ": "ɜ",          # GA 重读卷舌元音
    "ɚ": "ə",          # GA 非重读卷舌元音
    "ɐ": "ʌ",
    "ᵻ": "ɪ",          # 部分词典的中性化短 i
    "ɘ": "ə",
    "ɵ": "ə",
    "ɨ": "ɪ",
    "ʉ": "u",
    "ɒ": "ɑ",          # RP cot 元音 -> GA ɑ（cot-caught 合并，理由见模块 docstring）
    "æ": "æ",
    # ---- 长度符：带长音符的写法归到同一个 key ----
    "iː": "i",
    "uː": "u",
    "ɔː": "ɔ",
    "ɜː": "ɜ",
    "ɑː": "ɑ",
    "eː": "e",
    "æː": "æ",
    "ɒː": "ɑ",
    "oː": "ɔ",
    "aː": "ɑ",
    # ---- 双元音 ----
    "oʊ": "əʊ",
    "ou": "əʊ",
    "əu": "əʊ",
    "aʊ": "aʊ",
    "ɑʊ": "aʊ",
    "eɪ": "eɪ",
    "ei": "eɪ",
    "aɪ": "aɪ",
    "ɑɪ": "aɪ",
    "ɔɪ": "ɔɪ",
    "oi": "ɔɪ",
    # RP 中元音 + 央元音双元音：语料里已经在用，保持同一个 key（不拆分）
    "ʊə": "ʊə",
    "ɪə": "ɪə",
    "eə": "eə",
    "iə": "ɪə",   # espeak 偶尔把 NEAR 写成 iə
    # GA 卷舌单元音（Azure 常作为单 token 输出，如 ɑɹ/ɔɹ/ɪɹ）
    "ɑɹ": "ɑ",
    "ɔɹ": "ɔ",
    "ɪɹ": "ɪə",
    "ɛɹ": "eə",
    "ʊɹ": "ʊə",
    # ---- 成音节辅音 ----
    "n̩": "n",
    "l̩": "l",
    "m̩": "m",
    "ŋ̍": "ŋ",
    # ---- Azure 联调待补（示例，见模块 docstring；不要凭猜测批量添加）----
    # "a": "æ",      # 若 Azure 用 a 表示 TRAP 元音
    # "ɜ˞": "ɜ",     # 带卷舌附加符的写法
}

# 规范空间全集（CANONICAL_MAP 的所有 value 必须落在这里；import 时断言）
CANONICAL_PHONEMES: frozenset[str] = frozenset(
    {
        # 辅音
        "p", "b", "t", "d", "k", "ɡ", "f", "v", "θ", "ð", "s", "z", "ʃ", "ʒ",
        "h", "m", "n", "ŋ", "l", "r", "j", "w", "tʃ", "dʒ",
        # 单元音
        "i", "ɪ", "e", "æ", "ʌ", "ə", "ɜ", "ɑ", "ɔ", "ʊ", "u",
        # 双元音
        "eɪ", "aɪ", "ɔɪ", "əʊ", "aʊ",
        # RP 央化双元音（语料已在用，保留为规范符号，避免同一音分裂成两张卡）
        "ʊə", "ɪə", "eə",
    }
)

# 纯附加符/超音段符号：不构成音素本身，用于"清理后再查表"的第二遍
_DIACRITICS = "ː:ˑˈˌʰʷʲˠˤˀ̥̩̯̞̟̠̊͜͡˥˦˧˨˩"

_UNKNOWN_SEEN: set[str] = set()
_UNKNOWN_LOCK = threading.Lock()


def _self_check() -> None:
    """保证表本身自洽：值都在规范空间里，且规范符号不会再次被映射（幂等的前提）。"""
    for variant, canonical in CANONICAL_MAP.items():
        if canonical not in CANONICAL_PHONEMES:
            raise AssertionError(f"CANONICAL_MAP[{variant!r}] = {canonical!r} 不在 CANONICAL_PHONEMES 里")
        remapped = CANONICAL_MAP.get(canonical)
        if remapped is not None and remapped != canonical:
            raise AssertionError(f"规范符号 {canonical!r} 又被映射到 {remapped!r}，归一化将不幂等")


_self_check()


def strip_marks(symbol: str) -> str:
    """去掉长度符、重音、送气等附加符（只用于查表兜底，不改变"原样返回"策略）。"""
    return "".join(ch for ch in symbol if ch not in _DIACRITICS).strip()


def canonicalize_phoneme(symbol: str | None, record_unknown: bool = True) -> str:
    """把一个 IPA 变体规范到 canonical-v1 空间。

    - 表内命中 -> 规范符号
    - 本身就是规范符号 -> 原样返回
    - 去掉附加符后命中 -> 规范化（例如 `n̩ -> n`、`æː -> æ`）
    - 都不命中 -> **原样返回**（不丢信息），并记录到 `seen_unknown_phonemes()`

    ``record_unknown=False`` 用于批量扫模型词表这类"预期会有大量外语符号"的场景，避免日志噪音。
    """
    if symbol is None:
        return ""
    raw = str(symbol).strip()
    if not raw:
        return ""

    mapped = CANONICAL_MAP.get(raw)
    if mapped is not None:
        return mapped
    if raw in CANONICAL_PHONEMES:
        return raw

    cleaned = strip_marks(raw)
    if cleaned and cleaned != raw:
        mapped = CANONICAL_MAP.get(cleaned)
        if mapped is not None:
            return mapped
        if cleaned in CANONICAL_PHONEMES:
            return cleaned

    if record_unknown:
        _note_unknown(raw)
    return raw  # 未在表中：原样返回，不猜测、不丢信息


def canonicalize_all(symbols, dedupe: bool = True) -> list[str]:
    """批量规范化：保序；默认去重（同一个音只留一个 key）。"""
    out: list[str] = []
    for symbol in symbols or []:
        canonical = canonicalize_phoneme(symbol)
        if not canonical:
            continue
        if dedupe and canonical in out:
            continue
        out.append(canonical)
    return out


def is_canonical(symbol: str) -> bool:
    return canonicalize_phoneme(symbol) in CANONICAL_PHONEMES and canonicalize_phoneme(symbol) == (symbol or "").strip()


def variants_of(canonical: str) -> list[str]:
    """反查：某个规范符号由哪些写法归并而来（给文档/排查用）。"""
    return sorted(v for v, c in CANONICAL_MAP.items() if c == canonical)


# --------------------------------------------------------------------------------------
# 未命中符号的可观测性（Azure 联调时"照着日志补表"）
# --------------------------------------------------------------------------------------
def _note_unknown(symbol: str) -> None:
    with _UNKNOWN_LOCK:
        if symbol in _UNKNOWN_SEEN:
            return
        _UNKNOWN_SEEN.add(symbol)
    logger.warning(
        "unmapped phoneme symbol %r: 请把它补进 app/phonemes.py 的 CANONICAL_MAP（见模块 docstring 的联调步骤）",
        symbol,
    )


def seen_unknown_phonemes() -> list[str]:
    with _UNKNOWN_LOCK:
        return sorted(_UNKNOWN_SEEN)


def reset_unknown_phonemes() -> None:
    with _UNKNOWN_LOCK:
        _UNKNOWN_SEEN.clear()


# --------------------------------------------------------------------------------------
# 应用在 provider 输出上（pronounce 响应）
# --------------------------------------------------------------------------------------
def looks_like_phoneme(value) -> bool:
    """判断一个字符串是否"像一个音素符号"。

    `expected`/`actual`/`phoneme` 偶尔是 "fluent" / "1125ms pause" / "drum" 这类文本，
    不能拿去查表（否则会污染未命中符号列表）。
    规则：去空格后 ≤3 字符，且**含非 ASCII 的 IPA 字符**或就是单个字母
    （规范空间里所有多字符音素都含 IPA 字符：aɪ eɪ ɔɪ əʊ aʊ tʃ dʒ ʊə ɪə eə t͡ʃ ...）。
    """
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or len(text) > 3:
        return False
    if any(ch.isspace() or ch.isdigit() for ch in text):
        return False
    return len(text) == 1 or any(ord(ch) > 127 for ch in text)


def canonicalize_pa_result(result) -> list[str]:
    """**就地**把 provider 返回的 PA 结果规范到 canonical-v1，返回被改写过的原始符号。

    - `words[].phonemes[].phoneme` 与 `nbest[].phoneme` 全部规范化；
      **nbest 不做去重、不排序**（分数与顺序原样保留）。
    - `issues[].phoneme/expected/actual` 同步规范化，并按规范符号重算 `hint_key`。
    """
    from .hints import derive_hint_key  # 延迟导入，避免 phonemes <-> hints 循环

    changed: list[str] = []
    if result is None:
        return changed

    def _map(symbol):
        canonical = canonicalize_phoneme(symbol)
        if isinstance(symbol, str) and canonical != symbol:
            changed.append(symbol)
        return canonical

    for word in getattr(result, "words", None) or []:
        for phoneme in getattr(word, "phonemes", None) or []:
            phoneme.phoneme = _map(phoneme.phoneme) or phoneme.phoneme
            for entry in phoneme.nbest or []:  # 只改符号：长度/顺序/分数都不动
                if isinstance(entry, dict) and entry.get("phoneme") is not None:
                    entry["phoneme"] = canonicalize_phoneme(entry["phoneme"])

    for issue in getattr(result, "issues", None) or []:
        # issues[].phoneme 可能被 provider 填成描述性文本（local 的 "fluent"），先做形状判断
        if looks_like_phoneme(issue.phoneme):
            issue.phoneme = _map(issue.phoneme) or issue.phoneme
        if looks_like_phoneme(issue.expected):
            issue.expected = _map(issue.expected)
        if looks_like_phoneme(issue.actual):
            issue.actual = _map(issue.actual)
        issue.hint_key = derive_hint_key(
            phoneme=issue.phoneme if isinstance(issue.phoneme, str) else None,
            actual=issue.actual if isinstance(issue.actual, str) else None,
            word=issue.word or "",
            error_type=issue.type or "Mispronunciation",
            explicit=issue.hint_key,
        )
    return changed
