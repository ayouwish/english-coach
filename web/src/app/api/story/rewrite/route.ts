import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { buildDiagnosisRaw } from "@/lib/diagnosis";
import { CEFR_LEVELS, isCefrLevel } from "@/lib/levels";
import { callStoryRewrite, VoiceError } from "@/lib/voice";

export const dynamic = "force-dynamic";

const MAX_TEXT_ZH = 2000;
const STORY_UNAVAILABLE_HINT =
  "故事改写服务还没就绪（voice 侧 /v1/story/rewrite 未上线或未启用）。请稍后再试，或先直接在下面写英文。";

/**
 * POST /api/story/rewrite —— 中文故事 → 适龄英文（task-49，代理 voice `/v1/story/rewrite`）。
 * 校验：登录、text_zh 1–2000 字、level ∈ A1/A2/B1/B2；voice 不可用时给**可读中文错误**（不静默）。
 */
export async function POST(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as
      | { text_zh?: unknown; level?: unknown; max_sentences?: unknown; weak_phonemes?: unknown }
      | null;
    if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");

    const textZh = typeof body.text_zh === "string" ? body.text_zh.trim() : "";
    if (!textZh) throw new HttpError(400, "bad_request", "请先用中文讲讲你的故事（不能为空）");
    if (textZh.length > MAX_TEXT_ZH) {
      throw new HttpError(400, "bad_request", `故事太长了（${textZh.length} 字），最多 ${MAX_TEXT_ZH} 字`);
    }
    if (!isCefrLevel(body.level)) {
      throw new HttpError(400, "bad_request", `难度必须是 ${CEFR_LEVELS.join(" / ")} 之一`);
    }
    const maxSentences = Math.min(Math.max(1, Number(body.max_sentences) || 6), 12);
    // 弱音（task-50 P2）：复用现有发音诊断（不新造一套），默认带上最弱的 1–2 个音
    const useWeak = (body as { use_weak_phonemes?: unknown }).use_weak_phonemes !== false;
    let weak = Array.isArray(body.weak_phonemes) ? body.weak_phonemes.slice(0, 10).map(String) : [];
    if (weak.length === 0 && useWeak) {
      try {
        const diagnosis = await buildDiagnosisRaw(user);
        weak = diagnosis.items
          .filter((i) => i.status === "weak" && i.phoneme)
          .slice(0, 2)
          .map((i) => i.phoneme as string);
      } catch {
        weak = [];
      }
    }

    const result = await callStoryRewrite({
      text_zh: textZh,
      level: body.level,
      max_sentences: maxSentences,
      weak_phonemes: weak,
    });

    const sentences = Array.isArray(result.sentences) ? result.sentences.filter((s) => typeof s === "string" && s.trim()) : [];
    return NextResponse.json({
      title_en: (result.title_en ?? sentences[0] ?? "My Story").slice(0, 80),
      sentences,
      text_en: typeof result.text_en === "string" && result.text_en.trim() ? result.text_en : sentences.join(" "),
      level: result.level ?? body.level,
      readability: result.readability ?? null,
      warnings: result.warnings ?? [],
      provider: result.provider ?? "unknown",
      weak_phonemes_used: weak,
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
        console.warn(`[story] voice 侧不可用（${err.code}/${err.status ?? "-"}）：${err.message}`);
        return NextResponse.json(
          { error: { code: "story_unavailable", message: STORY_UNAVAILABLE_HINT, detail: { reason: err.code } } },
          { status: 503 },
        );
      }
      return NextResponse.json(
        {
          error: {
            code: err.code,
            message: `故事改写失败：${err.message}。可以稍后重试，或先在下面直接写英文。`,
            detail: {},
          },
        },
        { status: 502 },
      );
    }
    console.error("[story]", err);
    return NextResponse.json(
      {
        error: {
          code: "internal_error",
          message: "故事改写出错了。可以稍后重试，或先在下面直接写英文。",
          detail: {},
        },
      },
      { status: 500 },
    );
  }
}
