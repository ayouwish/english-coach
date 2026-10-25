import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userPrefs } from "@/db/schema";

export type CorrectionLevel = "gentle" | "standard" | "none";

export interface UserPrefs {
  correctionLevel: CorrectionLevel;
  ttsVoice: string | null;
  ttsRate: "slow" | "normal";
}

/** 默认偏好：儿童默认慢速（孩子需要听清），成人默认正常 */
function defaultsFor(isChild: boolean): UserPrefs {
  return { correctionLevel: "gentle", ttsVoice: null, ttsRate: isChild ? "slow" : "normal" };
}

const DEFAULTS: UserPrefs = defaultsFor(false);

export async function getPrefs(userId: string, isChild = false): Promise<UserPrefs> {
  const db = getDb();
  const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1);
  if (!row) {
    const defaults = defaultsFor(isChild);
    await db
      .insert(userPrefs)
      .values({
        userId,
        correctionLevel: defaults.correctionLevel,
        ttsVoice: defaults.ttsVoice,
        ttsRate: defaults.ttsRate,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing();
    return { ...defaults };
  }
  return {
    correctionLevel: (row.correctionLevel as CorrectionLevel) ?? DEFAULTS.correctionLevel,
    ttsVoice: row.ttsVoice,
    ttsRate: row.ttsRate === "slow" ? "slow" : "normal",
  };
}

export async function savePrefs(userId: string, patch: Partial<UserPrefs>): Promise<UserPrefs> {
  const current = await getPrefs(userId);
  const next: UserPrefs = {
    correctionLevel: patch.correctionLevel ?? current.correctionLevel,
    ttsVoice: patch.ttsVoice !== undefined ? patch.ttsVoice : current.ttsVoice,
    ttsRate: patch.ttsRate ?? current.ttsRate,
  };
  await getDb()
    .insert(userPrefs)
    .values({ userId, ...next, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: { ...next, updatedAt: new Date().toISOString() },
    });
  return next;
}
