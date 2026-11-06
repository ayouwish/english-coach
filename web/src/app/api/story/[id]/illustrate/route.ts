import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { generateStoryIllustration } from "@/lib/illustrate-story";
import { illustrationAllowed } from "@/lib/illustration";
import { getMaterialForViewer } from "@/lib/materials";
import { VoiceError } from "@/lib/voice";

export const dynamic = "force-dynamic";

const UNAVAILABLE_HINT = "插画服务暂未就绪（voice 侧 /v1/image/illustrate 未配置或未启用）。可以先读故事，稍后再画。";
const UNSAFE_HINT = "这段话可能不适合画成图，换个说法或改一下故事再来试试。";

/**
 * POST /api/story/:id/illustrate —— 故事插画（task-53，代理 voice 智谱出图）。
 * 手动接口不受「自动生成」开关影响（task-76）；自动路径在 POST /api/materials 里按开关触发。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await ensureBootstrap();
    const user = await requireUser();
    // task-98：跨家庭先 404（不泄漏存在性）；再判断总开关
    const material = await getMaterialForViewer(user, id);
    if (!material) throw new HttpError(404, "not_found", "找不到这个故事");
    // task-102：插画总开关关闭 → 手动也不可用（统一门控）
    if (!illustrationAllowed(user)) {
      throw new HttpError(403, "policy_disabled", "插画功能已关闭，可在设置里打开");
    }
    const body = (await req.json().catch(() => ({}))) as { force?: unknown; style?: unknown };
    const force = req.nextUrl.searchParams.get("force") === "1" || body?.force === true;
    const style = typeof body?.style === "string" ? body.style : "watercolor";
    return NextResponse.json(await generateStoryIllustration(user, id, { force, style }));
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    if (err instanceof VoiceError) {
      if (err.status === 400) {
        return NextResponse.json({ error: { code: "content_unsafe", message: UNSAFE_HINT, detail: {} } }, { status: 400 });
      }
      const unavailable =
        err.code === "voice_unreachable" || err.status === 404 || err.status === 405 || err.status === 503 || err.status === 504;
      if (unavailable) {
        console.warn(`[illustrate] voice 侧不可用（${err.code}/${err.status ?? "-"}）：${err.message}`);
        return NextResponse.json(
          { error: { code: "illustration_unavailable", message: UNAVAILABLE_HINT, detail: { reason: err.code } } },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { error: { code: "provider_error", message: `画插画失败：${err.message}。可以点「再试一次」。`, detail: {} } },
        { status: 502 },
      );
    }
    console.error("[illustrate]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "画插画出错了，可以点「再试一次」。", detail: {} } }, { status: 500 });
  }
}
