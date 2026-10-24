import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { attempts, chatMessages, chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { contentTypeFromExt, resolveAudioPath, statAudio } from "@/lib/audio";

export const dynamic = "force-dynamic";

/**
 * GET /api/audio/:id —— 流式返回录音文件（文件存在 data/audio/，不进数据库）。
 * id 可以是 attempt id（跟读录音）或 chat message id（语音消息）。
 * 鉴权：本人或家长；路径解析被限制在 AUDIO_DIR 内，防目录穿越。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    const db = getDb();

    let relativePath: string | null = null;
    let ownerId: string | null = null;

    const [attempt] = await db.select().from(attempts).where(eq(attempts.id, id)).limit(1);
    if (attempt) {
      relativePath = attempt.audioPath;
      ownerId = attempt.userId;
    } else {
      const [msg] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
      if (msg) {
        relativePath = msg.audioPath;
        const [session] = await db
          .select()
          .from(chatSessions)
          .where(eq(chatSessions.id, msg.chatSessionId))
          .limit(1);
        ownerId = session?.userId ?? null;
      }
    }

    if (!relativePath || !ownerId) {
      throw new HttpError(404, "audio_not_found", "找不到音频记录");
    }
    if (ownerId !== user.id && user.role !== "parent") {
      throw new HttpError(403, "forbidden", "无权访问该音频");
    }

    const abs = resolveAudioPath(relativePath);
    const stat = abs ? statAudio(relativePath) : null;
    if (!abs || !stat) throw new HttpError(404, "audio_not_found", "音频文件不存在");

    const ext = relativePath.split(".").pop() ?? "webm";
    const nodeStream = fs.createReadStream(abs);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    return new NextResponse(webStream, {
      status: 200,
      headers: {
        "content-type": contentTypeFromExt(ext),
        "content-length": String(stat.size),
        "last-modified": new Date(stat.mtimeMs).toUTCString(),
        "cache-control": "private, max-age=3600",
        "accept-ranges": "none",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message, detail: {} } },
        { status: err.status },
      );
    }
    console.error("[audio]", err);
    return NextResponse.json(
      { error: { code: "internal_error", message: "音频读取失败", detail: {} } },
      { status: 500 },
    );
  }
}
