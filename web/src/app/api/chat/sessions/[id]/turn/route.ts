import { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatScenarios, chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { buildLocalDialogue, isChildUnsafeSpeech } from "@/lib/fallback";
import { jsonOk, route } from "@/lib/http";
import { assertWithinDailyLimit } from "@/lib/limits";
import { getPrefs } from "@/lib/prefs";
import type { DialogueResult } from "@/lib/types";
import { recordPracticeTime } from "@/lib/usage";
import { callDialogue, getCapabilities } from "@/lib/voice";

export const dynamic = "force-dynamic";

const SAFE_REPLY = "Let's talk about something else. What do you like to do for fun?";
const SAFE_REPLY_ZH = "我们换个话题吧，你平时喜欢做什么呀？";

/** POST /api/chat/sessions/:id/turn — 推进一轮对话（契约 §6）。 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => null)) as
    | { text?: string; audio_url?: string }
    | null;
  const text = (body?.text ?? "").trim();
  if (!text) throw new HttpError(400, "bad_request", "请输入内容");
  if (text.length > 500) throw new HttpError(400, "bad_request", "单次输入请控制在 500 字符以内");

  await assertWithinDailyLimit(user);

  const db = getDb();
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
  if (!session || session.userId !== user.id) throw new HttpError(404, "not_found", "会话不存在");
  if (session.endedAt) throw new HttpError(409, "session_closed", "这个场景已经结束了，换个场景继续吧");

  const [scenario] = await db
    .select()
    .from(chatScenarios)
    .where(eq(chatScenarios.id, session.scenarioId))
    .limit(1);
  if (!scenario) throw new HttpError(404, "not_found", "场景不存在");

  const history = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatSessionId, id))
    .orderBy(asc(chatMessages.createdAt));

  const turnIndex = history.filter((m) => m.role === "user").length;
  const prefs = await getPrefs(user.id);
  const childSafe = user.isChild || !user.allowFreeChat;
  const caps = await getCapabilities();

  let reply: DialogueResult;
  let degraded = false;
  try {
    reply = await callDialogue({
      scenario: {
        id: scenario.id,
        title: scenario.title,
        title_zh: scenario.titleZh,
        setting_zh: scenario.settingZh,
        role_prompt: scenario.rolePrompt,
        opening_line: scenario.openingLine,
        level: scenario.level,
        min_age: scenario.minAge,
      },
      learner: {
        age_band: user.ageBand,
        level: user.cefrLevel,
        native_language: user.nativeLanguage,
        child_safe: childSafe,
      },
      history: [
        ...history.map((m) => ({ role: m.role as "user" | "assistant", text: m.text })),
        { role: "user" as const, text },
      ],
      correction_level: prefs.correctionLevel,
      turn_index: turnIndex,
    });
  } catch (err) {
    degraded = true;
    console.warn("[dialogue] 降级到本地话术：", err instanceof Error ? err.message : err);
    reply = buildLocalDialogue({
      openingLine: scenario.openingLine,
      history: history.map((m) => ({ role: m.role as "user" | "assistant", text: m.text })),
      isChild: user.isChild,
      level: user.cefrLevel,
      scenarioId: scenario.id,
    });
  }

  // 儿童安全：服务端再兜一层（不信 provider 的自律）
  if (childSafe && isChildUnsafeSpeech(reply.reply)) {
    reply = { ...reply, reply: SAFE_REPLY, reply_zh: SAFE_REPLY_ZH, flag: "unsafe_filtered" };
  }

  const now = new Date().toISOString();
  const userMsgId = `cm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const botMsgId = `cm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  await db.insert(chatMessages).values({
    id: userMsgId,
    chatSessionId: id,
    role: "user",
    text,
    textZh: null,
    correctionJson: null,
    flag: "ok",
    audioPath: null,
    createdAt: now,
  });
  await db.insert(chatMessages).values({
    id: botMsgId,
    chatSessionId: id,
    role: "assistant",
    text: reply.reply,
    textZh: reply.reply_zh,
    correctionJson: JSON.stringify(reply.correction),
    flag: reply.flag,
    audioPath: null,
    createdAt: new Date(Date.now() + 1).toISOString(),
  });

  const nextTurn = turnIndex + 1;
  const done = reply.done || nextTurn >= 6;
  await db
    .update(chatSessions)
    .set({
      turnCount: nextTurn,
      endedAt: done ? new Date().toISOString() : null,
      summaryJson: done
        ? JSON.stringify({ turns: nextTurn, scenario: scenario.id, degraded })
        : null,
    })
    .where(eq(chatSessions.id, id));

  await recordPracticeTime({
    userId: user.id,
    kind: "chat",
    id,
    minutes: 0.5,
    itemCount: 1,
    startedAt: session.startedAt,
  });

  return jsonOk({
    session_id: id,
    provider: reply.provider,
    degraded_llm: reply.degraded_llm === true,
    degraded,
    capabilities: caps.capabilities,
    reply: reply.reply,
    reply_zh: reply.reply_zh,
    correction: reply.correction,
    suggested_replies: reply.suggested_replies,
    target_words: reply.target_words,
    flag: reply.flag,
    done,
    turn_index: nextTurn,
    message_id: botMsgId,
  });
});
