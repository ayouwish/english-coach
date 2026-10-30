/**
 * 难度级别（CEFR）—— 不写死三个级别：A1/A2/B1/B2（B2 给已能自主阅读的孩子）。
 * 语料由 corpus-dev 扩充（新增 B2），故事改写也用同一套级别。
 */
export const CEFR_LEVELS = ["A1", "A2", "B1", "B2"] as const;
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
