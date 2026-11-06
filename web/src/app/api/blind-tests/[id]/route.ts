import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireUser } from "@/lib/auth";
import { cancelBlindTest } from "@/lib/blind-test";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/blind-tests/:id —— 软取消（task-103）。
 * 不存在/他人 → 404；已完成 → 409 already_finished；已取消 → 200 幂等；进行中 → 原子更新。
 */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;
  const result = await cancelBlindTest(user, id);
  return jsonOk(result);
});
