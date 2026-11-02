import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userPrefs } from "@/db/schema";

export type CorrectionLevel = "gentle" | "standard" | "none";

export interface UserPrefs {
  correctionLevel: CorrectionLevel;
  ttsVoice: string | null;
  ttsRate: "slow" | "normal";
  /** 单词显示音标（task-87）：null = 角色默认（成人 true / 儿童 false） */
  showWordIpa: boolean | null;
}

/** 单词是否显示 IPA（task-87）：设置优先；未设置时成人开、儿童关（零 IPA 规则） */
export function effectiveShowWordIpa(prefs: Pick<UserPrefs, "showWordIpa">, isChild: boolean): boolean {
  if (prefs.showWordIpa === null || prefs.showWordIpa === undefined) return !isChild;
  return prefs.showWordIpa;
}

/** 默认偏好：儿童默认慢速（孩子需要听清），成人默认正常 */
function defaultsFor(isChild: boolean): UserPrefs {
  return { correctionLevel: "gentle", ttsVoice: null, ttsRate: isChild ? "slow" : "normal", showWordIpa: null };
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
        showWordIpa: null,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing();
    return { ...defaults };
  }
  return {
    correctionLevel: (row.correctionLevel as CorrectionLevel) ?? DEFAULTS.correctionLevel,
    ttsVoice: row.ttsVoice,
    ttsRate: row.ttsRate === "slow" ? "slow" : "normal",
    showWordIpa: row.showWordIpa === null || row.showWordIpa === undefined ? null : row.showWordIpa === 1,
  };
}

export async function savePrefs(userId: string, patch: Partial<UserPrefs>): Promise<UserPrefs> {
  const current = await getPrefs(userId);
  const next: UserPrefs = {
    correctionLevel: patch.correctionLevel ?? current.correctionLevel,
    ttsVoice: patch.ttsVoice !== undefined ? patch.ttsVoice : current.ttsVoice,
    ttsRate: patch.ttsRate ?? current.ttsRate,
    showWordIpa: patch.showWordIpa !== undefined ? patch.showWordIpa : current.showWordIpa,
  };
  const row = {
    correctionLevel: next.correctionLevel,
    ttsVoice: next.ttsVoice,
    ttsRate: next.ttsRate,
    showWordIpa: next.showWordIpa === null ? null : next.showWordIpa ? 1 : 0,
  };
  await getDb()
    .insert(userPrefs)
    .values({ userId, ...row, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: { ...row, updatedAt: new Date().toISOString() },
    });
  return next;
}
