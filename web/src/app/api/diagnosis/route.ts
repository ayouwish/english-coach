import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { DiagnosisScopeError, buildScopedDiagnosis, type DiagnosisScope } from "@/lib/diagnosis-scope";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

const SCOPES: DiagnosisScope[] = ["all", "recent", "attempt", "batch"];

/**
 * GET /api/diagnosis —— 发音诊断（task-16 A / task-71 作用域）。
 *
 * `?scope=all`（默认，全量累计，结构不变）
 * `?scope=recent&days=7`（或 `limit=30`）—— 最近
 * `?scope=attempt&attempt_id=xxx` —— 只这一句
 * `?scope=batch&attempt_ids=a,b`（≤20，必须属于本人）—— 连读这一批
 *
 * 儿童请求不返回 IPA（buildScopedDiagnosis 内已剥离 + childSafeDeep 兜底）。
 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();

  const sp = req.nextUrl.searchParams;
  const scopeRaw = sp.get("scope") ?? "all";
  if (!SCOPES.includes(scopeRaw as DiagnosisScope)) {
    throw new HttpError(400, "invalid_scope", `scope 只能是 ${SCOPES.join(" / ")}`);
  }
  const scope = scopeRaw as DiagnosisScope;
  const daysRaw = sp.get("days");
  const limitRaw = sp.get("limit");
  const days = daysRaw ? Number(daysRaw) : undefined;
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    throw new HttpError(400, "bad_request", "days 必须是正整数");
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new HttpError(400, "bad_request", "limit 必须是正整数");
  }
  const attemptIds = (sp.get("attempt_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const payload = await buildScopedDiagnosis(user, {
      scope,
      attemptId: sp.get("attempt_id"),
      attemptIds,
      days,
      limit,
    });
    return jsonOk(payload);
  } catch (err) {
    if (err instanceof DiagnosisScopeError) {
      const status = err.code === "invalid_scope" ? 400 : err.code === "forbidden" ? 403 : 404;
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status });
    }
    throw err;
  }
});
