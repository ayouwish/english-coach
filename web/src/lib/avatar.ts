/**
 * 虚拟形象（task-62）：拍照/上传照片 → voice `/v1/image/avatar` 生成风格化形象。
 *
 *  - 图片落 `DATA_DIR/avatars/<userId>.<ext>`，原子写；库里只存相对路径；
 *  - 5 种风格（水彩/卡通/像素/剪纸/黏土）；
 *  - `character_desc` 是"角色卡"，用户可以改（例如"我女儿戴眼镜"），**只允许改这个**；
 *  - `prompt_used` 存起来给前端展示（用户能据此反馈问题）。
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { DATA_DIR, getDb } from "@/db";
import { users } from "@/db/schema";
import { detectImageMime, type ImageMime } from "./illustration";

import { AVATAR_STYLES, AVATAR_STYLE_LABELS, MAX_DESC_LENGTH, MAX_PHOTO_BYTES, isAvatarStyle } from "./avatar-shared";

export { AVATAR_STYLES, AVATAR_STYLE_LABELS, MAX_DESC_LENGTH, MAX_PHOTO_BYTES, isAvatarStyle };
export type { AvatarStyle } from "./avatar-shared";

export const AVATAR_DIR = path.join(DATA_DIR, "avatars");

/** 只允许解析到 avatars/ 内部（防目录穿越） */
export function resolveAvatarPath(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null;
  const abs = path.resolve(DATA_DIR, relativePath);
  const root = path.resolve(AVATAR_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function extFor(mime: ImageMime): string {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

/** 原子写头像（临时文件 + rename），返回相对路径 */
export function writeAvatarImage(userId: string, bytes: Uint8Array): { ok: true; relativePath: string; mime: ImageMime } | { ok: false; reason: string } {
  const mime = detectImageMime(bytes);
  if (!mime) return { ok: false, reason: "返回的内容不是有效图片" };
  if (bytes.byteLength > MAX_PHOTO_BYTES) return { ok: false, reason: "图片太大（上限 10MB）" };
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const safeUser = userId.replace(/[^A-Za-z0-9_-]/g, "");
  // 换风格会换扩展名：先清掉旧的其它扩展名文件
  for (const ext of ["png", "jpg", "webp"]) {
    const p = path.join(AVATAR_DIR, `${safeUser}.${ext}`);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* 忽略 */
    }
  }
  const fileName = `${safeUser}.${extFor(mime)}`;
  const abs = path.join(AVATAR_DIR, fileName);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
    return { ok: false, reason: `写入头像失败：${(err as Error).message}` };
  }
  return { ok: true, relativePath: path.posix.join("avatars", fileName), mime };
}

export function deleteAvatarFile(relativePath: string | null | undefined): void {
  const abs = resolveAvatarPath(relativePath);
  if (!abs) return;
  try {
    fs.unlinkSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[avatar] 删除文件失败", abs, err);
  }
}

/** 角色卡清洗：去控制字符/HTML 尖括号，压空白，限长；空 → null */
export function sanitizeCharacterDesc(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESC_LENGTH);
  return cleaned || null;
}

/** 预置形象库（来自 src/data/avatar-presets.json 或 voice） */
export interface AvatarPresets {
  styles: { id: string; label_zh: string }[];
  characters: {
    id: string;
    label_zh: string;
    desc_en: string;
    images: Record<string, string>;
  }[];
  placeholder: boolean;
}

/** 明确不允许的风格（写实/照片：隐私策略，服务端硬拒绝） */
const FORBIDDEN_STYLES = new Set(["realistic", "photo", "photorealistic", "写实", "照片", "真人"]);

export function isForbiddenStyle(v: unknown): boolean {
  return typeof v === "string" && FORBIDDEN_STYLES.has(v.trim().toLowerCase());
}

/** 预置形象静态图路径前缀（存 DB 的相对路径） */
export const PRESET_PATH_PREFIX = "avatars/presets/";

/** 预置图在 web/public 下的相对路径 → 前端可用的静态 URL */
export function presetPublicUrl(imagePath: string | null | undefined): string | null {
  if (!imagePath || !imagePath.startsWith(PRESET_PATH_PREFIX)) return null;
  return `/${imagePath}`;
}

export interface AvatarState {
  image_path: string | null;
  preset_id: string | null;
  style: string | null;
  character_desc: string | null;
  prompt_used: string | null;
  updated_at: string | null;
}

export async function getAvatar(userId: string): Promise<AvatarState> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return {
    image_path: row?.avatarImagePath ?? null,
    preset_id: row?.avatarPresetId ?? null,
    style: row?.avatarStyle ?? null,
    character_desc: row?.avatarDesc ?? null,
    prompt_used: row?.avatarPrompt ?? null,
    updated_at: row?.avatarUpdatedAt ?? null,
  };
}

export async function updateAvatarColumns(
  userId: string,
  patch: {
    imagePath?: string | null;
    presetId?: string | null;
    style?: string | null;
    characterDesc?: string | null;
    prompt?: string | null;
  },
): Promise<AvatarState> {
  const db = getDb();
  const next: Record<string, unknown> = { avatarUpdatedAt: new Date().toISOString() };
  if (patch.imagePath !== undefined) next.avatarImagePath = patch.imagePath;
  if (patch.presetId !== undefined) next.avatarPresetId = patch.presetId;
  if (patch.style !== undefined) next.avatarStyle = patch.style;
  if (patch.characterDesc !== undefined) next.avatarDesc = patch.characterDesc;
  if (patch.prompt !== undefined) next.avatarPrompt = patch.prompt;
  await db.update(users).set(next).where(eq(users.id, userId));
  return getAvatar(userId);
}

/** 清空虚拟形象（删文件 + 置 NULL） */
export async function clearAvatar(userId: string): Promise<void> {
  const current = await getAvatar(userId);
  // 预置静态图是所有用户共享的公共资源，**不删**
  if (current.image_path && !current.image_path.startsWith(PRESET_PATH_PREFIX)) {
    deleteAvatarFile(current.image_path);
  }
  await getDb()
    .update(users)
    .set({
      avatarImagePath: null,
      avatarPresetId: null,
      avatarStyle: null,
      avatarDesc: null,
      avatarPrompt: null,
      avatarUpdatedAt: new Date().toISOString(),
    })
    .where(eq(users.id, userId));
}

/** 返回给前端的形状（不含任何 voice key） */
export function avatarView(state: AvatarState, userId: string): {
  avatar_url: string | null;
  preset_id: string | null;
  style: string | null;
  character_desc: string | null;
  prompt_used: string | null;
  updated_at: string | null;
} {
  const preset = presetPublicUrl(state.image_path);
  return {
    avatar_url: preset ?? (state.image_path ? `/api/avatar/image?user=${encodeURIComponent(userId)}&v=${encodeURIComponent(state.updated_at ?? "")}` : null),
    preset_id: state.preset_id,
    style: state.style,
    character_desc: state.character_desc,
    prompt_used: state.prompt_used,
    updated_at: state.updated_at,
  };
}

/** 提示词脱敏展示：去掉可能出现的文件路径/绝对路径（防止泄露服务器信息） */
export function redactPrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  return prompt.replace(/\/[\w./-]{8,}/g, "[path]").slice(0, 2000);
}
