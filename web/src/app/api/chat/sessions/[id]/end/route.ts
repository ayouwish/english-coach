import { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/chat/sessions/:id/end —— 用户主动「结束对话」（task-68；不需要等助手 reply.done）。 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;
  const db = getDb();
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
  if (!session || session.userId !== user.id) throw new HttpError(404, "not_found", "会话不存在");
  if (!session.endedAt) {
    await db
      .update(chatSessions)
      .set({
        endedAt: new Date().toISOString(),
        summaryJson: JSON.stringify({ turns: session.turnCount, scenario: session.scenarioId, ended_by: "user" }),
      })
      .where(and(eq(chatSessions.id, id), isNull(chatSessions.endedAt)));
  }
  return jsonOk({ ok: true, session_id: id, ended: true });
}
