/**
 * 难度级别（CEFR）——不写死级别：A1/A2/B1/B2/C1（C1 给已经能自主阅读章节书的成人与大孩子）。
 * 故事改写/账号水平用全套 CEFR_LEVELS；**语料**目前只到 B2（C1 由 corpus-dev 后续补），
 * 所以选 C1 时语料默认级别回退到 B2（见 story 页面提示）。
 */
export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export function isCefrLevel(v: unknown): v is CefrLevel {
  return typeof v === "string" && (CEFR_LEVELS as readonly string[]).includes(v);
}

/** 更简单一级（已在最低则不变） */
export function simplerLevel(level: string): CefrLevel {
  const i = CEFR_LEVELS.indexOf(level as CefrLevel);
  return CEFR_LEVELS[Math.max(0, (i < 0 ? 1 : i) - 1)];
}

/** 更难一级（已在最高则不变） */
export function harderLevel(level: string): CefrLevel {
  const i = CEFR_LEVELS.indexOf(level as CefrLevel);
  return CEFR_LEVELS[Math.min(CEFR_LEVELS.length - 1, (i < 0 ? 0 : i) + 1)];
}

/** 语料当前已覆盖的级别（C1 还没有句子；选 C1 时语料侧回退到最高可用级别） */
export const CORPUS_LEVELS = ["A1", "A2", "B1", "B2"] as const;

export function isCorpusLevel(v: unknown): v is (typeof CORPUS_LEVELS)[number] {
  return typeof v === "string" && (CORPUS_LEVELS as readonly string[]).includes(v);
}

/** 语料侧使用的级别：C1 及未知 → B2（最高已覆盖级别） */
export function corpusLevelFor(level: string): (typeof CORPUS_LEVELS)[number] {
  return isCorpusLevel(level) ? level : "B2";
}
