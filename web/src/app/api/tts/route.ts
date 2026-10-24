import { NextRequest, NextResponse } from "next/server";
import { HttpError, requireUser } from "@/lib/auth";
import { getPrefs } from "@/lib/prefs";
import { callTts } from "@/lib/voice";

export const dynamic = "force-dynamic";

/** POST /api/tts — 示范音/朗读音频（转发 voice /v1/tts，浏览器只与 web 通信）。 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as
      | { text?: string; rate?: "slow" | "normal"; voice?: string; format?: "wav" | "mp3" }
      | null;
    const text = (body?.text ?? "").trim();
    if (!text) throw new HttpError(400, "bad_request", "缺少 text");
    if (text.length > 2000) throw new HttpError(413, "payload_too_large", "文本超过 2000 字符上限");

    const prefs = await getPrefs(user.id);
    const rate = body?.rate ?? (user.isChild ? "slow" : prefs.ttsRate);

    // 默认 wav：**与参考音分析共用同一份预热缓存**（练习页的「听示范」因此零等待）。
    // 但对话回复是每次全新文本（必 miss），此时 mp3 体积小、传输快（实测 693ms vs wav 1407ms），
    // 所以聊天页可以显式传 format: "mp3"。
    const format = body?.format === "mp3" ? "mp3" : "wav";
    const audio = await callTts({ text, rate, voice: body?.voice ?? prefs.ttsVoice ?? null, format });
    return new NextResponse(audio.body, {
      status: 200,
      headers: {
        "content-type": audio.contentType,
        "cache-control": "private, max-age=600",
        ...(audio.durationMs ? { "x-audio-duration-ms": audio.durationMs } : {}),
        ...(audio.provider ? { "x-tts-provider": audio.provider } : {}),
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message, detail: {} } },
        { status: err.status },
      );
    }
    console.error("[tts]", err);
    return NextResponse.json(
      { error: { code: "provider_error", message: "示范音暂时不可用，稍后再试", detail: {} } },
      { status: 502 },
    );
  }
}
