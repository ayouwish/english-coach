import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireParent } from "@/lib/auth";
import { jsonOk } from "@/lib/http";
import { updateFamilyMember } from "@/lib/family";

export const dynamic = "force-dynamic";

/** PATCH /api/family/members/:id —— 改昵称/英语水平/每日时长/自由聊/头像（仅家长；不能改角色）。 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const caller = await requireParent();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");
    const member = await updateFamilyMember(caller.id, id, {
      displayName: body.display_name,
      cefrLevel: body.cefr_level,
      dailyLimitMinutes: body.daily_limit_minutes,
      allowFreeChat: body.allow_free_chat,
      avatar: body.avatar,
      role: body.role,
    });
    return jsonOk({ ok: true, member });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[family.patch]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "保存失败，请重试", detail: {} } }, { status: 500 });
  }
}
