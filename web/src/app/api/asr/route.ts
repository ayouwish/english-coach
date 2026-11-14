import { NextRequest, NextResponse } from "next/server";
import { HttpError, requireUser } from "@/lib/auth";
import { callAsr, VoiceError } from "@/lib/voice";

export const dynamic = "force-dynamic";
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

/** POST /api/asr — 语音转文字（对话的语音输入，契约 §2）。 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const form = await req.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) throw new HttpError(400, "bad_request", "缺少 audio 文件");
    if (audio.size > MAX_AUDIO_BYTES) throw new HttpError(413, "payload_too_large", "录音文件过大");

    // 语言：默认 en（跟读/对话的英文识别不变）；故事模式用 zh-CN
    const rawLang = (form.get("language") as string | null) ?? new URL(req.url).searchParams.get("language");
    const language = rawLang === "zh-CN" || rawLang === "zh" ? "zh-CN" : rawLang === "en-US" || rawLang === "en" ? "en-US" : "en-US";
    const outbound = new FormData();
    outbound.append("audio", new Blob([await audio.arrayBuffer()], { type: audio.type || "audio/webm" }), "audio.webm");
    outbound.append("language", language);
    const prompt = form.get("prompt");
    if (typeof prompt === "string" && prompt) outbound.append("prompt", prompt);
    // task-113：provider 允许列表加入 deepseek（非法值 400）；不传则保持 voice 默认 auto
    const provider = (form.get("provider") as string | null) ?? new URL(req.url).searchParams.get("provider");
    const ALLOWED = ["azure", "zhipu", "deepseek"];
    if (provider && !ALLOWED.includes(provider)) {
      throw new HttpError(400, "bad_request", `provider 必须是 ${ALLOWED.join(" / ")} 之一`);
    }
    if (provider) outbound.append("provider", provider);

    const result = await callAsr(
      outbound,
      user ? { familyId: user.familyId, userId: user.id, scene: "asr", meta: provider ? { requested_provider: provider } : undefined } : undefined,
    );
    return NextResponse.json({
      text: result.text,
      provider: result.provider,
      // task-113：透传回退与警告（voice 返回时）
      fallback_from: result.fallback_from ?? null,
      warnings: result.warnings ?? [],
      duration_ms: result.duration_ms,
      language,
      provider_requested: provider ?? null,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    if (err instanceof VoiceError) {
      // task-113：voice 返回的可读错误透传（如 provider_unavailable / rate_limited）
      const unavailable = err.code === "voice_unreachable" || err.status === 503 || err.status === 404;
      return NextResponse.json(
        {
          error: {
            code: unavailable ? "provider_unavailable" : err.code,
            message: unavailable ? "语音识别暂时不可用（provider 未配置或不可用），可以先打字" : `语音识别失败：${err.message}`,
            detail: {},
          },
        },
        { status: err.status === 429 ? 429 : unavailable ? 503 : 502 },
      );
    }
    console.error("[asr]", err);
    return NextResponse.json(
      { error: { code: "provider_error", message: "语音识别暂时不可用，请直接打字", detail: {} } },
      { status: 502 },
    );
  }
}
