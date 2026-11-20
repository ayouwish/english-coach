import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { buildWarmupMeta, startWarmup, type WarmupStartBody } from "@/lib/admin-tts-warmup";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/tts-warmup —— 估算 + voice 批量预热状态（task-115）。 */
export const GET = route(async () => {
  await ensureBootstrap();
  await requireAdmin();
  return jsonOk(await buildWarmupMeta());
});

/** POST /api/admin/tts-warmup {voices?, rates?, texts?} —— 启动批量预热。 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  await requireAdmin();
  const body = (await req.json().catch(() => null)) as WarmupStartBody | null;
  if (!body) return jsonOk({ error: { code: "bad_request", message: "请求体必须是 JSON" } }, 400);
  const { started, estimate } = await startWarmup(body);
  return jsonOk({ ok: true, ...started, estimate }, 201);
});
