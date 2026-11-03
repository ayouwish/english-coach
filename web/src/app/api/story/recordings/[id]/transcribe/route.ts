import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { toView, transcribeRecording } from "@/lib/story-recordings";

export const dynamic = "force-dynamic";

/** POST /api/story/recordings/:id/transcribe —— 重新转录（可 {provider}；录音不用重传）。 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { provider?: string } | null;
    // task-95 rev2：只能重试转录**自己的**录音
    const row = await transcribeRecording(user.id, id, { provider: typeof body?.provider === "string" ? body.provider : null });
    return NextResponse.json({ ok: row.status === "transcribed", ...toView(row) }, { status: 200 });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[story.recordings.transcribe]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "重新转录失败，请稍后再试", detail: {} } }, { status: 500 });
  }
}
