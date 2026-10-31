import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import {
  AVATAR_STYLE_LABELS,
  avatarView,
  clearAvatar,
  getAvatar,
  isAvatarStyle,
  sanitizeCharacterDesc,
  updateAvatarColumns,
  writeAvatarImage,
  MAX_PHOTO_BYTES,
} from "@/lib/avatar";
import { base64ToBytes, detectImageMime } from "@/lib/illustration";
import { jsonOk } from "@/lib/http";
import { callAvatar, VoiceError } from "@/lib/voice";

export const dynamic = "force-dynamic";
const UNAVAILABLE_HINT = "虚拟形象生成暂未就绪（voice 侧 /v1/image/avatar 未上线或未配置）。可以先继续用文字头像，稍后再试。";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message, detail: {} } }, { status });
}

/** GET /api/avatar —— 当前用户的虚拟形象（没有则返回 null 字段）。 */
export async function GET() {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const state = await getAvatar(user.id);
    return jsonOk({ ...avatarView(state, user.id), styles: AVATAR_STYLE_LABELS });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[avatar.get]", err);
    return errorJson(500, "internal_error", "读取虚拟形象失败");
  }
}

/** POST /api/avatar —— multipart `photo` + `style`，转发 voice 生成形象（儿童也能用）。 */
export async function POST(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const form = await req.formData();
    const photo = form.get("photo");
    if (!(photo instanceof File)) return errorJson(400, "bad_request", "请先拍照或选择一张照片（字段名 photo）");
    if (photo.size > MAX_PHOTO_BYTES) return errorJson(413, "payload_too_large", "照片太大（上限 10MB），换一张小一点的吧");
    const mime = photo.type || "";
    if (!mime.startsWith("image/")) return errorJson(400, "bad_request", `只支持图片（当前是 ${mime || "未知类型"}）`);
    const styleRaw = form.get("style");
    if (!isAvatarStyle(styleRaw)) return errorJson(400, "bad_request", "请选择一个风格（水彩/卡通/像素/剪纸/黏土）");
    const current = await getAvatar(user.id);
    const descInput = sanitizeCharacterDesc(form.get("character_desc")) ?? current.character_desc;

    const bytes = new Uint8Array(await photo.arrayBuffer());
    // 服务端二次校验：不能只信 Content-Type（文本改名 .jpg 也要拦）
    if (!detectImageMime(bytes)) {
      return errorJson(400, "bad_request", "这不是有效的图片文件（内容不是图片），请重新拍照或选择照片。");
    }
    const result = await callAvatar({
      data: bytes,
      mime,
      filename: photo.name || "photo.jpg",
      style: styleRaw,
      characterDesc: descInput,
    });
    const img = base64ToBytes(result.image_b64 ?? "");
    if (!img) return errorJson(502, "provider_error", "形象生成返回的数据无法解析，请稍后再试");
    const written = writeAvatarImage(user.id, img);
    if (!written.ok) return errorJson(502, "provider_error", written.reason);

    const desc = sanitizeCharacterDesc(result.character_desc) ?? descInput;
    const state = await updateAvatarColumns(user.id, {
      imagePath: written.relativePath,
      style: styleRaw,
      characterDesc: desc,
      prompt: typeof result.prompt_used === "string" ? result.prompt_used.slice(0, 2000) : current.prompt_used,
    });
    return jsonOk({ ok: true, ...avatarView(state, user.id) }, 200);
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    if (err instanceof VoiceError) {
      const unavailable =
        err.code === "voice_unreachable" || err.status === 404 || err.status === 405 || err.status === 502 || err.status === 503 || err.status === 504;
      if (unavailable) {
        console.warn(`[avatar] voice 侧不可用（${err.code}/${err.status ?? "-"}）：${err.message}`);
        return errorJson(503, "avatar_unavailable", UNAVAILABLE_HINT);
      }
      if (err.status === 400) {
        return errorJson(400, "content_unsafe", "这张照片可能不适合生成形象，换一张清楚的正脸照片试试");
      }
      return errorJson(502, "provider_error", `形象生成失败：${err.message}。可以点「换一张」重试。`);
    }
    console.error("[avatar.post]", err);
    return errorJson(500, "internal_error", "形象生成出错了，可以重试");
  }
}

/** PATCH /api/avatar —— **仅允许编辑 character_desc**（角色卡）。 */
export async function PATCH(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as { character_desc?: unknown } | null;
    if (!body || body.character_desc === undefined) return errorJson(400, "bad_request", "只支持修改 character_desc");
    if (typeof body.character_desc !== "string") return errorJson(400, "bad_request", "character_desc 必须是文本");
    if (body.character_desc.length > 2000) return errorJson(400, "bad_request", "形象描述太长了（最多 500 字）");
    const state = await getAvatar(user.id);
    if (!state.image_path) return errorJson(400, "bad_request", "还没有生成虚拟形象，先生成一张吧");
    const desc = sanitizeCharacterDesc(body.character_desc);
    const next = await updateAvatarColumns(user.id, { characterDesc: desc });
    return jsonOk({ ok: true, ...avatarView(next, user.id), message: "形象描述已更新，下次画故事会用它" });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[avatar.patch]", err);
    return errorJson(500, "internal_error", "保存形象描述失败");
  }
}

/** DELETE /api/avatar —— 清空（删文件 + 置 NULL）。 */
export async function DELETE() {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    await clearAvatar(user.id);
    return jsonOk({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[avatar.delete]", err);
    return errorJson(500, "internal_error", "清空虚拟形象失败");
  }
}
