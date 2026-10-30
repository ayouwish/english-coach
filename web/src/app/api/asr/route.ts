import { NextRequest, NextResponse } from "next/server";
import { HttpError, requireUser } from "@/lib/auth";
import { callAsr } from "@/lib/voice";

export const dynamic = "force-dynamic";
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

/** POST /api/asr — 语音转文字（对话的语音输入，契约 §2）。 */
export async function POST(req: NextRequest) {
  try {
    await requireUser();
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

    const result = await callAsr(outbound);
    return NextResponse.json({
      text: result.text,
      provider: result.provider,
      duration_ms: result.duration_ms,
      language,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[asr]", err);
    return NextResponse.json(
      { error: { code: "provider_error", message: "语音识别暂时不可用，请直接打字", detail: {} } },
      { status: 502 },
    );
  }
}
