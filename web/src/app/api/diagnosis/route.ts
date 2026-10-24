import { ensureBootstrap } from "@/db";
import { requireUser } from "@/lib/auth";
import { buildDiagnosis } from "@/lib/diagnosis";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/diagnosis —— 薄弱音素诊断（task-16 A）。
 * 儿童请求不返回 IPA（buildDiagnosis 内已按 isChild 剥离 + childSafeDeep 兜底）。
 */
export const GET = route(async () => {
  await ensureBootstrap();
  const user = await requireUser();
  return jsonOk(await buildDiagnosis(user));
});
