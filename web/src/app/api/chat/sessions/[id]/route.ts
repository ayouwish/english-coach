import fs from "node:fs";
import { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatSessions } from "@/db/schema";
import { resolveAudioPath } from "@/lib/audio";
import { HttpError, requireUser } from "@/lib/auth";
import { chatAudioPaths } from "@/lib/chat-audio";
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

/**
 * DELETE /api/chat/sessions/:id —— 删除自己的这次历史对话（含消息、逐句录音、整段回放缓存）。
 *
 * 只能删自己的（他人会话按 404 处理，不泄露存在性）。
 * 音频文件删除是尽力而为：即便文件已被清理，DB 删除也必须成功。
 */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;
  const db = getDb();

  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
  if (!session || session.userId !== user.id) {
    throw new HttpError(404, "not_found", "会话不存在");
  }

  const messages = await db
    .select({ audioPath: chatMessages.audioPath })
    .from(chatMessages)
    .where(eq(chatMessages.chatSessionId, id));

  await db.delete(chatMessages).where(eq(chatMessages.chatSessionId, id));
  await db.delete(chatSessions).where(eq(chatSessions.id, id));

  for (const m of messages) {
    if (!m.audioPath) continue;
    const abs = resolveAudioPath(m.audioPath);
    if (!abs) continue;
    try {
      fs.unlinkSync(abs);
    } catch {
      /* 文件可能已被清理，忽略 */
    }
  }
  const { audioFile, metaFile } = chatAudioPaths(id);
  for (const file of [audioFile, metaFile]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 没有缓存则忽略 */
    }
  }

  return jsonOk({ deleted: true, session_id: id });
});
