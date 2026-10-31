import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { DATA_DIR, ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { resolveAudioPath } from "@/lib/audio";
import { callAudioConcat, callTts, VoiceError, type ConcatPart } from "@/lib/voice";

export const dynamic = "force-dynamic";

const CHAT_AUDIO_DIR = path.join(DATA_DIR, "chat-audio");
const GAP_MS = 250;

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message, detail: {} } }, { status });
}

function mimeForAudioPath(rel: string | null): string {
  const ext = (rel ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "wav") return "audio/wav";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "m4a") return "audio/mp4";
  return "audio/webm";
}

/**
 * GET /api/chat/sessions/:id/audio —— 整段对话音频（task-68）。
 *
 * 按时间顺序拼接：用户录音（audio_path 读文件）+ 助手回复（TTS wav）→ voice `/v1/audio/concat`（gap_ms=250）。
 * 结果缓存 `DATA_DIR/chat-audio/<sessionId>.wav`（+ sidecar json 记 turn_count）；
 * 会话轮数没变且非 force → 直接返回缓存（TTS 本身也有缓存，成本≈0）。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    const force = req.nextUrl.searchParams.get("force") === "1";

    const db = getDb();
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    if (!session || session.userId !== user.id) throw new HttpError(404, "not_found", "会话不存在");

    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatSessionId, id))
      .orderBy(asc(chatMessages.createdAt));

    fs.mkdirSync(CHAT_AUDIO_DIR, { recursive: true });
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, "");
    const audioFile = path.join(CHAT_AUDIO_DIR, `${safeId}.wav`);
    const metaFile = path.join(CHAT_AUDIO_DIR, `${safeId}.json`);

    // 缓存命中：轮数未变 + 文件在
    if (!force && fs.existsSync(audioFile) && fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as { turn_count?: number };
        if (Number(meta.turn_count) === session.turnCount) {
          const data = fs.readFileSync(audioFile);
          return new NextResponse(new Uint8Array(data), {
            status: 200,
            headers: {
              "content-type": "audio/wav",
              "content-length": String(data.byteLength),
              "accept-ranges": "none",
              "cache-control": "private, max-age=0, must-revalidate",
              "x-chat-audio-cache": "hit",
            },
          });
        }
      } catch {
        /* 元数据坏了 → 重新生成 */
      }
    }

    // 收集 parts（按时间顺序：用户录音 + 助手 TTS）
    const parts: ConcatPart[] = [];
    const missing: string[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        const abs = m.audioPath ? resolveAudioPath(m.audioPath) : null;
        if (abs && fs.existsSync(abs)) {
          parts.push({ data: new Uint8Array(fs.readFileSync(abs)), mime: mimeForAudioPath(m.audioPath), filename: `u.${mimeForAudioPath(m.audioPath).split("/")[1]}` });
        } else {
          missing.push(m.id);
        }
      } else if (m.role === "assistant" && m.text.trim()) {
        const tts = await callTts({ text: m.text, rate: "normal", format: "wav" });
        parts.push({ data: new Uint8Array(tts.body), mime: "audio/wav", filename: "a.wav" });
      }
    }
    if (parts.length === 0) {
      throw new HttpError(
        404,
        "not_found",
        "这段对话还没有可回放的音频（需要至少有一句语音输入，或助手回复）",
      );
    }

    const merged = await callAudioConcat(parts, GAP_MS);
    // 原子写缓存
    const tmp = `${audioFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, merged.bytes);
    fs.renameSync(tmp, audioFile);
    fs.writeFileSync(
      metaFile,
      JSON.stringify({ turn_count: session.turnCount, parts: parts.length, missing, built_at: new Date().toISOString() }),
    );

    return new NextResponse(new Uint8Array(merged.bytes), {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "content-length": String(merged.bytes.byteLength),
        "accept-ranges": "none",
        "cache-control": "private, max-age=0, must-revalidate",
        "x-chat-audio-cache": "miss",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    if (err instanceof VoiceError) {
      const unavailable = err.code === "voice_unreachable" || err.status === 404 || err.status === 503 || err.status === 504;
      if (unavailable) {
        console.warn(`[chat-audio] 拼接服务不可用（${err.code}/${err.status ?? "-"}）：${err.message}`);
        return errorJson(503, "concat_unavailable", "音频拼接服务暂未就绪（voice /v1/audio/concat 未上线）。可以先看文字记录。");
      }
      return errorJson(502, "provider_error", `拼装对话音频失败：${err.message}`);
    }
    console.error("[chat-audio]", err);
    return errorJson(500, "internal_error", "拼装对话音频出错了，请稍后再试");
  }
}
