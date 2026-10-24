import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { verifyPassword } from "@/db/bootstrap";
import { auditLog, users } from "@/db/schema";
import { createSession, HttpError, setSessionCookie } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const body = (await req.json().catch(() => null)) as
    | { email?: string; password?: string }
    | null;
  const email = body?.email?.trim().toLowerCase();
  const password = body?.password ?? "";
  if (!email || !password) {
    throw new HttpError(400, "bad_request", "请输入邮箱和密码");
  }

  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!row || !verifyPassword(password, row.passwordHash)) {
    throw new HttpError(401, "unauthorized", "邮箱或密码不正确");
  }

  const { token, expiresAt } = await createSession(row.id);
  await setSessionCookie(token, expiresAt);

  await db.insert(auditLog).values({
    id: `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    ts: new Date().toISOString(),
    actorUserId: row.id,
    action: "auth.login",
    detailJson: JSON.stringify({ email: row.email }),
  });

  return jsonOk({
    user: {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      ageBand: row.ageBand,
      cefrLevel: row.cefrLevel,
      avatar: row.avatar,
      birthYear: row.birthYear,
      dailyLimitMinutes: row.dailyLimitMinutes,
      allowFreeChat: row.allowFreeChat === 1,
      isChild: row.ageBand === "child",
    },
    expiresAt: expiresAt.toISOString(),
  });
});
