import { NextRequest } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { attempts, blindTests, sentences } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { childSafeDeep } from "@/lib/child-safe";
import { blindAttemptResponse, evaluateAttempt } from "@/lib/evaluate";
import { jsonOk, parseJsonArray, route } from "@/lib/http";
import { assertWithinDailyLimit } from "@/lib/limits";

export const dynamic = "force-dynamic";
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

/** POST /api/attempts：录音 → voice /v1/pronounce → 落库（voice 挂了也不丢数据）。 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  await assertWithinDailyLimit(user);

  const form = await req.formData();
  const audioField = form.get("audio");
  const sentenceId = (form.get("sentence_id") as string | null) || null;
  let referenceText = ((form.get("reference_text") as string | null) ?? "").trim();
  const mode = ((form.get("mode") as string | null) ?? "scripted") === "unscripted" ? "unscripted" : "scripted";
  const durationMsRaw = form.get("duration_ms");
  const durationMs = durationMsRaw ? Number(durationMsRaw) : null;
  // 盲测批次（契约 §13.4）：带上它就走"进行中不返分"的路径
  const blindTestId = ((form.get("blind_test_id") as string | null) || "").trim() || null;

  if (sentenceId && !referenceText) {
    const [s] = await getDb().select().from(sentences).where(eq(sentences.id, sentenceId)).limit(1);
    if (s) referenceText = s.text;
  }
  if (!referenceText && mode === "scripted") {
    throw new HttpError(400, "bad_request", "scripted 模式必须提供 reference_text");
  }

  let audio: { data: Uint8Array; mime: string } | null = null;
  if (audioField instanceof File) {
    if (audioField.size > MAX_AUDIO_BYTES) {
      throw new HttpError(413, "payload_too_large", "录音文件过大（上限 12MB）");
    }
    audio = {
      data: new Uint8Array(await audioField.arrayBuffer()),
      mime: audioField.type || "audio/webm",
    };
  }

  const out = await evaluateAttempt({
    user,
    sentenceId,
    referenceText,
    mode,
    audio,
    durationMs,
    blindTestId,
  });

  // ★ 契约 §13.3 第 1 条：盲测进行中只返回 attempt_id / blind / progress。
  //   这里用白名单函数构造，绝不 spread out（否则 result/feedback/scores 会漏出去）。
  if (out.blind) {
    // 盲测：只有 3 个键，本来就不含 IPA
    return jsonOk(blindAttemptResponse(out));
  }

  const payload = {
    attempt_id: out.attemptId,
    blind: false,
    degraded: out.degraded,
    retryable: out.retryable,
    message: out.message,
    result: out.result,
    feedback: out.feedback,
    usage: out.usage,
  };
  // 儿童：voice 返回的 issues[].phoneme / words[].phonemes[].phoneme / nbest 都含 IPA，
  // 这里整体兜底剥离（UI 对儿童本就不展示音素，剥离后不影响任何交互）。
  return jsonOk(user.isChild ? childSafeDeep(payload, "attempts.post") : payload);
});

/** GET /api/attempts：最近评测记录（含解析后的 JSON 字段）。 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 20) || 20, 100);
  const rows = await getDb()
    .select()
    .from(attempts)
    .where(eq(attempts.userId, user.id))
    .orderBy(desc(attempts.createdAt))
    .limit(limit);

  // 进行中的盲测：历史接口也不能把分数漏出去（§13.3 第 1 条）
  const blindIds = [...new Set(rows.filter((r) => r.isBlind === 1 && r.blindTestId).map((r) => r.blindTestId as string))];
  const openBlindIds = new Set<string>();
  if (blindIds.length > 0) {
    const tests = await getDb()
      .select()
      .from(blindTests)
      .where(inArray(blindTests.id, blindIds));
    for (const t of tests) {
      if (t.endedAt === null) openBlindIds.add(t.id);
    }
  }

  const listPayload = {
    attempts: rows.map((r) => {
      const masked = r.isBlind === 1 && r.blindTestId !== null && openBlindIds.has(r.blindTestId);
      if (masked) {
        return {
          id: r.id,
          sentence_id: r.sentenceId,
          mode: r.mode,
          reference_text: r.referenceText,
          blind: true,
          blind_test_id: r.blindTestId,
          pending: true,
          scores: null,
          issues: [],
          intonation: null,
          feedback: null,
          audio_url: r.audioPath ? `/api/audio/${r.id}` : null,
          ref_audio_url: null,
          duration_ms: r.durationMs,
          warnings: parseJsonArray(r.warningsJson),
          created_at: r.createdAt,
        };
      }
      return {
        id: r.id,
        sentence_id: r.sentenceId,
        mode: r.mode,
        reference_text: r.referenceText,
        blind: r.isBlind === 1,
        blind_test_id: r.blindTestId,
        pending: false,
        recognized_text: r.recognizedText,
        scores: r.scoresJson ? JSON.parse(r.scoresJson) : null,
        issues: parseJsonArray(r.issuesJson),
        intonation: r.intonationJson ? JSON.parse(r.intonationJson) : null,
        feedback: r.feedbackJson ? JSON.parse(r.feedbackJson) : null,
        audio_url: r.audioPath ? `/api/audio/${r.id}` : null,
        ref_audio_url: r.refAudioUrl,
        duration_ms: r.durationMs,
        warnings: parseJsonArray(r.warningsJson),
        created_at: r.createdAt,
      };
    }),
  };
  return jsonOk(user.isChild ? childSafeDeep(listPayload, "attempts.get") : listPayload);
});
