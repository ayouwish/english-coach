import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import fs from "node:fs";
import { ensureBootstrap, getDb } from "@/db";
import { attempts } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { extFromMime } from "@/lib/audio";
import { resolveAudioPath } from "@/lib/audio";
import { childSafeDeep } from "@/lib/child-safe";
import { evaluateAttempt } from "@/lib/evaluate";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/attempts/:id/retry：用已保存的录音重新评测（不重新录音、不重复上传）。 */
export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;

  const db = getDb();
  const [row] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.id, id), eq(attempts.userId, user.id)))
    .limit(1);
  if (!row) throw new HttpError(404, "not_found", "找不到这条录音记录");
  if (!row.audioPath) throw new HttpError(409, "no_audio", "这条记录没有保存录音，无法重试");
  // 盲测记录不允许"重试评测"：重试会把分数暴露出来，盲测随即失效（契约 §13.3 第 1 条）
  if (row.isBlind === 1) {
    throw new HttpError(
      409,
      "blind_attempt_no_retry",
      "盲测中的录音不能重试评测（否则会看到分数，盲测就失效了）。等这次盲测结束再看周报吧。",
    );
  }

  const abs = resolveAudioPath(row.audioPath);
  if (!abs || !fs.existsSync(abs)) {
    throw new HttpError(410, "audio_gone", "录音文件不存在了");
  }
  const data = new Uint8Array(fs.readFileSync(abs));
  const ext = row.audioPath.split(".").pop() ?? "webm";

  const out = await evaluateAttempt({
    user,
    sentenceId: row.sentenceId,
    referenceText: row.referenceText,
    mode: row.mode === "unscripted" ? "unscripted" : "scripted",
    audio: { data, mime: mimeForExt(ext) },
    durationMs: row.durationMs,
  });

  const payload = {
    attempt_id: out.attemptId,
    retried_from: id,
    degraded: out.degraded,
    retryable: out.retryable,
    message: out.message,
    result: out.result,
    feedback: out.feedback,
  };
  return jsonOk(user.isChild ? childSafeDeep(payload, "attempts.retry") : payload);
});

function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    webm: "audio/webm",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
  };
  return map[ext] ?? `audio/${extFromMime(null, ext)}`;
}
