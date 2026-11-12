import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { buildAdminCosts } from "@/lib/admin-costs";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/costs?month=YYYY-MM —— 仅管理员家庭；跨家庭成本聚合（task-108）。 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  await requireAdmin();
  return jsonOk(await buildAdminCosts(req.nextUrl.searchParams.get("month")));
});
