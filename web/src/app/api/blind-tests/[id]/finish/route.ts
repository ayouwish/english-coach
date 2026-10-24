import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireUser } from "@/lib/auth";
import { finishBlindTest } from "@/lib/blind-test";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/blind-tests/:id/finish —— 结束盲测并计算 avg_*（契约 §13.4）。
 * 结束之后分数才可读（§13.3 第 3 条）；重复调用是幂等的。
 */
export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;
  return jsonOk(await finishBlindTest(user, id));
});
