import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk } from "@/lib/http";
import { deleteMaterial, getMaterial, MaterialValidationError, updateMaterial } from "@/lib/materials";

export const dynamic = "force-dynamic";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message, detail: {} } }, { status });
}

/** GET /api/materials/:id —— 详情（含 text）。家庭共享，登录即可读。 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    await requireUser();
    const { id } = await ctx.params;
    const material = await getMaterial(id);
    if (!material) return errorJson(404, "not_found", "找不到这个书页");
    return jsonOk({
      id: material.id,
      title: material.title,
      text: material.text,
      sentence_count: material.sentenceCount,
      has_image: Boolean(material.imagePath),
      source: material.source,
      created_by: material.createdBy,
      created_at: material.createdAt,
      updated_at: material.updatedAt,
      image_url: material.imagePath ? `/api/materials/${material.id}/image` : null,
    });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[materials]", err);
    return errorJson(500, "internal_error", "读取书页失败");
  }
}

/** PATCH /api/materials/:id —— 重命名 / 编辑文本（改 text 时重算句数）。创建者或家长。 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { title?: unknown; text?: unknown } | null;
    if (!body) return errorJson(400, "bad_request", "请求体必须是 JSON");
    const result = await updateMaterial(user, id, body);
    if (result === null) return errorJson(404, "not_found", "找不到这个书页");
    if (result === "forbidden") return errorJson(403, "forbidden", "只有创建者或家长可以修改这个书页");
    return jsonOk({ ok: true, material: result });
  } catch (err) {
    if (err instanceof MaterialValidationError) return errorJson(400, "bad_request", err.message);
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[materials]", err);
    return errorJson(500, "internal_error", "保存书页失败");
  }
}

/** DELETE /api/materials/:id —— 创建者或家长可删；同步删图片文件。 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await deleteMaterial(user, id);
    if (result === "not_found") return errorJson(404, "not_found", "找不到这个书页");
    if (result === "forbidden") return errorJson(403, "forbidden", "只有创建者或家长可以删除这个书页");
    return jsonOk({ ok: true, id });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[materials]", err);
    return errorJson(500, "internal_error", "删除书页失败");
  }
}
