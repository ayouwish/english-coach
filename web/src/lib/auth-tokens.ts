/**
 * Bearer Token 认证（task-60）—— 不透明 token + 哈希存库 + refresh 一次性轮换。
 *
 * 设计：
 *  - token = `randomBytes(32).toString("base64url")`（不可猜，不是自增/可预测 id）；
 *  - 库里**只存** `sha256(token)` 十六进制；校验时用 `timingSafeEqual` 比较；
 *  - access TTL 1h、refresh TTL 30d（`AUTH_ACCESS_TTL_S` / `AUTH_REFRESH_TTL_S` 可覆盖）；
 *  - refresh **一次性**：轮换时用条件 UPDATE（`used_at IS NULL`）抢占，**并发只有一个成功**，
 *    另一个得到 401（客户端应重新登录）——选择这个策略而不是"并发返回同一对"，
 *    因为那样会破坏"旧 refresh 立即失效"的语义；
 *  - `parent_id` 记录签发关系：吊销 refresh 时连带吊销它签发的 access（精确、不影响其它设备）；
 *  - 纯 `node:crypto`，**不引入第三方依赖**；token/密码不进日志。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { authTokens } from "@/db/schema";

const DEFAULT_ACCESS_TTL_S = 3600;
const DEFAULT_REFRESH_TTL_S = 60 * 60 * 24 * 30;

function envTtl(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function accessTtlS(): number {
  return envTtl("AUTH_ACCESS_TTL_S", DEFAULT_ACCESS_TTL_S);
}
export function refreshTtlS(): number {
  return envTtl("AUTH_REFRESH_TTL_S", DEFAULT_REFRESH_TTL_S);
}

export type TokenKind = "access" | "refresh";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 定长比较（防时序攻击）；长度不同直接 false（不泄露长度） */
export function safeEqualHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_expires_in: number;
}

async function insertToken(input: {
  userId: string;
  kind: TokenKind;
  token: string;
  ttlS: number;
  userAgent?: string | null;
  parentId?: string | null;
}): Promise<string> {
  const db = getDb();
  const id = `tok_${randomBytes(8).toString("hex")}`;
  await db.insert(authTokens).values({
    id,
    userId: input.userId,
    tokenHash: hashToken(input.token),
    kind: input.kind,
    expiresAt: new Date(Date.now() + input.ttlS * 1000).toISOString(),
    usedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    userAgent: (input.userAgent ?? "").slice(0, 200) || null,
    parentId: input.parentId ?? null,
  });
  return id;
}

async function issuePair(userId: string, userAgent: string | null | undefined, parentRefreshId: string | null): Promise<IssuedTokens> {
  const access = generateToken();
  const refresh = generateToken();
  const refreshId = await insertToken({ userId, kind: "refresh", token: refresh, ttlS: refreshTtlS(), userAgent, parentId: parentRefreshId });
  await insertToken({ userId, kind: "access", token: access, ttlS: accessTtlS(), userAgent, parentId: refreshId });
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: accessTtlS(),
    refresh_expires_in: refreshTtlS(),
  };
}

/** 登录/刷新成功后签发一对 token */
export async function issueTokenPair(userId: string, userAgent?: string | null): Promise<IssuedTokens> {
  return issuePair(userId, userAgent, null);
}

/** 解析 access token → userId（无效/过期/吊销 → null） */
export async function resolveAccessToken(token: string): Promise<string | null> {
  if (!token || token.length > 200) return null;
  const hash = hashToken(token);
  const db = getDb();
  const rows = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, hash), eq(authTokens.kind, "access")))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!safeEqualHash(row.tokenHash, hash)) return null;
  if (row.revokedAt) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
  return row.userId;
}

/**
 * refresh 一次性轮换：条件 UPDATE 抢占 `used_at IS NULL` → 成功者签发新一对；
 * 并发时只有一次成功（另一个 401）。
 */
export async function rotateRefreshToken(
  refreshToken: string,
  userAgent?: string | null,
): Promise<{ userId: string; tokens: IssuedTokens } | null> {
  if (!refreshToken || refreshToken.length > 200) return null;
  const hash = hashToken(refreshToken);
  const db = getDb();
  const rows = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, hash), eq(authTokens.kind, "refresh")))
    .limit(1);
  const row = rows[0];
  if (!row || !safeEqualHash(row.tokenHash, hash)) return null;
  if (row.revokedAt || row.usedAt) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return null;

  // 抢占：只有 used_at 仍为空的那一次能成功
  const claim = await db
    .update(authTokens)
    .set({ usedAt: new Date().toISOString() })
    .where(
      and(
        eq(authTokens.id, row.id),
        isNull(authTokens.usedAt),
        isNull(authTokens.revokedAt),
        gt(authTokens.expiresAt, new Date().toISOString()),
      ),
    );
  const changes = Number((claim as unknown as { changes?: number })?.changes ?? 0);
  if (changes === 0) return null; // 并发/重复使用

  const tokens = await issuePair(row.userId, userAgent, row.id);
  return { userId: row.userId, tokens };
}

/** 吊销 refresh 及它签发的 access（幂等；返回是否命中过任何 token） */
export async function revokeByRefreshToken(refreshToken: string): Promise<boolean> {
  if (!refreshToken || refreshToken.length > 200) return false;
  const hash = hashToken(refreshToken);
  const db = getDb();
  const rows = await db.select().from(authTokens).where(and(eq(authTokens.tokenHash, hash), eq(authTokens.kind, "refresh"))).limit(1);
  const row = rows[0];
  if (!row || !safeEqualHash(row.tokenHash, hash)) return false;
  const now = new Date().toISOString();
  await db.update(authTokens).set({ revokedAt: now }).where(eq(authTokens.id, row.id));
  await db
    .update(authTokens)
    .set({ revokedAt: now })
    .where(and(eq(authTokens.parentId, row.id), isNull(authTokens.revokedAt)));
  return true;
}

/** 吊销单个 access token（幂等） */
export async function revokeAccessToken(accessToken: string): Promise<boolean> {
  if (!accessToken || accessToken.length > 200) return false;
  const hash = hashToken(accessToken);
  const db = getDb();
  const rows = await db.select().from(authTokens).where(and(eq(authTokens.tokenHash, hash), eq(authTokens.kind, "access"))).limit(1);
  const row = rows[0];
  if (!row || !safeEqualHash(row.tokenHash, hash)) return false;
  await db.update(authTokens).set({ revokedAt: new Date().toISOString() }).where(eq(authTokens.id, row.id));
  return true;
}

// ── 基本防爆破：同 email 连续失败 5 次 → 60s 内 429（**内存计数；多实例部署时各实例独立**）──
const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;
const failures = new Map<string, { count: number; blockedUntil: number }>();

export function isLoginBlocked(email: string): boolean {
  const rec = failures.get(email);
  if (!rec) return false;
  if (rec.blockedUntil > Date.now()) return true;
  if (rec.blockedUntil !== 0) failures.delete(email);
  return false;
}

export function noteLoginFailure(email: string): void {
  const now = Date.now();
  const rec = failures.get(email) ?? { count: 0, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) rec.blockedUntil = now + WINDOW_MS;
  failures.set(email, rec);
}

export function noteLoginSuccess(email: string): void {
  failures.delete(email);
}

/** 测试/运维用：查询当前失败计数（不暴露密码） */
export function loginFailureCount(email: string): number {
  return failures.get(email)?.count ?? 0;
}
