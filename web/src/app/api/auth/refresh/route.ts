import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { rotateRefreshToken } from "@/lib/auth-tokens";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/refresh —— 一次性轮换（task-60）：旧 refresh 立即失效，签发新 access+refresh。
 * 并发/重复使用同一个 refresh：**只有一个成功**，其余 401（客户端应重新登录）。
 */
export async function POST(req: NextRequest) {
  await ensureBootstrap();
  const body = (await req.json().catch(() => null)) as { refresh_token?: string } | null;
  const refreshToken = body?.refresh_token ?? "";
  if (!refreshToken) {
    return NextResponse.json({ error: { code: "bad_request", message: "缺少 refresh_token" } }, { status: 400 });
  }
  const rotated = await rotateRefreshToken(refreshToken, req.headers.get("user-agent"));
  if (!rotated) {
    return NextResponse.json({ error: { code: "unauthorized", message: "登录已失效，请重新登录" } }, { status: 401 });
  }
  return jsonOk(rotated.tokens);
}
