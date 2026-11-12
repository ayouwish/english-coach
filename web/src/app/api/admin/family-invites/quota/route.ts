import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { setQuotaRemaining } from "@/lib/admin-family-invites";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** 后台：调整新家庭邀请名额 {set|add}。 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  await requireAdmin();
  const body = (await req.json().catch(() => null)) as { set?: unknown; add?: unknown } | null;
  if (!body) return jsonOk({ error: { code: "bad_request", message: "请求体必须是 JSON" } }, 400);
  return jsonOk(await setQuotaRemaining(body));
});
