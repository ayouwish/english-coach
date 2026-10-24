import { ensureBootstrap } from "@/db";
import { requireParent } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import { buildParentSummary } from "@/lib/parent-summary";

export const dynamic = "force-dynamic";

/** GET /api/parent/summary — 仅 parent 角色；child 访问返回 403（服务端强制）。 */
export const GET = route(async () => {
  await ensureBootstrap();
  await requireParent();
  return jsonOk(await buildParentSummary());
});
