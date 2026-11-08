/**
 * 多家庭（task-97/98）：家庭模型 + 邀请码 + 公开注册。
 *
 * 安全模型：
 *  - 每个用户必有 family_id（老数据在迁移 0021 中回填 fam_default）
 *  - 家长可看本家庭数据；跨家庭一律 404（task-98 在各资源处强制）
 *  - 邀请码 8 位大写字母数字（去易混字符），家长可重置；旧码立即失效
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { families, familyInvites, users } from "@/db/schema";
import { HttpError, createSession, type SessionUser } from "./auth";
import { hashPassword } from "@/db/bootstrap";

export const DEFAULT_FAMILY_ID = "fam_default";
export const DEFAULT_FAMILY_NAME = "我家";
/** 去掉了 0/O/1/I/L 等易混字符 */
export const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 8;
/** 每个家庭最多 3 个家长账号（创建者 + 2 位受邀家长） */
export const MAX_PARENTS_PER_FAMILY = 3;

/** 是否允许"创建新家庭"（ALLOW_SELF_SIGNUP=0 时关闭；凭邀请码加入不受影响） */
export function allowSelfSignup(): boolean {
  // task-105：默认关闭开放注册；只有显式 ALLOW_SELF_SIGNUP=1 才允许无码建家庭
  return process.env.ALLOW_SELF_SIGNUP === "1";
}

export function generateInviteCode(length = INVITE_CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return out;
}

/** 规范化邀请码（大写去空格）；空 → null */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  return s ? s : null;
}

function normalizeDisplayName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new HttpError(400, "bad_request", "请填写昵称");
  if (s.length > 20) throw new HttpError(400, "bad_request", "昵称最多 20 字");
  return s;
}

function normalizeFamilyName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new HttpError(400, "bad_request", "请填写家庭名称");
  if (s.length > 20) throw new HttpError(400, "bad_request", "家庭名称最多 20 字");
  return s;
}

function normalizeEmail(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s) throw new HttpError(400, "bad_request", "请填写邮箱");
  if (s.length > 120) throw new HttpError(400, "bad_request", "邮箱太长了");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, "bad_request", "邮箱格式不正确");
  return s;
}

function normalizePassword(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  if (s.length < 8) throw new HttpError(400, "bad_request", "密码至少 8 位");
  if (s.length > 128) throw new HttpError(400, "bad_request", "密码太长了");
  return s;
}

/** 默认家庭（迁移已插入；这里兜底保证存在） */
export async function ensureDefaultFamily(): Promise<void> {
  await getDb()
    .insert(families)
    .values({
      id: DEFAULT_FAMILY_ID,
      name: DEFAULT_FAMILY_NAME,
      inviteCode: "DEFAULT1",
      inviteUsed: 0,
      createdBy: "u-dad",
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
}

export async function getFamilyById(familyId: string) {
  const [row] = await getDb().select().from(families).where(eq(families.id, familyId)).limit(1);
  return row ?? null;
}

/** 取当前用户的家庭（迁移后必有；缺失则视为默认家庭） */
export async function getFamilyOf(user: Pick<SessionUser, "familyId">) {
  return getFamilyById(user.familyId || DEFAULT_FAMILY_ID);
}

/** 邀请码信息（家长）：含家长人数/上限、邀请码是否已被使用（一次性） */
export async function getInviteInfo(user: SessionUser) {
  const family = await getFamilyOf(user);
  const parentsCount = family
    ? (await getDb()
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.familyId, family.id), eq(users.role, "parent")))).length
    : 0;
  return {
    family_id: family?.id ?? user.familyId,
    family_name: family?.name ?? DEFAULT_FAMILY_NAME,
    invite_code: family?.inviteCode ?? "",
    invite_used: family?.inviteUsed === 1,
    invite_used_by: family?.inviteUsedBy ?? null,
    invite_used_at: family?.inviteUsedAt ?? null,
    parents_count: parentsCount,
    parents_limit: MAX_PARENTS_PER_FAMILY,
  };
}

/** 重置邀请码（家长）：生成不冲突的新码，旧码立即失效 */
export async function rotateInviteCode(user: SessionUser) {
  const db = getDb();
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateInviteCode();
    try {
      const [row] = await db
        .update(families)
        .set({ inviteCode: code, inviteUsed: 0, inviteUsedBy: null, inviteUsedAt: null })
        .where(eq(families.id, user.familyId))
        .returning();
      if (row) return row;
    } catch (err) {
      if (!/UNIQUE constraint failed/i.test(String(err))) throw err;
    }
  }
  throw new HttpError(500, "internal_error", "生成邀请码失败，请重试");
}

export interface RegisterInput {
  display_name: unknown;
  email: unknown;
  password: unknown;
  family_name?: unknown;
  invite_code?: unknown;
  new_family_code?: unknown;
}

/**
 * 公开注册（task-97）：无邀请码 → 建新家庭（parent）；有邀请码 → 加入该家庭（共同家长）。
 * 孩子账号仍由家长在家庭内创建。
 */
export async function registerAccount(input: RegisterInput) {
  const db = getDb();
  const email = normalizeEmail(input.email);
  const password = normalizePassword(input.password);
  const displayName = normalizeDisplayName(input.display_name);
  const inviteCode = normalizeInviteCode(input.invite_code);
  const newFamilyCode = normalizeInviteCode(input.new_family_code);
  if (inviteCode && newFamilyCode) throw new HttpError(400, "bad_request", "一次只能使用一种邀请码");

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new HttpError(409, "conflict", "这个邮箱已经注册过了，直接登录吧");

  let familyId: string;
  if (newFamilyCode) {
    const [famInvite] = await db.select().from(familyInvites).where(eq(familyInvites.code, newFamilyCode)).limit(1);
    if (!famInvite) throw new HttpError(400, "bad_request", "邀请码无效，请向管理员确认");
    if (famInvite.usedAt) throw new HttpError(400, "bad_request", "邀请码已被使用，请让管理员重新生成");
    familyId = `fam_${randomBytes(8).toString("hex")}`;
    await createFamilyWithUniqueCode(familyId, normalizeFamilyName(input.family_name));
    // 占用码（并发下只有一次成功）
    const [claimed] = await db
      .update(familyInvites)
      .set({ usedAt: new Date().toISOString(), usedByUserId: null, usedByFamilyId: familyId })
      .where(and(eq(familyInvites.code, newFamilyCode), sql`${familyInvites.usedAt} IS NULL`))
      .returning();
    if (!claimed) throw new HttpError(400, "bad_request", "邀请码已被使用，请让管理员重新生成");
  } else if (inviteCode) {
    const [family] = await db.select().from(families).where(eq(families.inviteCode, inviteCode)).limit(1);
    if (!family) throw new HttpError(400, "bad_request", "邀请码无效，请向家长确认");
    // task-99：邀请码一次性（已被使用 → 失效，需要家长重置）
    if (family.inviteUsed === 1) throw new HttpError(400, "bad_request", "邀请码已被使用，请让家长重置后再加入");
    // task-99：每家庭家长上限 3（创建者 + 2 位受邀）
    const parents = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.familyId, family.id), eq(users.role, "parent")));
    if (parents.length >= MAX_PARENTS_PER_FAMILY) {
      throw new HttpError(409, "parent_limit_reached", `每个家庭最多 ${MAX_PARENTS_PER_FAMILY} 个家长账号（含创建者）`);
    }
    // 原子占用邀请码：并发下只有一个人能成功
    const [claimed] = await db
      .update(families)
      .set({ inviteUsed: 1 })
      .where(and(eq(families.id, family.id), eq(families.inviteCode, inviteCode), eq(families.inviteUsed, 0)))
      .returning();
    if (!claimed) throw new HttpError(400, "bad_request", "邀请码已被使用，请让家长重置后再加入");
    familyId = family.id;
  } else {
    // task-99：ALLOW_SELF_SIGNUP=0 时关闭"创建新家庭"（凭邀请码加入仍允许）
    if (!allowSelfSignup()) {
      throw new HttpError(403, "signup_disabled", "本站未开放自助注册，请联系站长（或让家长分享邀请码加入家庭）");
    }
    const familyName = normalizeFamilyName(input.family_name);
    familyId = `fam_${randomBytes(8).toString("hex")}`;
    const created = await createFamilyWithUniqueCode(familyId, familyName);
    if (!created) throw new HttpError(500, "internal_error", "创建家庭失败，请重试");
  }

  const userId = `u_${randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();
  try {
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash: hashPassword(password),
      displayName,
      role: "parent",
      familyId,
      ageBand: "adult",
      cefrLevel: "A1",
      nativeLanguage: "zh",
      dailyLimitMinutes: 30,
      allowFreeChat: 1,
      createdAt: now,
    });
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err))) throw new HttpError(409, "conflict", "这个邮箱已经注册过了，直接登录吧");
    throw err;
  }
  if (newFamilyCode) {
    await db.update(familyInvites).set({ usedByUserId: userId }).where(eq(familyInvites.code, newFamilyCode));
  }
  if (inviteCode) {
    // 记录使用人/时间（审计；失败不影响注册主流程）
    await db
      .update(families)
      .set({ inviteUsedBy: userId, inviteUsedAt: now })
      .where(eq(families.id, familyId))
      .catch(() => undefined);
  }
  const session = await createSession(userId);
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      ageBand: row.ageBand,
      cefrLevel: row.cefrLevel,
      avatar: row.avatar,
      familyId: row.familyId,
    },
  };
}

async function createFamilyWithUniqueCode(familyId: string, name: string) {
  const db = getDb();
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const [row] = await db
        .insert(families)
        .values({ id: familyId, name, inviteCode: generateInviteCode(), inviteUsed: 0, createdBy: null, createdAt: new Date().toISOString() })
        .returning();
      return row;
    } catch (err) {
      if (!/UNIQUE constraint failed/i.test(String(err))) throw err;
    }
  }
  return null;
}

/** 新家庭邀请（task-105）——仅管理员家庭、且必须余量 > 0。 */
export interface FamilyInviteView {
  code: string;
  created_at: string;
  used_at: string | null;
  used_by_family_name: string | null;
}

export async function listFamilyInvites(user: SessionUser) {
  const family = await getFamilyOf(user);
  const isAdmin = family?.isAdmin === 1;
  if (!isAdmin) throw new HttpError(403, "no_family_quota", "本家庭没有邀请新家庭的名额，请联系管理员");
  const rows = await getDb()
    .select({ inv: familyInvites, name: families.name })
    .from(familyInvites)
    .leftJoin(families, eq(families.id, familyInvites.usedByFamilyId))
    .where(eq(familyInvites.createdByFamilyId, family!.id))
    .orderBy(desc(familyInvites.createdAt))
    .limit(20);
  return {
    is_admin: true,
    quota_remaining: family!.familyInviteQuota,
    quota_total_hint: 100,
    invites: rows.map((r) => ({
      code: r.inv.code,
      created_at: r.inv.createdAt,
      used_at: r.inv.usedAt,
      used_by_family_name: r.name ?? null,
    })),
  };
}

export async function createFamilyInvite(user: SessionUser) {
  const family = await getFamilyOf(user);
  if (!family?.isAdmin) throw new HttpError(403, "no_family_quota", "本家庭没有邀请新家庭的名额，请联系管理员");
  const [claimed] = await getDb()
    .update(families)
    .set({ familyInviteQuota: sql`${families.familyInviteQuota} - 1` })
    .where(and(eq(families.id, family.id), sql`${families.familyInviteQuota} > 0`))
    .returning();
  if (!claimed) throw new HttpError(403, "no_family_quota", "本家庭没有邀请新家庭的名额，请联系管理员");
  const code = generateInviteCode();
  const now = new Date().toISOString();
  try {
    await getDb().insert(familyInvites).values({ code, createdByUserId: user.id, createdByFamilyId: family.id, createdAt: now });
  } catch (err) {
    // 极小概率撞码：回滚名额并重试一次
    await getDb().update(families).set({ familyInviteQuota: sql`${families.familyInviteQuota} + 1` }).where(eq(families.id, family.id));
    if (!/UNIQUE constraint failed/i.test(String(err))) throw err;
    const retryCode = generateInviteCode();
    await getDb().insert(familyInvites).values({ code: retryCode, createdByUserId: user.id, createdByFamilyId: family.id, createdAt: now });
    return { code: retryCode, quota_remaining: claimed.familyInviteQuota };
  }
  return { code, quota_remaining: claimed.familyInviteQuota };
}
