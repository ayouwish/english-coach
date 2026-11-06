import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireParent } from "@/lib/auth";
import { costSummary } from "@/lib/cost";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/cost/summary?month=YYYY-MM —— 仅家长；只统计本家庭（task-101）。 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireParent();
  const month = req.nextUrl.searchParams.get("month");
  return jsonOk(await costSummary(user.familyId, month));
});
