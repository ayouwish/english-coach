import { NextRequest } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatScenarios, chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import { assertWithinDailyLimit } from "@/lib/limits";
import { ageOf, isScenarioAllowedFor } from "@/lib/chat";
import { openingZh } from "@/lib/opening-zh";

export const dynamic = "force-dynamic";

/** POST /api/chat/sessions：开始一个对话场景。 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  await assertWithinDailyLimit(user);

  const body = (await req.json().catch(() => null)) as { scenario_id?: string } | null;
  const scenarioId = body?.scenario_id;
  if (!scenarioId) throw new HttpError(400, "bad_request", "缺少 scenario_id");

  const db = getDb();
  const [scenario] = await db
    .select()
    .from(chatScenarios)
    .where(and(eq(chatScenarios.id, scenarioId), eq(chatScenarios.enabled, 1)))
    .limit(1);
  if (!scenario) throw new HttpError(404, "not_found", "场景不存在或未启用");
  if (!isScenarioAllowedFor(user, scenario.minAge)) {
    throw new HttpError(
      403,
      "forbidden",
      `这个场景适合 ${scenario.minAge} 岁以上，换一个试试吧`,
    );
  }

  const sessionId = `cs_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date().toISOString();
  await db.insert(chatSessions).values({
    id: sessionId,
    userId: user.id,
    scenarioId: scenario.id,
    startedAt: now,
    endedAt: null,
    turnCount: 0,
    summaryJson: null,
  });
  await db.insert(chatMessages).values({
    id: `cm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    chatSessionId: sessionId,
    role: "assistant",
    text: scenario.openingLine,
    textZh: openingZh(scenario.id),
    correctionJson: null,
    flag: "ok",
    audioPath: null,
    createdAt: now,
  });

  return jsonOk(
    {
      session_id: sessionId,
      scenario: {
        id: scenario.id,
        title: scenario.title,
        title_zh: scenario.titleZh,
        setting_zh: scenario.settingZh,
        opening_line: scenario.openingLine,
        level: scenario.level,
        min_age: scenario.minAge,
      },
      age: ageOf(user),
      turn_count: 0,
      messages: [
        { role: "assistant", text: scenario.openingLine, text_zh: null, created_at: now },
      ],
    },
    201,
  );
});

/** GET /api/chat/sessions：我的对话记录。 */
export const GET = route(async () => {
  await ensureBootstrap();
  const user = await requireUser();
  const rows = await getDb()
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.userId, user.id))
    .orderBy(desc(chatSessions.startedAt))
    .limit(30);

  const db = getDb();
  const withScenario = await Promise.all(
    rows.map(async (s) => {
      const [sc] = await db
        .select()
        .from(chatScenarios)
        .where(eq(chatScenarios.id, s.scenarioId))
        .limit(1);
      const msgs = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.chatSessionId, s.id))
        .orderBy(asc(chatMessages.createdAt));
      return {
        id: s.id,
        scenario_id: s.scenarioId,
        scenario_title: sc?.title ?? s.scenarioId,
        scenario_title_zh: sc?.titleZh ?? s.scenarioId,
        started_at: s.startedAt,
        ended_at: s.endedAt,
        turn_count: s.turnCount,
        last_message: msgs.length > 0 ? msgs[msgs.length - 1].text : null,
      };
    }),
  );

  return jsonOk({ sessions: withScenario });
});
