import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { verifyPassword } from "@/db/bootstrap";
import { auditLog, users } from "@/db/schema";
import {
  issueTokenPair,
  isLoginBlocked,
  noteLoginFailure,
  noteLoginSuccess,
} from "@/lib/auth-tokens";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/token —— 移动端用：邮箱+密码换 Bearer token（task-60）。
 * 与 Web 的 Cookie 登录并存；**token 只在响应里出现一次，库里只存 sha256**。
 * 防爆破：同 email 连续失败 5 次 → 60s 内 429（内存计数，多实例时各实例独立）。
 */
export async function POST(req: NextRequest) {
  await ensureBootstrap();
  const body = (await req.json().catch(() => null)) as
    | { email?: string; password?: string; user_agent?: string }
    | null;
  const email = body?.email?.trim().toLowerCase() ?? "";
  const password = body?.password ?? "";
  if (!email || !password) {
    return NextResponse.json({ error: { code: "bad_request", message: "请输入邮箱和密码" } }, { status: 400 });
  }

  if (isLoginBlocked(email)) {
    return NextResponse.json(
      { error: { code: "too_many_requests", message: "密码错误次数太多，请 60 秒后再试" } },
      { status: 429 },
    );
  }

  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!row || !verifyPassword(password, row.passwordHash)) {
    noteLoginFailure(email);
    return NextResponse.json({ error: { code: "bad_request", message: "邮箱或密码不正确" } }, { status: 401 });
  }
  noteLoginSuccess(email);

  const userAgent = body?.user_agent ?? req.headers.get("user-agent");
  const tokens = await issueTokenPair(row.id, userAgent);

  await db.insert(auditLog).values({
    id: `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    ts: new Date().toISOString(),
    actorUserId: row.id,
    action: "auth.token.issue",
    detailJson: JSON.stringify({ email: row.email, access_ttl_s: tokens.expires_in }),
  });

  return jsonOk({
    ...tokens,
    user: {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      ageBand: row.ageBand,
      cefrLevel: row.cefrLevel,
      avatar: row.avatar,
    },
  });
}
