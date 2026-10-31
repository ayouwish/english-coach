import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { getChatAudioState } from "@/lib/chat-audio";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/sessions/:id/audio/status —— 整段回放生成状态（task-72）。
 *
 * **只读**：绝不触发构建（构建由 /end、turn done=true 的 after() 与 GET audio 触发）。
 * → `{ status: "building" | "ready" | "failed", turn_count, duration_ms?, error? }`
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;

  const db = getDb();
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
  if (!session || session.userId !== user.id) throw new HttpError(404, "not_found", "会话不存在");

  const res = jsonOk(getChatAudioState(id, session.turnCount));
  res.headers.set("cache-control", "no-store");
  return res;
});
