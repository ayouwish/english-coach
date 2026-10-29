import { NextRequest, after } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { createPendingAttempt, enqueueScoring } from "@/lib/async-scoring";
import { blindProgress, requireOpenBlindTest } from "@/lib/blind-test";
import { jsonOk, route } from "@/lib/http";
import { assertWithinDailyLimit } from "@/lib/limits";

export const dynamic = "force-dynamic";
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

/**
 * POST /api/attempts/async —— 连读模式的"录完即走"（task-24）。
 * 只做：校验 + 存音频 + 写 status='pending' 行 → 立即返回（评测用 after() 后台跑）。
 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  await assertWithinDailyLimit(user);

  const form = await req.formData();
  const audioField = form.get("audio");
  if (!(audioField instanceof File)) throw new HttpError(400, "bad_request", "缺少 audio 文件");
  if (audioField.size > MAX_AUDIO_BYTES) throw new HttpError(413, "payload_too_large", "录音文件过大（上限 12MB）");

  const referenceText = ((form.get("reference_text") as string | null) ?? "").trim();
  if (!referenceText) throw new HttpError(400, "bad_request", "缺少 reference_text");
  const sentenceId = ((form.get("sentence_id") as string | null) ?? "").trim() || null;
  const source = (form.get("source") as string | null) === "custom" ? "custom" : "corpus";
  const mode = (form.get("mode") as string | null) === "unscripted" ? "unscripted" : "scripted";
  const durationRaw = form.get("duration_ms");
  const durationMs = durationRaw ? Number(durationRaw) : null;

  // 盲测（task-33）：校验批次属于本人、仍在进行中、句子属于该批次
  const blindTestId = ((form.get("blind_test_id") as string | null) ?? "").trim() || null;
  let blindTotal = 0;
  if (blindTestId) {
    const test = await requireOpenBlindTest(user, blindTestId);
    blindTotal = test.sentence_ids.length;
    if (sentenceId && !test.sentence_ids.includes(sentenceId)) {
      throw new HttpError(400, "bad_request", "这句话不属于当前盲测批次");
    }
  }

  const id = await createPendingAttempt({
    user,
    referenceText,
    sentenceId,
    mode,
    audio: { data: new Uint8Array(await audioField.arrayBuffer()), mime: audioField.type || "audio/webm" },
    durationMs,
    source,
    blindTestId,
  });

  // 响应之后才评分：不阻塞用户进入下一句；并发由 async-scoring 的队列限制为 2
  after(() => {
    enqueueScoring(id);
  });

  // 盲测进行中：依旧只回 attempt_id / blind / status / progress（契约 §13.3 第 1 条：绝不暴露分数）
  if (blindTestId) {
    return jsonOk(
      {
        attempt_id: id,
        blind: true,
        status: "pending",
        progress: await blindProgress(blindTestId, blindTotal),
      },
      201,
    );
  }
  return jsonOk({ id, status: "pending" }, 201);
});
