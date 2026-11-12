/** task-111：后台管理员的新家庭邀请名额/邀请码（从家庭端迁移到 /admin）。 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { families, familyInvites, systemSettings } from "@/db/schema";
import { generateInviteCode } from "./families";
import { HttpError } from "./auth";

const QUOTA_KEY = "family_invite_quota_remaining";

export async function getQuotaRemaining(): Promise<number> {
  const [row] = await getDb().select().from(systemSettings).where(eq(systemSettings.key, QUOTA_KEY)).limit(1);
  const n = Number(row?.value ?? "0");
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export async function listAdminFamilyInvites() {
  const db = getDb();
  const rows = await db
    .select({ inv: familyInvites, familyName: families.name })
    .from(familyInvites)
    .leftJoin(families, eq(families.id, familyInvites.usedByFamilyId))
    .orderBy(desc(familyInvites.createdAt))
    .limit(50);
  return {
    quota_remaining: await getQuotaRemaining(),
    invites: rows.map((r) => ({
      code: r.inv.code,
      created_at: r.inv.createdAt,
      used_at: r.inv.usedAt,
      used_by_family_name: r.familyName ?? null,
    })),
  };
}

/** 原子扣减名额 + 生成 8 位一次性码；quota=0 → 403 no_family_quota */
export async function createAdminFamilyInvite() {
  const db = getDb();
  const now = new Date().toISOString();
  // 原子扣减：value > 0 才减 1（避免并发超发，也不需要异步事务）
  const [claimed] = await db
    .update(systemSettings)
    .set({ value: sql`CAST(${systemSettings.value} AS INTEGER) - 1`, updatedAt: now })
    .where(and(eq(systemSettings.key, QUOTA_KEY), sql`CAST(${systemSettings.value} AS INTEGER) > 0`))
    .returning();
  if (!claimed) throw new HttpError(403, "no_family_quota", "邀请名额已用完，请先调整名额");
  const code = generateInviteCode();
  await db.insert(familyInvites).values({ code, createdByUserId: "admin", createdByFamilyId: "admin", createdAt: now });
  return { code, quota_remaining: Math.max(0, Math.floor(Number(claimed.value))) };
}

export async function setQuotaRemaining(input: { set?: unknown; add?: unknown }) {
  const db = getDb();
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, QUOTA_KEY)).limit(1);
  const cur = Math.floor(Number(row?.value ?? "0")) || 0;
  let next: number;
  if (input.set !== undefined) next = Number(input.set);
  else if (input.add !== undefined) next = cur + Number(input.add);
  else throw new HttpError(400, "bad_request", "需要 set 或 add");
  if (!Number.isFinite(next) || next < 0) throw new HttpError(400, "bad_request", "名额必须是非负整数");
  next = Math.floor(next);
  await db
    .insert(systemSettings)
    .values({ key: QUOTA_KEY, value: String(next), updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: String(next), updatedAt: new Date().toISOString() } });
  return { quota_remaining: next };
}
