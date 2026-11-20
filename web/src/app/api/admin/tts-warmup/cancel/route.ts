import { ensureBootstrap } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { cancelWarmup } from "@/lib/admin-tts-warmup";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/tts-warmup/cancel —— 取消正在运行的批量预热（task-115）。 */
export const POST = route(async () => {
  await ensureBootstrap();
  await requireAdmin();
  return jsonOk(await cancelWarmup());
});
