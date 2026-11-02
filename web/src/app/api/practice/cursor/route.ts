import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { practiceCursors, sentences } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message, detail: {} } }, { status });
}

/** GET /api/practice/cursor?scope=all —— 上次练到哪（无则 null）。 */
export async function GET(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const scope = (req.nextUrl.searchParams.get("scope") ?? "all").slice(0, 40);
    const [row] = await getDb()
      .select()
      .from(practiceCursors)
      .where(and(eq(practiceCursors.userId, user.id), eq(practiceCursors.scope, scope)))
      .limit(1);
    return jsonOk({
      cursor: row
        ? { scope: row.scope, position: row.position, total: row.total, sentence_id: row.sentenceId, updated_at: row.updatedAt }
        : null,
    });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[practice.cursor.get]", err);
    return errorJson(500, "internal_error", "读取练习进度失败");
  }
}

/** PUT /api/practice/cursor {scope, position, total, sentence_id} —— 保存进度。 */
export async function PUT(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as
      | { scope?: unknown; position?: unknown; total?: unknown; sentence_id?: unknown }
      | null;
    if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");
    const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim().slice(0, 40) : "all";
    const position = Number(body.position);
    const total = Number(body.total);
    if (!Number.isInteger(position) || position < 0 || position > 5000) throw new HttpError(400, "bad_request", "position 不合法");
    if (!Number.isInteger(total) || total < 0 || total > 5000) throw new HttpError(400, "bad_request", "total 不合法");
    const sentenceId = typeof body.sentence_id === "string" && body.sentence_id.trim() ? body.sentence_id.trim() : null;
    if (sentenceId) {
      const [row] = await getDb().select({ id: sentences.id }).from(sentences).where(eq(sentences.id, sentenceId)).limit(1);
      if (!row) throw new HttpError(400, "bad_request", "句子不存在");
    }
    const now = new Date().toISOString();
    await getDb()
      .insert(practiceCursors)
      .values({ userId: user.id, scope, position, total, sentenceId, updatedAt: now })
      .onConflictDoUpdate({
        target: [practiceCursors.userId, practiceCursors.scope],
        set: { position, total, sentenceId, updatedAt: now },
      });
    return jsonOk({ ok: true, cursor: { scope, position, total, sentence_id: sentenceId, updated_at: now } });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[practice.cursor.put]", err);
    return errorJson(500, "internal_error", "保存练习进度失败");
  }
}
