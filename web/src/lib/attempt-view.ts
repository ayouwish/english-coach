/**
 * 从 `phoneme_scores` 还原"逐词得分"（attempts 表没有 words_json 列）。
 * 同步结果与异步结果都用同一份还原逻辑，保证 /practice 的「上一次结果」与
 * 连读模式的评分列表口径一致。
 */
import { getSqlite } from "@/db";
import type { PronounceResult } from "./types";

export function wordsFromPhonemeScores(attemptId: string): PronounceResult["words"] {
  const rows = getSqlite()
    .prepare("SELECT word, score FROM phoneme_scores WHERE attempt_id = ? ORDER BY rowid")
    .all(attemptId) as { word: string; score: number | null }[];
  const order: string[] = [];
  const acc = new Map<string, number[]>();
  for (const r of rows) {
    if (!acc.has(r.word)) {
      acc.set(r.word, []);
      order.push(r.word);
    }
    if (typeof r.score === "number") acc.get(r.word)?.push(r.score);
  }
  return order.map((word) => {
    const list = acc.get(word) ?? [];
    const avg = list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
    return {
      word,
      score: avg === null ? null : Math.round(avg * 10) / 10,
      start_ms: null,
      end_ms: null,
      error_type: null,
    };
  });
}
