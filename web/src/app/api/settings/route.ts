import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { auditLog, users } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import { getPrefs, savePrefs, type CorrectionLevel } from "@/lib/prefs";
import { getDailyUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

const LEVELS: CorrectionLevel[] = ["gentle", "standard", "none"];

/** GET /api/settings — 当前用户偏好 + 今日用量。 */
export const GET = route(async () => {
  await ensureBootstrap();
  const user = await requireUser();
  const prefs = await getPrefs(user.id);
  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);
  return jsonOk({ user, prefs, usage });
});

/** PATCH /api/settings — 每日时长上限 / 纠正强度 / 音色 / 自由话题开关。 */
export const PATCH = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const body = (await req.json().catch(() => null)) as {
    daily_limit_minutes?: number;
    allow_free_chat?: boolean;
    correction_level?: string;
    tts_voice?: string | null;
    tts_rate?: string;
    display_name?: string;
  } | null;
  if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");

  // 儿童不能给自己加时长 / 打开自由话题（服务端强制）
  if (user.isChild && (body.daily_limit_minutes !== undefined || body.allow_free_chat !== undefined)) {
    throw new HttpError(403, "forbidden", "每日时长与自由话题由家长设置");
  }

  const db = getDb();
  const userPatch: Partial<typeof users.$inferInsert> = {};
  if (body.daily_limit_minutes !== undefined) {
    const v = Number(body.daily_limit_minutes);
    if (!Number.isFinite(v) || v < 5 || v > 180) {
      throw new HttpError(400, "bad_request", "每日时长上限需在 5–180 分钟之间");
    }
    userPatch.dailyLimitMinutes = Math.round(v);
  }
  if (body.allow_free_chat !== undefined) userPatch.allowFreeChat = body.allow_free_chat ? 1 : 0;
  if (body.display_name !== undefined) {
    const name = body.display_name.trim();
    if (!name || name.length > 30) throw new HttpError(400, "bad_request", "昵称需为 1–30 个字符");
    userPatch.displayName = name;
  }
  if (Object.keys(userPatch).length > 0) {
    await db.update(users).set(userPatch).where(eq(users.id, user.id));
  }

  if (body.correction_level !== undefined && !LEVELS.includes(body.correction_level as CorrectionLevel)) {
    throw new HttpError(400, "bad_request", `correction_level 必须是 ${LEVELS.join("/")}`);
  }
  if (body.tts_rate !== undefined && !["slow", "normal"].includes(body.tts_rate)) {
    throw new HttpError(400, "bad_request", "tts_rate 必须是 slow/normal");
  }
  const prefs = await savePrefs(user.id, {
    correctionLevel: (body.correction_level as CorrectionLevel | undefined) ?? undefined,
    ttsVoice: body.tts_voice !== undefined ? (body.tts_voice || null) : undefined,
    ttsRate: (body.tts_rate as "slow" | "normal" | undefined) ?? undefined,
  });

  await db.insert(auditLog).values({
    id: `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    ts: new Date().toISOString(),
    actorUserId: user.id,
    action: "settings.updated",
    detailJson: JSON.stringify({ userPatch, prefs }),
  });

  const [updated] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  const usage = await getDailyUsage(user.id, updated.dailyLimitMinutes);

  return jsonOk({
    user: {
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName,
      role: updated.role,
      ageBand: updated.ageBand,
      cefrLevel: updated.cefrLevel,
      avatar: updated.avatar,
      dailyLimitMinutes: updated.dailyLimitMinutes,
      allowFreeChat: updated.allowFreeChat === 1,
      isChild: updated.ageBand === "child",
    },
    prefs,
    usage,
  });
});
