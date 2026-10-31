import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import {
  AVATAR_STYLE_LABELS,
  avatarView,
  clearAvatar,
  getAvatar,
  isForbiddenStyle,
  sanitizeCharacterDesc,
  updateAvatarColumns,
} from "@/lib/avatar";
import { loadAvatarPresets, resolvePresetChoice } from "@/lib/avatar-presets";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";
const POLICY_HINT = "按隐私策略，照片生成形象已关闭；请从预置形象中选择。";

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

/**
 * POST /api/avatar —— **JSON 选择题**（task-64）：`{preset_id, style}`。
 * - 不生成图片、零等待：直接从预置库取静态图 + 角色描述写进 users；
 * - 非法 preset/style → 400；`realistic/photo/写实` → **400**（服务端硬拒绝写实）；
 * - 旧的 multipart 照片上传 → **403 `policy_disabled`**（隐私策略：照片不上云）。
 */
export async function POST(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();

    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      return errorJson(403, "policy_disabled", POLICY_HINT);
    }
    const body = (await req.json().catch(() => null)) as { preset_id?: unknown; style?: unknown } | null;
    if (!body) return errorJson(400, "bad_request", "请求体必须是 JSON：{preset_id, style}");
    if (isForbiddenStyle(body.style)) {
      return errorJson(400, "bad_request", "写实/照片风格已关闭（隐私策略），请选择卡通类风格");
    }
    const presets = await loadAvatarPresets();
    if (!presets) return errorJson(503, "presets_unavailable", "预置形象库暂时不可用，请稍后再试");
    const choice = resolvePresetChoice(presets, body.preset_id, body.style);
    if (!choice) return errorJson(400, "bad_request", "预置形象或风格不合法，请从列表里选");

    const state = await updateAvatarColumns(user.id, {
      imagePath: choice.imagePath,
      presetId: String(body.preset_id),
      style: choice.style,
      characterDesc: choice.descEn,
      prompt: null, // 预置形象没有生成提示词
    });
    return jsonOk({ ok: true, ...avatarView(state, user.id) });
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
    console.error("[avatar.post]", err);
    return errorJson(500, "internal_error", "保存虚拟形象失败，请重试");
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
