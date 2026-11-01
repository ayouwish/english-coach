import { NextRequest } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatScenarios, chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import { assertWithinDailyLimit } from "@/lib/limits";
import { ageOf, audienceForUser, isScenarioAllowedFor, scenarioAudience } from "@/lib/chat";
import { openingZh } from "@/lib/opening-zh";
import { builtinVariations, getCustomScenario, parseVariants, pickVariation, type ScenarioVariation } from "@/lib/custom-scenarios";

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

  // task-79：内置场景不存在 → 可能是当前用户的自定义场景（仅 owner，他人 404）
  if (!scenario) {
    const custom = await getCustomScenario(user.id, scenarioId);
    if (!custom) throw new HttpError(404, "not_found", "场景不存在或未启用");
    if (custom.audience !== audienceForUser(user)) {
      throw new HttpError(403, "forbidden", user.isChild ? "这是给大人的场景，换一个小朋友的场景吧" : "这是给小朋友的场景，换一个成人场景吧");
    }
    const variants = parseVariants(custom.variantsJson);
    const variation = pickVariation(variants);
    const opening = variation?.opening_line ?? custom.openingLine;
    const sessionId = `cs_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const now = new Date().toISOString();
    await db.insert(chatSessions).values({
      id: sessionId,
      userId: user.id,
      scenarioId: custom.id,
      startedAt: now,
      endedAt: null,
      turnCount: 0,
      summaryJson: null,
      variationJson: variation ? JSON.stringify(variation) : null,
    });
    await db.insert(chatMessages).values({
      id: `cm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      chatSessionId: sessionId,
      role: "assistant",
      text: opening,
      textZh: null,
      correctionJson: null,
      flag: "ok",
      audioPath: null,
      createdAt: now,
    });
    return jsonOk({
      session_id: sessionId,
      is_custom: true,
      scenario: {
        id: custom.id,
        title: custom.title,
        title_zh: custom.titleZh,
        setting_zh: custom.settingZh,
        opening_line: opening,
        level: custom.level,
        min_age: 0,
        variation,
      },
    });
  }
  if (!isScenarioAllowedFor(user, scenario.minAge)) {
    throw new HttpError(
      403,
      "forbidden",
      `这个场景适合 ${scenario.minAge} 岁以上，换一个试试吧`,
    );
  }
  const scenarioTags = JSON.parse(scenario.tags) as string[];
  if (scenarioAudience(scenarioTags) !== audienceForUser(user)) {
    throw new HttpError(
      403,
      "forbidden",
      user.isChild ? "这是给大人的场景，换一个小朋友的场景吧" : "这是给小朋友的场景，换一个成人场景吧",
    );
  }

  // task-79：随机抽一组变体（开场白随之不同）；历史回看用存下来的这组
  const variation: ScenarioVariation | null = pickVariation(builtinVariations(scenario.id));
  const opening = variation?.opening_line ?? scenario.openingLine;
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
    variationJson: variation ? JSON.stringify(variation) : null,
  });
  await db.insert(chatMessages).values({
    id: `cm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    chatSessionId: sessionId,
    role: "assistant",
    text: opening,
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
        opening_line: opening,
        level: scenario.level,
        min_age: scenario.minAge,
        variation,
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
