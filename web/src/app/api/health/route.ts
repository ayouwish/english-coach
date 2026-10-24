import { NextRequest, NextResponse } from "next/server";
import { getCapabilities } from "@/lib/voice";
import { ensureBootstrap } from "@/db";

export const dynamic = "force-dynamic";

const WEB_VERSION = "0.1.0";

/**
 * web 探活（容器 healthcheck 用）。
 * 即使 voice 不可达也返回 200 —— web 自身健康，voice 状态在 body 里显式标出。
 */
export async function GET(req: NextRequest) {
  let dbOk = true;
  let dbError: string | null = null;
  try {
    await ensureBootstrap();
  } catch (err) {
    dbOk = false;
    dbError = err instanceof Error ? err.message : String(err);
  }

  // ?force=1 绕过 15s 缓存（自检/排障用）
  const force = req.nextUrl.searchParams.get("force") === "1";
  const { reachable, mode, capabilities } = await getCapabilities(force);

  return NextResponse.json(
    {
      status: dbOk ? "ok" : "degraded",
      service: "english-coach-web",
      version: WEB_VERSION,
      time: new Date().toISOString(),
      db: { ok: dbOk, error: dbError },
      voice: {
        reachable,
        mode,
        url: process.env.VOICE_SERVICE_URL ?? "http://127.0.0.1:8100",
        capabilities,
        hint: reachable ? null : "voice 未就绪：录音与文本仍会入库，评测稍后可重试",
      },
    },
    { status: 200 },
  );
}
