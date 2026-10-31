import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { parsePron } from "@/lib/chat-pronunciation";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

/** correction_json 解析（旧行可能是 null / 空对象） */
function parseCorrection(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || (typeof v === "object" && Object.keys(v as Record<string, unknown>).length === 0)) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * GET /api/chat/sessions/:id/messages —— 会话内轮询用（task-57）：
 * 发音评分是后台完成的，前端发完一轮后拉几次，把 pron 补到对应消息上。
 * 返回的 `pron` 对儿童已经是去 IPA 的（入库前就剥掉了）。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    const db = getDb();
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    if (!session || session.userId !== user.id) throw new HttpError(404, "not_found", "会话不存在");
    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatSessionId, id))
      .orderBy(asc(chatMessages.createdAt));
    return jsonOk({
      session_id: id,
      messages: rows.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        text_zh: m.textZh,
        audio_url: m.audioPath ? `/api/audio/${m.id}` : null,
        pron: parsePron(m.pronJson),
        // task-74 ②：把「更自然：…」校正提示也返回，历史详情才能保留
        correction: parseCorrection(m.correctionJson),
        flag: m.flag,
      })),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[chat.messages]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "读取对话记录失败", detail: {} } }, { status: 500 });
  }
}
