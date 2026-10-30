import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireParent } from "@/lib/auth";
import { jsonOk } from "@/lib/http";
import { resetMemberPassword } from "@/lib/family";

export const dynamic = "force-dynamic";

/** POST /api/family/members/:id/password —— 家长重置成员密码（旧密码立即失效）。 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    await requireParent();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { new_password?: unknown } | null;
    await resetMemberPassword(id, body?.new_password);
    return jsonOk({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[family.password]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "重置密码失败，请重试", detail: {} } }, { status: 500 });
  }
}
