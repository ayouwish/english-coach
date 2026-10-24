#!/usr/bin/env python
"""本地 GOP 发音评测 vs Azure 分数的对照实验（task-20 段 C）。

设计（**不挑样本**）：
- 样本：`web/data/app.db` 里**所有**带 Azure `phoneme_scores` 且音频文件存在的 attempt（默认全量）。
- 参考音素：espeak-ng（Piper 自带）按词音素化 —— 与 CTC 模型训练时用的音素清单一致；
  不用 Azure 的分数，也不依赖 Azure 的行顺序（`phoneme_scores` 的行是跨词乱序的）。
- 配对：按 (词, 规范音素符号) 多重匹配本地分数与 Azure 分数；配不上的丢弃并统计。
- 指标：Pearson r、Spearman ρ、每句"最差 5 个音素"的重合度、按音素符号聚合的相关性。
- 另报段 B（faster-whisper）WER / RTF。

用法：
    .venv/bin/python scripts/gop_eval.py            # 全量 + WER
    .venv/bin/python scripts/gop_eval.py --no-asr   # 跳过 WER（更快）
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from app.audio_io import decode_audio  # noqa: E402
from app.phonemes import CANONICAL_PHONEMES, canonicalize_phoneme  # noqa: E402
from app.providers.gop import GOPPA, reference_phonemes  # noqa: E402
from app.text import tokens  # noqa: E402

DB_PATH = ROOT.parent / "web" / "data" / "app.db"
AUDIO_ROOT = ROOT.parent / "web" / "data"
WORD_RE = re.compile(r"[a-z']+")
WORST_K = 5


def normalize_words(text: str) -> list[str]:
    return WORD_RE.findall((text or "").lower())


def pearson(x: list[float], y: list[float]) -> float | None:
    if len(x) < 3:
        return None
    a, b = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    if a.std() == 0 or b.std() == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def _ranks(values: list[float]) -> np.ndarray:
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(len(values), dtype=float)
    ordered = [values[i] for i in order]
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and ordered[j + 1] == ordered[i]:
            j += 1
        average = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = average
        i = j + 1
    return ranks


def spearman(x: list[float], y: list[float]) -> float | None:
    if len(x) < 3:
        return None
    return pearson(list(_ranks(x)), list(_ranks(y)))


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = normalize_words(reference), normalize_words(hypothesis)
    if not ref:
        return 1.0 if hyp else 0.0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, start=1):
        current = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, start=1):
            current[j] = min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + (r != h))
        prev = current
    return prev[-1] / len(ref)


def load_attempts(db: Path, limit: int | None = None) -> list[dict]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        select a.id, a.reference_text, a.audio_path, a.duration_ms, a.created_at
        from attempts a join phoneme_scores p on p.attempt_id = a.id
        group by a.id order by a.created_at desc
        """
    ).fetchall()
    out: list[dict] = []
    for row in rows:
        audio = AUDIO_ROOT / (row["audio_path"] or "")
        if not row["reference_text"] or not audio.is_file():
            continue
        phones = con.execute(
            "select id, word, phoneme, score from phoneme_scores where attempt_id=? order by id", (row["id"],)
        ).fetchall()
        out.append(
            {
                "id": row["id"],
                "reference_text": row["reference_text"],
                "audio": audio,
                "azure": [
                    {"row": str(p["id"]), "word": (p["word"] or "").lower(), "phoneme": p["phoneme"], "score": float(p["score"])}
                    for p in phones
                ],
            }
        )
        if limit and len(out) >= limit:
            break
    return out


def pair_attempt(
    word_targets: list[tuple[str, list[str]]],
    scored_words: list[tuple[str, list[dict]]],
    azure_rows: list[dict],
) -> list[tuple[float, float, str]]:
    """按 (词, 规范符号) 多重匹配；返回 [(本地分, Azure 分, 标签)]。"""
    azure_by_word: dict[str, list[dict]] = defaultdict(list)
    for row in azure_rows:
        canon = canonicalize_phoneme(str(row["phoneme"]), record_unknown=False)
        if canon.startswith("@") or canon not in CANONICAL_PHONEMES:
            continue
        azure_by_word[row["word"]].append({"canon": canon, "score": row["score"]})

    pairs: list[tuple[float, float, str]] = []
    for (word, phones), (scored_word, entries) in zip(word_targets, scored_words):
        pool = azure_by_word.get(word) or []
        used = [False] * len(pool)
        local_used = [False] * len(entries)
        for phone in phones:
            entry_index = next(
                (i for i, e in enumerate(entries) if e["phoneme"] == phone and not local_used[i]), None
            )
            if entry_index is None:
                continue
            local_used[entry_index] = True
            for index, candidate in enumerate(pool):
                if used[index] or candidate["canon"] != phone:
                    continue
                used[index] = True
                pairs.append((float(entries[entry_index]["score"]), float(candidate["score"]), f"{word}:{phone}"))
                break
    return pairs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--no-asr", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    attempts = load_attempts(DB_PATH, args.limit or None)
    if not attempts:
        print("没有可用样本（需要 reference_text + 音频 + Azure 音素分数）")
        return 2
    print(f"样本: {len(attempts)} 条 attempt（带 Azure 音素分数且音频存在）")

    gop = GOPPA()
    per_attempt: list[dict] = []
    labelled: list[tuple[float, float, str]] = []
    all_pairs: list[tuple[float, float]] = []
    gop_seconds = audio_seconds = 0.0
    wer_scores: list[float] = []
    asr_rtf: list[float] = []
    asr = None
    if not args.no_asr:
        try:
            from app.providers.local import LocalASR

            asr = LocalASR()
        except Exception as exc:
            print(f"  (faster-whisper 不可用，跳过 WER: {exc})")

    for item in attempts:
        clip = decode_audio(item["audio"].read_bytes(), 16000, 60.0)
        word_targets = [(word, reference_phonemes(word)) for word in tokens(item["reference_text"])]
        started = time.perf_counter()
        scored_words, _log_probs, skipped, _recognized = gop.score_word_targets(clip, word_targets)
        elapsed = time.perf_counter() - started
        audio_seconds += clip.duration_s
        gop_seconds += elapsed

        pairs = pair_attempt(word_targets, scored_words, item["azure"])
        labelled.extend(pairs)
        all_pairs.extend([(p[0], p[1]) for p in pairs])

        entry = {
            "attempt": item["id"],
            "reference_text": item["reference_text"],
            "audio_s": round(clip.duration_s, 2),
            "gop_ms": round(elapsed * 1000, 1),
            "gop_rtf": round(elapsed / clip.duration_s, 3),
            "pairs": len(pairs),
            "skipped_reference_phonemes": skipped,
            "worst5_overlap": None,
        }
        if len(pairs) >= 8:
            local_worst = {key for key, _ in sorted(((k, s) for s, _, k in pairs), key=lambda it: it[1])[:WORST_K]}
            azure_worst = {key for key, _ in sorted(((k, s) for _, s, k in pairs), key=lambda it: it[1])[:WORST_K]}
            entry["worst5_overlap"] = len(local_worst & azure_worst)

        if asr is not None:
            started = time.perf_counter()
            text = asr.recognize(clip).text
            asr_ms = (time.perf_counter() - started) * 1000
            entry["asr_text"] = text
            entry["wer"] = round(wer(item["reference_text"], text), 4)
            entry["asr_rtf"] = round(asr_ms / 1000 / clip.duration_s, 3)
            wer_scores.append(entry["wer"])
            asr_rtf.append(entry["asr_rtf"])

        per_attempt.append(entry)

    local = [p[0] for p in all_pairs]
    azure = [p[1] for p in all_pairs]
    r, rho = pearson(local, azure), spearman(local, azure)
    overlaps = [e["worst5_overlap"] for e in per_attempt if e["worst5_overlap"] is not None]

    print("\n=== GOP vs Azure（音素级；参考音素 = espeak-ng 按词音素化）===")
    print(f"  配对: {len(all_pairs)} 个音素 / {sum(1 for e in per_attempt if e['pairs'])} 条 attempt")
    print(f"  本地 mean={np.mean(local):.1f} sd={np.std(local):.1f} | Azure mean={np.mean(azure):.1f} sd={np.std(azure):.1f}")
    print(f"  Pearson r = {r:.3f}   Spearman \u03c1 = {rho:.3f}")
    if overlaps:
        print(f"  worst-{WORST_K} 重合: mean={np.mean(overlaps):.2f}/{WORST_K} 分布={ {k: overlaps.count(k) for k in sorted(set(overlaps))} } (n={len(overlaps)})")
    print(f"  GOP 延迟 mean={gop_seconds/len(attempts)*1000:.0f}ms/条, 聚合 RTF={gop_seconds/audio_seconds:.3f}")

    by_symbol: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for local_score, azure_score, key in labelled:
        by_symbol[key.split(":")[-1]].append((local_score, azure_score))
    symbol_rows = [
        (symbol, len(values), float(np.mean([v[0] for v in values])), float(np.mean([v[1] for v in values])))
        for symbol, values in sorted(by_symbol.items())
        if len(values) >= 5
    ]
    if len(symbol_rows) >= 3:
        symbol_r = pearson([row[2] for row in symbol_rows], [row[3] for row in symbol_rows])
        symbol_rho = spearman([row[2] for row in symbol_rows], [row[3] for row in symbol_rows])
        print(f"  按音素符号聚合(n={len(symbol_rows)}): Pearson r={symbol_r:.3f}, Spearman \u03c1={symbol_rho:.3f}")

    if wer_scores:
        print("\n=== 段 B：faster-whisper small.en ===")
        print(f"  WER mean={np.mean(wer_scores):.3f} median={np.median(wer_scores):.3f} (n={len(wer_scores)})")
        print(f"  ASR RTF mean={np.mean(asr_rtf):.3f} max={max(asr_rtf):.3f}")
        clean = [e["wer"] for e in per_attempt if e.get("wer") is not None and e["wer"] <= 0.5]
        print(f"  WER\u22640.5 的样本: {len(clean)}/{len(wer_scores)} 条（录音可用性参考，不用于挑样本算相关性）")

    print("\n=== 逐条明细 ===")
    print(f"{'attempt':14s} {'audio':>6s} {'pairs':>5s} {'worst5':>6s} {'gop_rtf':>7s} {'wer':>6s}")
    for entry in per_attempt:
        print(
            f"{entry['attempt'][:14]:14s} {entry['audio_s']:6.2f} {entry['pairs']:5d} "
            f"{str(entry['worst5_overlap']):>6s} {entry['gop_rtf']:7.3f} {str(entry.get('wer', '-')):>6s}"
        )

    if args.json:
        print("\n=== JSON ===")
        print(json.dumps({"pearson": r, "spearman": rho, "pairs": len(all_pairs), "per_attempt": per_attempt}, ensure_ascii=False))

    print("\n=== 判定（阈值写死在这里，避免事后换说法）===")
    if rho is None:
        print("  样本不足")
    elif abs(rho) >= 0.6:
        print(f"  可用：Spearman \u03c1={rho:.3f} \u2265 0.6")
    elif abs(rho) >= 0.4:
        print(f"  边缘：\u03c1={rho:.3f} \u2208 [0.4, 0.6)，只能粗筛，不建议作为错音本依据")
    else:
        print(f"  不可用：\u03c1={rho:.3f} < 0.4，本地 GOP 不能替代 Azure 做薄弱音素判定")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
