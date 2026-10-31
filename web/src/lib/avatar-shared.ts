/**
 * 虚拟形象的**客户端安全**常量（无 DB/fs 依赖）—— 供 UI 与图片上传用。
 * 服务端实现见 `avatar.ts`。
 */
export const AVATAR_STYLES = ["watercolor", "cartoon", "pixel", "papercut", "clay"] as const;
export type AvatarStyle = (typeof AVATAR_STYLES)[number];

export const AVATAR_STYLE_LABELS: Record<AvatarStyle, string> = {
  watercolor: "水彩",
  cartoon: "卡通",
  pixel: "像素",
  papercut: "剪纸",
  clay: "黏土",
};

export const MAX_DESC_LENGTH = 500;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function isAvatarStyle(v: unknown): v is AvatarStyle {
  return typeof v === "string" && (AVATAR_STYLES as readonly string[]).includes(v);
}
