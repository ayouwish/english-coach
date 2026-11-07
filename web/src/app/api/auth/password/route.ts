import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { and, eq, ne } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { auditLog, sessions, users } from "@/db/schema";
import { HttpError, requireUser, SESSION_COOKIE } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/db/bootstrap";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/password —— 自助修改密码（task-59）。
 *
 * - 当前密码错误 → 401；新密码 <8 → 400；新旧相同 → 400
 * - 成功后：更新 hash、**保留当前会话**、**删除该用户其他会话**（只按 user_id，不跨家庭）
 * - 响应只返回 {ok:true}，绝不回显密码/hash
 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const body = (await req.json().catch(() => null)) as { current_password?: unknown; new_password?: unknown } | null;
  const currentPassword = typeof body?.current_password === "string" ? body.current_password : "";
  const newPassword = typeof body?.new_password === "string" ? body.new_password : "";
  if (!currentPassword) throw new HttpError(400, "bad_request", "请输入当前密码");
  if (newPassword.length < 8) throw new HttpError(400, "bad_request", "新密码至少 8 位");
  if (newPassword.length > 128) throw new HttpError(400, "bad_request", "新密码太长了");
  if (newPassword === currentPassword) throw new HttpError(400, "bad_request", "新密码不能和当前密码相同");

  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!row) throw new HttpError(404, "not_found", "找不到账号");
  if (!verifyPassword(currentPassword, row.passwordHash)) {
    throw new HttpError(401, "bad_credentials", "当前密码不对");
  }
  if (verifyPassword(newPassword, row.passwordHash)) {
    throw new HttpError(400, "bad_request", "新密码不能和当前密码相同");
  }

  await db.update(users).set({ passwordHash: hashPassword(newPassword) }).where(eq(users.id, user.id));

  // 会话策略：当前会话保留，同用户其他会话全部失效（按 user_id，不涉及家庭）
  const store = await cookies();
  const currentToken = store.get(SESSION_COOKIE)?.value ?? null;
  if (currentToken) {
    await db.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.token, currentToken)));
  } else {
    // Bearer 登录没有 cookie 会话：清掉该用户所有 web 会话（不影响当前 Bearer）
    await db.delete(sessions).where(eq(sessions.userId, user.id));
  }

  await db.insert(auditLog).values({
    id: `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    ts: new Date().toISOString(),
    actorUserId: user.id,
    action: "auth.password.change",
    detailJson: JSON.stringify({ email: user.email }),
  });

  return jsonOk({ ok: true });
});
