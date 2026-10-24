import type { SessionUser } from "./auth";

export function ageOf(user: SessionUser, now = new Date()): number {
  if (!user.birthYear) return user.ageBand === "child" ? 7 : 30;
  return Math.max(3, now.getFullYear() - user.birthYear);
}

/** 儿童只能看到 min_age ≤ 自己年龄 的场景（服务端过滤，不只是隐藏 UI）。 */
export function isScenarioAllowedFor(user: SessionUser, minAge: number): boolean {
  if (!user.isChild) return true;
  return minAge <= ageOf(user);
}
