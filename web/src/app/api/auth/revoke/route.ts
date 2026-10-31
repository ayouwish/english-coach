import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { revokeAccessToken, revokeByRefreshToken } from "@/lib/auth-tokens";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/revoke —— 吊销（task-60）：body `{refresh_token}` 或 Bearer access。
 * **幂等**：重复吊销/不存在也返回 204（不泄露 token 是否存在）。
 */
export async function POST(req: NextRequest) {
  await ensureBootstrap();
  const body = (await req.json().catch(() => null)) as { refresh_token?: string } | null;
  const refreshToken = body?.refresh_token ?? "";
  if (refreshToken) {
    await revokeByRefreshToken(refreshToken);
    return new NextResponse(null, { status: 204 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    await revokeAccessToken(auth.slice(7).trim());
  }
  return new NextResponse(null, { status: 204 });
}
