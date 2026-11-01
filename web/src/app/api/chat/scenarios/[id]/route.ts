import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { userScenarios } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import {
  getCustomScenario,
  mirrorCustomScenario,
  unmirrorCustomScenario,
  validateCustomScenario,
  type CustomScenarioInput,
} from "@/lib/custom-scenarios";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message, detail: {} } }, { status });
}

/** PATCH /api/chat/scenarios/:id —— 编辑自定义场景（仅 owner；他人 404）。 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    const existing = await getCustomScenario(user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "自定义场景不存在");
    const body = (await req.json().catch(() => null)) as CustomScenarioInput | null;
    if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");
    const input = validateCustomScenario(
      {
        title: body.title ?? existing.title,
        title_zh: body.title_zh ?? existing.titleZh,
        setting_zh: body.setting_zh ?? existing.settingZh,
        role_prompt: body.role_prompt ?? existing.rolePrompt,
        opening_line: body.opening_line ?? existing.openingLine,
        level: body.level ?? existing.level,
        audience: body.audience ?? existing.audience,
        variants: body.variants,
      },
      user.isChild,
    );
    await getDb()
      .update(userScenarios)
      .set({
        title: input.title,
        titleZh: input.titleZh,
        settingZh: input.settingZh,
        rolePrompt: input.rolePrompt,
        openingLine: input.openingLine,
        level: input.level,
        audience: input.audience,
        variantsJson: input.variantsJson ?? existing.variantsJson,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(userScenarios.id, id));
    await mirrorCustomScenario({ id, ownerId: user.id, ...input });
    return jsonOk({ ok: true, id, audience: input.audience });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[chat.scenarios.patch]", err);
    return errorJson(500, "internal_error", "保存自定义场景失败");
  }
}

/** DELETE /api/chat/scenarios/:id —— 删除自定义场景（仅 owner；他人 404）。 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    const existing = await getCustomScenario(user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "自定义场景不存在");
    await getDb().delete(userScenarios).where(eq(userScenarios.id, id));
    await unmirrorCustomScenario(id);
    return jsonOk({ ok: true, deleted: id });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[chat.scenarios.delete]", err);
    return errorJson(500, "internal_error", "删除自定义场景失败");
  }
}
