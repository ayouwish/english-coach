/**
 * 家庭成员管理（task-54）—— 家长创建/编辑账号（不同英语水平）。
 *
 * 安全约束：
 *  - **仅家长**可用（路由侧 requireParent；儿童 403）
 *  - 不能修改自己的 role（避免把唯一家长降级）；暂不提供删除（数据保留）
 *  - 密码只存 bcrypt hash，**绝不写日志/响应**
 *  - 不改动既有三个种子账号
 */
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { attempts, users } from "@/db/schema";
import { hashPassword } from "@/db/bootstrap";
import { HttpError } from "./auth";
import { CEFR_LEVELS, isCefrLevel } from "./levels";

export const FAMILY_LOGIN_DOMAIN = "@family.local";
export const MIN_PASSWORD = 8;
export const MAX_DISPLAY_NAME = 20;

export interface FamilyMember {
  id: string;
  email: string;
  display_name: string;
  role: string;
  age_band: string;
  cefr_level: string;
  avatar: string | null;
  birth_year: number | null;
  daily_limit_minutes: number;
  allow_free_chat: boolean;
  created_at: string;
  stats: { attempts: number; last_active_at: string | null };
}

/** login 允许简写：没有 @ 的自动补 @family.local；含 @ 视为完整邮箱 */
export function normalizeLogin(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s) throw new HttpError(400, "bad_request", "请填写登录名");
  if (s.length > 80) throw new HttpError(400, "bad_request", "登录名太长了");
  const email = s.includes("@") ? s : `${s}${FAMILY_LOGIN_DOMAIN}`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "bad_request", "登录名不合法（可以只写简称，例如 laoba）");
  }
  return email;
}

function normalizeDisplayName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new HttpError(400, "bad_request", "请填写昵称");
  if (s.length > MAX_DISPLAY_NAME) throw new HttpError(400, "bad_request", `昵称最多 ${MAX_DISPLAY_NAME} 字`);
  return s;
}

function normalizePassword(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  if (s.length < MIN_PASSWORD) throw new HttpError(400, "bad_request", `密码至少 ${MIN_PASSWORD} 位`);
  if (s.length > 128) throw new HttpError(400, "bad_request", "密码太长了");
  return s;
}

function normalizeRole(raw: unknown): "parent" | "child" {
  if (raw === "parent" || raw === "child") return raw;
  throw new HttpError(400, "bad_request", "角色必须是 parent 或 child");
}

function normalizeCefr(raw: unknown): string {
  if (isCefrLevel(raw)) return raw;
  throw new HttpError(400, "bad_request", `英语水平必须是 ${CEFR_LEVELS.join(" / ")} 之一`);
}

function normalizeLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) throw new HttpError(400, "bad_request", "每日时长必须是数字");
  const v = Math.round(n);
  if (v < 5 || v > 180) throw new HttpError(400, "bad_request", "每日时长需要在 5–180 分钟之间");
  return v;
}

function normalizeAvatar(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  return [...s].slice(0, 8).join("");
}

function normalizeBirthYear(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  const year = new Date().getFullYear();
  if (!Number.isFinite(n) || n < 1900 || n > year) throw new HttpError(400, "bad_request", "出生年份不合法");
  return Math.round(n);
}

function normalizeBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === 0 || raw === 1) return raw === 1;
  return fallback;
}

export async function createFamilyMember(input: {
  displayName?: unknown;
  login?: unknown;
  password?: unknown;
  role?: unknown;
  cefrLevel?: unknown;
  birthYear?: unknown;
  avatar?: unknown;
  dailyLimitMinutes?: unknown;
  allowFreeChat?: unknown;
}): Promise<FamilyMember> {
  const displayName = normalizeDisplayName(input.displayName);
  const email = normalizeLogin(input.login);
  const password = normalizePassword(input.password);
  const role = normalizeRole(input.role);
  const cefrLevel = normalizeCefr(input.cefrLevel);
  const birthYear = normalizeBirthYear(input.birthYear);
  const avatar = normalizeAvatar(input.avatar);
  const dailyLimitMinutes = input.dailyLimitMinutes === undefined ? 20 : normalizeLimit(input.dailyLimitMinutes);
  const allowFreeChat = normalizeBool(input.allowFreeChat, true);

  const db = getDb();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    throw new HttpError(409, "conflict", `登录名 ${email} 已经有人用了，换一个吧`);
  }

  const id = `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const ageBand = role === "child" ? "child" : "adult";
  const createdAt = new Date().toISOString();
  await db.insert(users).values({
    id,
    email,
    passwordHash: hashPassword(password),
    displayName,
    role,
    birthYear,
    ageBand,
    cefrLevel,
    nativeLanguage: "zh",
    avatar,
    dailyLimitMinutes,
    allowFreeChat: allowFreeChat ? 1 : 0,
    createdAt,
  });
  const member = await getFamilyMember(id);
  if (!member) throw new HttpError(500, "internal_error", "创建成功但读取失败，请刷新页面");
  return member;
}

export async function getFamilyMember(id: string): Promise<FamilyMember | null> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) return null;
  const stats = await memberStats([row.id]);
  return toMember(row, stats.get(row.id));
}

async function memberStats(ids: string[]): Promise<Map<string, { attempts: number; last_active_at: string | null }>> {
  const map = new Map<string, { attempts: number; last_active_at: string | null }>();
  if (ids.length === 0) return map;
  const db = getDb();
  const rows = await db
    .select({
      userId: attempts.userId,
      c: sql<number>`count(*)`,
      last: sql<string | null>`max(${attempts.createdAt})`,
    })
    .from(attempts)
    .where(sql`${attempts.userId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
    .groupBy(attempts.userId);
  for (const r of rows) map.set(r.userId, { attempts: Number(r.c), last_active_at: r.last ?? null });
  return map;
}

function toMember(row: typeof users.$inferSelect, stats?: { attempts: number; last_active_at: string | null }): FamilyMember {
  return {
    id: row.id,
    email: row.email,
    display_name: row.displayName,
    role: row.role,
    age_band: row.ageBand,
    cefr_level: row.cefrLevel,
    avatar: row.avatar,
    birth_year: row.birthYear,
    daily_limit_minutes: row.dailyLimitMinutes,
    allow_free_chat: row.allowFreeChat === 1,
    created_at: row.createdAt,
    stats: stats ?? { attempts: 0, last_active_at: null },
  };
}

export async function listFamilyMembers(): Promise<FamilyMember[]> {
  const db = getDb();
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  const stats = await memberStats(rows.map((r) => r.id));
  return rows.map((r) => toMember(r, stats.get(r.id)));
}

/** PATCH：昵称/水平/时长/自由聊/头像（**角色不可改**；改自己的角色尤其禁止） */
export async function updateFamilyMember(
  callerId: string,
  id: string,
  patch: {
    displayName?: unknown;
    cefrLevel?: unknown;
    dailyLimitMinutes?: unknown;
    allowFreeChat?: unknown;
    avatar?: unknown;
    role?: unknown;
  },
): Promise<FamilyMember> {
  if (patch.role !== undefined) {
    if (id === callerId) throw new HttpError(400, "bad_request", "不能修改自己的角色（避免把唯一家长降级）");
    throw new HttpError(400, "bad_request", "暂不支持修改成员角色，请新建一个成员");
  }
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new HttpError(404, "not_found", "找不到这个成员");

  const next: {
    displayName?: string;
    cefrLevel?: string;
    dailyLimitMinutes?: number;
    allowFreeChat?: number;
    avatar?: string | null;
  } = {};
  if (patch.displayName !== undefined) next.displayName = normalizeDisplayName(patch.displayName);
  if (patch.cefrLevel !== undefined) next.cefrLevel = normalizeCefr(patch.cefrLevel);
  if (patch.dailyLimitMinutes !== undefined) next.dailyLimitMinutes = normalizeLimit(patch.dailyLimitMinutes);
  if (patch.allowFreeChat !== undefined) next.allowFreeChat = normalizeBool(patch.allowFreeChat, true) ? 1 : 0;
  if (patch.avatar !== undefined) next.avatar = normalizeAvatar(patch.avatar);
  if (Object.keys(next).length === 0) throw new HttpError(400, "bad_request", "没有要修改的内容");

  await db.update(users).set(next).where(eq(users.id, id));
  const updated = await getFamilyMember(id);
  if (!updated) throw new HttpError(404, "not_found", "找不到这个成员");
  return updated;
}

/** 家长重置成员密码（旧密码立即失效） */
export async function resetMemberPassword(id: string, newPassword: unknown): Promise<void> {
  const password = normalizePassword(newPassword);
  const db = getDb();
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new HttpError(404, "not_found", "找不到这个成员");
  await db.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, id));
}

/** 一个家长自己的账号不能删（本任务也不提供删除接口，这里只做守卫说明） */
export async function assertNotSelf(callerId: string, id: string, action: string): Promise<void> {
  if (callerId === id) throw new HttpError(400, "bad_request", `不能${action}自己的账号`);
}
