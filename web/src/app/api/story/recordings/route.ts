import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk } from "@/lib/http";
import { listRecordings, saveRecording, toView, transcribeRecording } from "@/lib/story-recordings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? 20);
    const materialId = req.nextUrl.searchParams.get("material_id");
    const items = (await listRecordings(user.id, Number.isFinite(limit) ? limit : 20)).filter(
      (x) => !materialId || x.material_id === materialId,
    );
    return jsonOk({ count: items.length, items });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[story.recordings.get]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "读取录音列表失败", detail: {} } }, { status: 500 });
  }
}

/** POST /api/story/recordings —— 先落盘再转录；转录失败也返回 201（录音不丢）。 */
export async function POST(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const form = await req.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) throw new HttpError(400, "bad_request", "缺少 audio 文件");
    const materialId = typeof form.get("material_id") === "string" ? (form.get("material_id") as string) : null;
    const bytes = new Uint8Array(await audio.arrayBuffer());

    const saved = await saveRecording(user.id, bytes, audio.type || "audio/webm", { materialId });
    const row = await transcribeRecording(user.id, saved.id);
    return NextResponse.json({ ok: true, ...toView(row), audio_saved: true }, { status: 201 });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[story.recordings.post]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "保存录音失败，请重试", detail: {} } }, { status: 500 });
  }
}
