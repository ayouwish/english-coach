import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireUser } from "@/lib/auth";
import { deleteCustomSentence } from "@/lib/corpus";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** DELETE /api/sentences/:id —— 只能删除自己录入的自定义语料。 */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;
  await deleteCustomSentence(user, id);
  return jsonOk({ deleted: id });
});
