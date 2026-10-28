import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireParent } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import { isSuggestionStatus, setSuggestionStatus, SUGGESTION_STATUSES } from "@/lib/suggestions";

export const dynamic = "force-dynamic";

/** PATCH /api/suggestions/:id —— 家长标记 open / read / resolved。 */
export const PATCH = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  await requireParent();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { status?: string } | null;
  if (!isSuggestionStatus(body?.status)) {
    throw new HttpError(400, "bad_request", `status 必须是 ${SUGGESTION_STATUSES.join("/")}`);
  }
  const ok = await setSuggestionStatus(id, body.status);
  if (!ok) throw new HttpError(404, "not_found", "找不到这条建议");
  return jsonOk({ ok: true, id, status: body.status });
});
