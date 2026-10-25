/**
 * 语速的"有效值"计算（task-21）—— 唯一入口，避免各处再散落 `isChild ? "slow" : "normal"`。
 *
 * 语义：
 *   - 儿童**默认** slow（孩子听清楚更重要），但**可以被偏好覆盖**（家长/孩子自己改成 normal 就真的用 normal）；
 *   - 成人默认 normal，可改 slow；
 *   - 偏好值缺失/非法时才回退到默认值。
 *
 * 注意：存量儿童账号的 `user_prefs.tts_rate` 历史上写的是 `normal`，
 * 已由迁移 `0004_children_tts_rate_slow.sql` 统一改成 `slow`（只动 user_prefs.tts_rate）。
 */
export type TtsRate = "slow" | "normal";

export function isTtsRate(v: unknown): v is TtsRate {
  return v === "slow" || v === "normal";
}

export function defaultTtsRate(isChild: boolean): TtsRate {
  return isChild ? "slow" : "normal";
}

/** 有效语速 = 用户偏好（合法时）否则按角色取默认 */
export function effectiveTtsRate(
  user: { isChild: boolean },
  prefs?: { ttsRate?: string | null } | null,
): TtsRate {
  return isTtsRate(prefs?.ttsRate) ? prefs.ttsRate : defaultTtsRate(user.isChild);
}
