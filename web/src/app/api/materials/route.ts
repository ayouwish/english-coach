import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import {
  createMaterial,
  listMaterials,
  MaterialValidationError,
  MAX_IMAGE_BYTES,
  MAX_TEXT,
  MAX_TITLE,
} from "@/lib/materials";

export const dynamic = "force-dynamic";

/** GET /api/materials —— 家庭共享：所有登录用户都能看到全部书页。 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  await requireUser();
  const sp = req.nextUrl.searchParams;
  const items = await listMaterials({
    limit: Number(sp.get("limit") ?? 50),
    offset: Number(sp.get("offset") ?? 0),
    kind: sp.get("kind"),
  });
  return jsonOk({ items, count: items.length });
});

/** POST /api/materials —— 保存书页（文本必需，图片可选：voice 没返回就只存文字）。 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const body = (await req.json().catch(() => null)) as
    | { title?: unknown; text?: unknown; image_b64?: unknown; source?: unknown; kind?: unknown; source_zh?: unknown; level?: unknown }
    | null;
  if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");
  try {
    const material = await createMaterial(user, {
      title: body.title,
      text: body.text,
      imageB64: body.image_b64,
      source: body.source,
      kind: (body as { kind?: unknown }).kind,
      sourceZh: (body as { source_zh?: unknown }).source_zh,
      level: (body as { level?: unknown }).level,
    });
    return jsonOk(
      {
        ...material,
        limits: { title: MAX_TITLE, text: MAX_TEXT, image_bytes: MAX_IMAGE_BYTES },
      },
      201,
    );
  } catch (err) {
    if (err instanceof MaterialValidationError) throw new HttpError(400, "bad_request", err.message);
    throw err;
  }
});
