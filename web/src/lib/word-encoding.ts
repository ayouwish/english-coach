/**
 * 词级反馈的"长度编码"（task-14 C）。
 *
 * 为什么不用颜色：颜色作为唯一/主要编码对色盲不友好。这里条长 = 分数（唯一的主要编码），
 * 问题词靠 **⚠️ 图标 + 置顶排序** 突出 —— 不看颜色也能一眼看出哪个词最差。
 *
 * 纯函数、无依赖：组件与自测脚本共用（scripts/check-practice-ui.mjs 直接 import）。
 */

export interface RawWordScore {
  word: string;
  score: number | null;
  error_type?: string | null;
}

export interface WordRow {
  word: string;
  /** 原始分数，null = 没有逐词分数 */
  score: number | null;
  /** 条长百分比（0–100；score 为 null 时为 0，但 UI 会显示 "—"） */
  barPct: number;
  /** 是否问题词：有分数且 < 60 */
  problem: boolean;
  /** 在原句中的顺序（从 0 开始） */
  index: number;
}

export interface WordEncoding {
  /** 句子原文顺序的完整列表 */
  all: WordRow[];
  /** 问题词（分数升序，最差在最前） */
  problem: WordRow[];
  /** 最差的词（忽略无分数的词） */
  worst: WordRow | null;
}

export const PROBLEM_THRESHOLD = 60;

export function encodeWordRows(words: RawWordScore[]): WordEncoding {
  const all: WordRow[] = (words ?? []).map((w, index) => {
    const score = typeof w.score === "number" && Number.isFinite(w.score) ? w.score : null;
    return {
      word: w.word,
      score,
      barPct: score === null ? 0 : Math.max(0, Math.min(100, Math.round(score))),
      problem: score !== null && score < PROBLEM_THRESHOLD,
      index,
    };
  });

  const problem = all
    .filter((r) => r.problem)
    .slice()
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  const scored = all.filter((r) => r.score !== null);
  const worst = scored.length
    ? scored.reduce((min, r) => ((r.score as number) < (min.score as number) ? r : min))
    : null;

  return { all, problem, worst };
}

/** 无障碍标签：条形的文字等价物 */
export function wordBarAriaLabel(row: WordRow): string {
  if (row.score === null) return `${row.word}：没有逐词分数`;
  return `${row.word} ${Math.round(row.score)} 分${row.problem ? "，需要重点练" : ""}`;
}
