import { cookies, headers } from "next/headers";
import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import type { AgeBand, Role } from "./types";

export const SESSION_COOKIE = "ec_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class HttpError extends Error {
  status: number;
  code: string;
  detail?: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  ageBand: AgeBand;
  cefrLevel: string;
  birthYear: number | null;
  avatar: string | null;
  /** 虚拟形象图片相对路径（task-62）；NULL = 没设 */
  avatarImagePath: string | null;
  avatarStyle: string | null;
  dailyLimitMinutes: number;
  allowFreeChat: boolean;
  nativeLanguage: string;
  isChild: boolean;
}

function toSessionUser(row: typeof users.$inferSelect): SessionUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role as Role,
    ageBand: row.ageBand as AgeBand,
    cefrLevel: row.cefrLevel,
    birthYear: row.birthYear,
    avatar: row.avatar,
    avatarImagePath: row.avatarImagePath ?? null,
    avatarStyle: row.avatarStyle ?? null,
    dailyLimitMinutes: row.dailyLimitMinutes,
    allowFreeChat: row.allowFreeChat === 1,
    nativeLanguage: row.nativeLanguage,
    isChild: row.ageBand === "child",
  };
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb();
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    token,
    userId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  // 顺手清理过期会话
  await db.delete(sessions).where(lt(sessions.expiresAt, createdAt.toISOString()));
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // 默认不设 Secure（内网 http://host:3000 也能登录）；HTTPS 部署请设 COOKIE_SECURE=1
    secure: process.env.COOKIE_SECURE === "1",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await getDb().delete(sessions).where(eq(sessions.token, token));
  }
  store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

/**
 * 读取当前登录用户；未登录返回 null（服务端校验，绝不靠前端隐藏菜单）。
 *
 * 双模式（task-60）：**优先** `Authorization: Bearer <access>`（移动端），
 * 没有 Bearer 才回退 Cookie 会话（Web 端）。两种凭据都落到同一个 `userId`。
 * 注意：带了 Bearer 但无效时**直接视为未登录**（不静默回退 Cookie，避免混淆）。
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const h = await headers();
  const auth = h.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (!token) return null;
    const { resolveAccessToken } = await import("./auth-tokens");
    const userId = await resolveAccessToken(token);
    return userId ? getSessionUserById(userId) : null;
  }
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getUserByToken(token);
}

export async function getUserByToken(token: string): Promise<SessionUser | null> {
  const db = getDb();
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date().toISOString())))
    .limit(1);
  const row = rows[0];
  return row ? toSessionUser(row.user) : null;
}

/** 按 id 取用户（后台任务没有 cookie，用这个） */
export async function getSessionUserById(id: string): Promise<SessionUser | null> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ? toSessionUser(row) : null;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "unauthorized", "请先登录");
  return user;
}

/** /parent 等家长专属资源：child 角色必须 403（服务端强制）。 */
export async function requireParent(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "parent") {
    throw new HttpError(403, "forbidden", "家长面板仅对家长账号开放");
  }
  return user;
}
