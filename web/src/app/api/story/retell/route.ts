import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap, getDb } from "@/db";
import { storyRetells } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { isCefrLevel } from "@/lib/levels";
import { callStoryRetell, VoiceError } from "@/lib/voice";

export const dynamic = "force-dynamic";
const MAX_TRANSCRIPT = 4000;
const UNAVAILABLE_HINT = "复述评估暂未就绪（voice 侧 /v1/story/retell 未上线）。可以先用英文把故事讲给爸爸妈妈听。";

/**
 * POST /api/story/retell —— 复述评估（task-50 P3，代理 voice `/v1/story/retell`）。
 * 录音先走 /api/asr 转写，这里只收 story_sentences + transcript；成功时把结果存进 story_retells。
 * **不返回发音分**（复述阶段重点是表达）。
 */
export async function POST(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as
      | { material_id?: unknown; story_sentences?: unknown; transcript?: unknown; level?: unknown }
      | null;
    if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");

    const materialId = typeof body.material_id === "string" && body.material_id.trim() ? body.material_id.trim() : null;
    const storySentences = Array.isArray(body.story_sentences)
      ? body.story_sentences.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 40)
      : [];
    const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
    if (storySentences.length === 0) throw new HttpError(400, "bad_request", "缺少故事原文（story_sentences）");
    if (!transcript) throw new HttpError(400, "bad_request", "没有听到你的复述，再讲一次吧");
    if (transcript.length > MAX_TRANSCRIPT) throw new HttpError(400, "bad_request", "复述内容太长了，精简一点再试");
    const level = isCefrLevel(body.level) ? body.level : "A2";

    const result = await callStoryRetell({ story_sentences: storySentences, transcript, level });
    const record = {
      id: `ret_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      coverage: typeof result.coverage === "number" ? result.coverage : null,
      covered: Array.isArray(result.covered_points) ? result.covered_points : [],
      missing: Array.isArray(result.missing_points) ? result.missing_points : [],
      feedbackZh: result.feedback_zh ?? "",
      feedbackEn: result.feedback_en ?? "",
      createdAt: new Date().toISOString(),
    };
    await getDb()
      .insert(storyRetells)
      .values({
        id: record.id,
        materialId,
        userId: user.id,
        storySentencesJson: JSON.stringify(storySentences),
        transcript,
        coverage: record.coverage,
        coveredJson: JSON.stringify(record.covered),
        missingJson: JSON.stringify(record.missing),
        feedbackZh: record.feedbackZh,
        feedbackEn: record.feedbackEn,
        createdAt: record.createdAt,
      });

    return NextResponse.json({
      id: record.id,
      coverage: record.coverage,
      covered_points: record.covered,
      missing_points: record.missing,
      feedback_zh: record.feedbackZh,
      feedback_en: record.feedbackEn,
      warnings: result.warnings ?? [],
      provider: result.provider ?? "unknown",
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    if (err instanceof VoiceError) {
      const unavailable =
        err.code === "voice_unreachable" ||
        err.status === 404 ||
        err.status === 405 ||
        err.status === 502 ||
        err.status === 503 ||
        err.status === 504;
      if (unavailable) {
        console.warn(`[retell] voice 侧不可用（${err.code}/${err.status ?? "-"}）：${err.message}`);
        return NextResponse.json(
          { error: { code: "retell_unavailable", message: UNAVAILABLE_HINT, detail: { reason: err.code } } },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { error: { code: err.code, message: `复述评估失败：${err.message}。可以再讲一次。`, detail: {} } },
        { status: 502 },
      );
    }
    console.error("[retell]", err);
    return NextResponse.json(
      { error: { code: "internal_error", message: "复述评估出错了，可以再讲一次。", detail: {} } },
      { status: 500 },
    );
  }
}
