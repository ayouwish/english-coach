import { NextRequest, NextResponse } from "next/server";
import { HttpError, requireUser } from "@/lib/auth";
import { getPrefs } from "@/lib/prefs";
import { callTts } from "@/lib/voice";

export const dynamic = "force-dynamic";

/**
 * 示范音 / 朗读音频（转发 voice `/v1/tts`，浏览器只与 web 通信）。
 *
 * ## 为什么同时提供 GET 和 POST
 * POST 用于代码里"先取 blob 再自行播放"（练习页、自动朗读）。
 * **GET 是为了让原生 `<audio controls src="/api/tts?...">` 能直接用** —— 这一点很关键：
 * 自定义 `new Audio()` 一旦播放被策略拦截或请求失败，用户就完全没声音、且不知道原因；
 * 而原生播放器的播放键是真实用户手势，**永远可用**，是可靠的兜底。
 * 代价是文本走 query（聊天回复很短，足够）。
 */
async function synthesize(params: {
  text: string | null | undefined;
  rate: string | null | undefined;
  voice: string | null | undefined;
  format: string | null | undefined;
}) {
  const user = await requireUser();

  const text = (params.text ?? "").trim();
  if (!text) throw new HttpError(400, "bad_request", "缺少 text");
  if (text.length > 2000) throw new HttpError(413, "payload_too_large", "文本超过 2000 字符上限");

  const prefs = await getPrefs(user.id);
  const rate = params.rate === "slow" || params.rate === "normal" ? params.rate : user.isChild ? "slow" : prefs.ttsRate;

  // 默认 wav：**与参考音分析共用同一份预热缓存**（练习页的「听示范」因此零等待）。
  // 但对话回复每次都是全新文本（必 miss），此时 mp3 体积约 1/3、传输更快，所以聊天用 mp3。
  const format = params.format === "mp3" ? "mp3" : "wav";

  const audio = await callTts({ text, rate, voice: params.voice ?? prefs.ttsVoice ?? null, format });
  return new NextResponse(audio.body, {
    status: 200,
    headers: {
      "content-type": audio.contentType,
      "cache-control": "private, max-age=600",
      ...(audio.durationMs ? { "x-audio-duration-ms": audio.durationMs } : {}),
      ...(audio.provider ? { "x-tts-provider": audio.provider } : {}),
    },
  });
}

function toErrorResponse(err: unknown) {
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

/** POST /api/tts —— 代码内取音频（blob）。 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { text?: string; rate?: "slow" | "normal"; voice?: string; format?: "wav" | "mp3" }
      | null;
    return await synthesize({
      text: body?.text,
      rate: body?.rate,
      voice: body?.voice,
      format: body?.format,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** GET /api/tts?text=…&rate=slow&format=mp3 —— 供原生 `<audio src>` 使用（可靠的播放兜底）。 */
export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams;
    return await synthesize({
      text: q.get("text"),
      rate: q.get("rate"),
      voice: q.get("voice"),
      format: q.get("format"),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
