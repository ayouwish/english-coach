import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { attempts, sentences } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { childSafeDeep } from "@/lib/child-safe";
import { parseJsonObject } from "@/lib/http";
import { jsonOk } from "@/lib/http";
import type { PronounceIssue, PronounceResult } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/sentences/:id/attempts?limit=20 —— 这一句的历史练习（**仅本人**；儿童无 IPA/分数由 UI 控制）。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 20);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20, 1), 50);

    const [sentence] = await getDb()
      .select({ id: sentences.id, text: sentences.text, translationZh: sentences.translationZh, level: sentences.level })
      .from(sentences)
      .where(eq(sentences.id, id))
      .limit(1);
    if (!sentence) throw new HttpError(404, "not_found", "句子不存在");

    const rows = await getDb()
      .select()
      .from(attempts)
      .where(and(eq(attempts.userId, user.id), eq(attempts.sentenceId, id), eq(attempts.isBlind, 0)))
      .orderBy(desc(attempts.createdAt))
      .limit(limit);

    const payload = {
      sentence: {
        id: sentence.id,
        text: sentence.text,
        translation_zh: sentence.translationZh,
        level: sentence.level,
      },
      attempts: rows.map((a) => ({
        id: a.id,
        created_at: a.createdAt,
        scores: parseJsonObject<PronounceResult["scores"]>(a.scoresJson) ?? null,
        issues: (parseJsonObject<PronounceIssue[]>(a.issuesJson) ?? []) as PronounceIssue[],
        audio_url: a.audioPath ? `/api/audio/${a.id}` : null,
      })),
    };
    return jsonOk(user.isChild ? (childSafeDeep(payload, "sentence-attempts") as typeof payload) : payload);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[sentences.attempts]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "读取句子历史失败", detail: {} } }, { status: 500 });
  }
}
