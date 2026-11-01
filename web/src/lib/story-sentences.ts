/**
 * 故事句子数（task-81）：账号可配置，NULL = 按角色默认。
 * 儿童默认 5 句、成人默认 8 句；可选范围 3–12（voice task-80 已支持）。
 */
export const STORY_SENTENCES_MIN = 3;
export const STORY_SENTENCES_MAX = 12;
export const STORY_SENTENCES_CHILD_DEFAULT = 5;
export const STORY_SENTENCES_ADULT_DEFAULT = 8;

export function isStorySentenceCount(v: unknown): v is number {
  const n = Number(v);
  return Number.isInteger(n) && n >= STORY_SENTENCES_MIN && n <= STORY_SENTENCES_MAX;
}

/** 角色默认句数（儿童 5 / 成人 8） */
export function roleDefaultStorySentences(isChild: boolean): number {
  return isChild ? STORY_SENTENCES_CHILD_DEFAULT : STORY_SENTENCES_ADULT_DEFAULT;
}

/** 账号实际默认：用户设置优先，否则角色默认 */
export function effectiveStorySentences(user: { storySentences?: number | null; isChild: boolean }): number {
  const configured = user.storySentences;
  if (typeof configured === "number" && isStorySentenceCount(configured)) return configured;
  return roleDefaultStorySentences(user.isChild);
}

/** 选择器可选值 3–12（前端只渲染这些） */
export function storySentenceOptions(): number[] {
  return Array.from({ length: STORY_SENTENCES_MAX - STORY_SENTENCES_MIN + 1 }, (_, i) => STORY_SENTENCES_MIN + i);
}
