import { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk, parseJsonObject, route } from "@/lib/http";
import type { DialogueCorrection } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/chat/sessions/:id — 会话消息（只能看自己的）。 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;
  const db = getDb();
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .limit(1);
  if (!session || session.userId !== user.id) {
    throw new HttpError(404, "not_found", "会话不存在");
  }
  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatSessionId, id))
    .orderBy(asc(chatMessages.createdAt));

  return jsonOk({
    session_id: session.id,
    scenario_id: session.scenarioId,
    turn_count: session.turnCount,
    started_at: session.startedAt,
    ended_at: session.endedAt,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      text_zh: m.textZh,
      correction: parseJsonObject<DialogueCorrection>(m.correctionJson),
      flag: m.flag,
      audio_url: m.audioPath ? `/api/audio/${m.id}` : null,
      created_at: m.createdAt,
    })),
  });
});
