#!/usr/bin/env python3
"""音素标注审计（Lead 独立验证，不属于任何模块）—— 严格模式

回答两个 `web/scripts/validate-corpus.mjs` 答不了的问题：

  A. **符号空间**：`focus_phonemes` 里的符号是否落在 voice 定义的规范空间
     （`canonical-v1`，见 `voice/app/phonemes.py`）？
     不在同一空间 → 云端返回的符号与语料 key 对不上 → 同一个发音错误生成两张
     SRS 卡片 → `phoneme_mastery` 的长期追踪**静默断裂**。

  B. **标注真实性**：该音素是否真的出现在这句话里？
     用 CMU 发音词典（cmudict，12.6 万词条）做真实 G2P 逐句核对。

这两类问题都不会报错，只会让"你的 /θ/ 三个月从 41 涨到 68"这条追踪悄悄失去意义。

用法：
  voice/.venv/bin/python tests/audit_corpus_phonemes.py [--json]
退出码：0 = 两类违规都为 0；1 = 存在违规。
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

try:
    import cmudict
except ImportError:
    print("需要 cmudict：UV_CACHE_DIR=$PWD/voice/.uv-cache uv build 前先执行")
    print("  UV_CACHE_DIR=$PWD/voice/.uv-cache uv pip install --python voice/.venv/bin/python cmudict")
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "web" / "src" / "data" / "sentences.json"
VOICE_APP = ROOT / "voice"

# 规范空间 canonical-v1：直接向 voice 的实现要，避免两边各写一份而漂移
sys.path.insert(0, str(VOICE_APP))
try:
    from app.phonemes import CANONICAL_MAP, CANONICAL_PHONEMES, canonicalize_all  # type: ignore
    CANONICAL_SOURCE = "voice/app/phonemes.py（canonical-v1）"
except Exception as exc:  # pragma: no cover
    print(f"无法导入 voice/app/phonemes.py：{exc}")
    print("（该模块是规范空间的唯一定义处；本脚本刻意不自己复制一份，以免两边漂移）")
    sys.exit(2)

# ARPAbet -> IPA（与规范空间对齐）
ARPABET_IPA = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "EH": "e", "ER": "ɜ", "EY": "eɪ", "IH": "ɪ", "IY": "i", "OW": "əʊ",
    "OY": "ɔɪ", "UH": "ʊ", "UW": "u",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ", "HH": "h",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ", "P": "p",
    "R": "r", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ", "V": "v", "W": "w",
    "Y": "j", "Z": "z", "ZH": "ʒ",
}

WORD_RE = re.compile(r"[A-Za-z']+")


def ga_phonemes_for_word(word: str, d) -> tuple[set[str], bool]:
    """返回 (GA IPA 音素集合, 是否命中词典)。遍历全部发音，避免同形异音词假阳性。"""
    key = word.lower().replace("'", "")
    entries = d.get(key)
    if not entries:
        return set(), False
    out: set[str] = set()
    for pron in entries:
        for ph in pron:
            base = re.sub(r"\d", "", ph)
            if base == "AH" and ph.endswith("0"):
                out.add("ə")
            elif base == "ER":
                out.add("ɜ")
                out.add("r")
            else:
                out.add(ARPABET_IPA.get(base, base.lower()))
    return out, True


def main() -> int:
    sentences = json.loads(CORPUS.read_text(encoding="utf-8"))["sentences"]
    d = cmudict.dict()

    off_space: list[dict] = []      # A. 符号不在规范空间
    not_in_sentence: list[dict] = []  # B. 标注的音素在句中不存在
    unknown_words: Counter = Counter()
    declared_counter: Counter = Counter()
    covered = 0
    total_declared = 0

    for s in sentences:
        ga: set[str] = set()
        missing = []
        for w in WORD_RE.findall(s["text"]):
            ph, hit = ga_phonemes_for_word(w, d)
            if hit:
                ga |= ph
            else:
                missing.append(w)
                unknown_words[w] += 1

        for ph in s.get("focus_phonemes") or []:
            total_declared += 1
            declared_counter[ph] += 1
            in_space = ph in CANONICAL_PHONEMES
            present = ph in ga
            if in_space and present:
                covered += 1
                continue
            rec = {
                "id": s["id"], "level": s["level"], "phoneme": ph, "text": s["text"],
                "canonical_form": canonicalize_all([ph])[0] if not in_space else ph,
                "ga_phonemes": " ".join(sorted(ga)), "missing_words": missing,
            }
            if not in_space:
                off_space.append(rec)
            if in_space and not present and not missing:
                not_in_sentence.append(rec)

    print("\n=== 语料音素标注审计（严格模式 · 规范空间 " + CANONICAL_SOURCE + "）===")
    print(f"句数 {len(sentences)}   标注总数 {total_declared}   完全成立 {covered}")
    print(f"A. 不在规范空间（需归一化）：{len(off_space)}")
    print(f"B. 在句中不存在（真实标注错误）：{len(not_in_sentence)}")
    print(f"规范空间符号数：{len(CANONICAL_PHONEMES)}   映射表条目：{len(CANONICAL_MAP)}")

    off_counter = Counter(v["phoneme"] for v in off_space)
    if off_counter:
        print("\n--- A. 非规范符号分布（符号 → 应归一化为）---")
        for sym, n in off_counter.most_common():
            target = canonicalize_all([sym])[0]
            mark = "→ " + target if target != sym else "（映射表未覆盖，需补表）"
            print(f"  {sym:4s} ×{n:<4d} {mark}")
        print("  例：" + "; ".join(f"{v['phoneme']} @ {v['id']}" for v in off_space[:5]))

    if not_in_sentence:
        print("\n--- B. 真实标注错误明细 ---")
        for v in not_in_sentence[:30]:
            print(f"  [{v['level']}] {v['id']:10s} 标注 {v['phoneme']:3s} 不在 «{v['text']}»")
            print(f"        句中实际音素：{v['ga_phonemes']}")

    if unknown_words:
        print(f"\n词典未收录词 {len(unknown_words)} 个（这些句子无法自动判定 B 类）："
              + ", ".join(f"{w}×{c}" for w, c in unknown_words.most_common(10)))

    if "--json" in sys.argv:
        print("\n" + json.dumps({
            "sentences": len(sentences), "declared": total_declared, "covered": covered,
            "off_space": len(off_space), "not_in_sentence": len(not_in_sentence),
            "off_space_detail": off_space, "not_in_sentence_detail": not_in_sentence,
        }, ensure_ascii=False, indent=2))

    print()
    if off_space or not_in_sentence:
        print(f"\033[31m审计未通过：A 类 {len(off_space)} 处、B 类 {len(not_in_sentence)} 处。\033[0m\n")
        return 1
    print("\033[32m审计通过：符号全部落在规范空间，且每个标注都真实存在于句中。\033[0m\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
