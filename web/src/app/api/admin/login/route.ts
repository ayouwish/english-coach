import { NextRequest } from "next/server";
import { adminEnabled, setAdminCookie, verifyAdminPassword } from "@/lib/admin-auth";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

/** 内存限速：5 次失败 / 60s（按 IP） */
const attempts = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (attempts.get(ip) ?? []).filter((t) => now - t < 60_000);
  attempts.set(ip, arr);
  return arr.length >= 5;
}
function noteFail(ip: string) {
  const arr = attempts.get(ip) ?? [];
  arr.push(Date.now());
  attempts.set(ip, arr);
}

/** POST /api/admin/login {password} —— 独立后台登录（task-110）。 */
export async function POST(req: NextRequest) {
  if (!adminEnabled()) {
    return jsonOk({ error: { code: "admin_disabled", message: "后台未启用（未设置 ADMIN_PASSWORD）", detail: {} } }, 503);
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  if (rateLimited(ip)) {
    return jsonOk({ error: { code: "too_many_requests", message: "尝试次数太多，请 60 秒后再试", detail: {} } }, 429);
  }
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  if (!verifyAdminPassword(body?.password)) {
    noteFail(ip);
    return jsonOk({ error: { code: "bad_credentials", message: "管理密码不正确", detail: {} } }, 401);
  }
  attempts.delete(ip);
  await setAdminCookie();
  return jsonOk({ ok: true });
}
