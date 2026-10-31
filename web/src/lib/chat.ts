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

/** 场景 audience（task-68）：tags 里带 `audience:adult|child`；老数据没有则按儿童处理 */
export function scenarioAudience(tags: readonly string[] | null | undefined): "child" | "adult" {
  return (tags ?? []).includes("audience:adult") ? "adult" : "child";
}

/** 当前用户应看到的场景 audience：儿童只看 child，成人只看 adult（产品上避免父母练儿童场景） */
export function audienceForUser(user: SessionUser): "child" | "adult" {
  return user.ageBand === "child" || user.role === "child" ? "child" : "adult";
}
