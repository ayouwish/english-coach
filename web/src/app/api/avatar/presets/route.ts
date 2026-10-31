import { NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireUser } from "@/lib/auth";
import { loadAvatarPresets } from "@/lib/avatar-presets";

export const dynamic = "force-dynamic";

/**
 * GET /api/avatar/presets —— 预置形象库（task-64）：5 风格 × 8 角色。
 * 优先读仓库 `src/data/avatar-presets.json`，缺失时回退 voice；都不可用 → 503 可读提示。
 */
export async function GET() {
  try {
    await ensureBootstrap();
    await requireUser();
    const presets = await loadAvatarPresets();
    if (!presets) {
      return NextResponse.json(
        {
          error: {
            code: "presets_unavailable",
            message: "预置形象库暂时不可用（还没有生成预置图或 voice 未就绪），请稍后再试。",
            detail: {},
          },
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ...presets, count: presets.characters.length });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: { code: "internal_error", message: "读取预置形象库失败", detail: {} } },
      { status },
    );
  }
}
