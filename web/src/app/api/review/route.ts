import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { auditLog, srsCards } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import { buildReviewData } from "@/lib/review-data";
import { GRADES, gradeLabelZh, schedule, type Grade } from "@/lib/srs";
import { getCapabilities } from "@/lib/voice";

export const dynamic = "force-dynamic";

/** GET /api/review — 错音本：待复习卡片 + 音素掌握度 + 高频错词（单词级粗评）。 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 20) || 20;
  const caps = await getCapabilities();
  const data = await buildReviewData({
    userId: user.id,
    isChild: user.isChild,
    limit,
    phonemeLevel: caps.capabilities.phoneme_level,
    voiceReachable: caps.reachable,
  });
  return jsonOk({
    ...data,
    grades: GRADES.map((g) => ({ grade: g, label_zh: gradeLabelZh(g) })),
  });
});

/** POST /api/review — SM-2 简化版评分（again/hard/good/easy）。 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const body = (await req.json().catch(() => null)) as
    | { card_id?: string; grade?: string }
    | null;
  const grade = body?.grade as Grade | undefined;
  const cardId = body?.card_id;
  if (!cardId) throw new HttpError(400, "bad_request", "缺少 card_id");
  if (!grade || !GRADES.includes(grade)) {
    throw new HttpError(400, "bad_request", `grade 必须是 ${GRADES.join("/")}`);
  }

  const db = getDb();
  const [card] = await db.select().from(srsCards).where(eq(srsCards.id, cardId)).limit(1);
  if (!card || card.userId !== user.id) throw new HttpError(404, "not_found", "卡片不存在");

  const next = schedule(
    { ease: card.ease, intervalDays: card.intervalDays, reps: card.reps, lapses: card.lapses },
    grade,
  );
  await db
    .update(srsCards)
    .set({
      ease: next.ease,
      intervalDays: next.intervalDays,
      reps: next.reps,
      lapses: next.lapses,
      dueAt: next.dueAt.toISOString(),
      lastGrade: grade,
    })
    .where(eq(srsCards.id, cardId));

  await db.insert(auditLog).values({
    id: `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    ts: new Date().toISOString(),
    actorUserId: user.id,
    action: "review.graded",
    detailJson: JSON.stringify({ cardId, kind: card.kind, ref: card.ref, grade }),
  });

  return jsonOk({
    card_id: cardId,
    grade,
    next_due_at: next.dueAt.toISOString(),
    interval_days: next.intervalDays,
    ease: next.ease,
    reps: next.reps,
    lapses: next.lapses,
  });
});
