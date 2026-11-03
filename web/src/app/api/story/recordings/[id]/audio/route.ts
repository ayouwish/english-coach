import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { getRecording, resolveRecordingPath } from "@/lib/story-recordings";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    // task-95 rev2：原始录音仅本人可回放
    const row = await getRecording(user.id, id);
    if (!row) throw new HttpError(404, "not_found", "录音不存在");
    const abs = resolveRecordingPath(row.audioPath);
    if (!abs || !fs.existsSync(abs)) throw new HttpError(404, "not_found", "录音文件不存在");
    const stat = fs.statSync(abs);
    const stream = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "content-type": row.mime ?? "audio/webm",
        "content-length": String(stat.size),
        "accept-ranges": "none",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[story.recordings.audio]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "读取录音失败", detail: {} } }, { status: 500 });
  }
}
