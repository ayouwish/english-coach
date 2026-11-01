import { NextResponse } from "next/server";
import { VOICE_OPTIONS } from "@/lib/voices";

export const dynamic = "force-dynamic";

/** GET /api/tts/voices —— 可选音色列表（task-76 ③；纯静态，不需要登录也能给设置页用）。 */
export async function GET() {
  return NextResponse.json({ count: VOICE_OPTIONS.length, voices: VOICE_OPTIONS });
}
