/**
 * 故事插画存储（task-53）：voice 返回 PNG base64 → 校验 → 原子写入 `DATA_DIR/materials/<id>.png`
 * → 更新 `reading_materials.image_path`。
 *
 * 约定：
 *  - 文件名固定（`<id>.png`）→「换一张」直接**替换**旧图，不会让磁盘无限增长；
 *  - **先校验图片 magic bytes** 再写（防止把错误页/JSON 当图片存下来）；
 *  - 上限 5MB；写失败清理临时文件（不留半截文件）。
 */
import fs from "node:fs";
import path from "node:path";
import { MATERIALS_DIR, resolveMaterialPath } from "./materials";

export const MAX_ILLUSTRATION_BYTES = 5 * 1024 * 1024;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

/** 只看 magic bytes 判断真实图片类型（不信 voice 声明的 mime） */
export function detectImageMime(b: Uint8Array): ImageMime | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

export function base64ToBytes(b64: string): Uint8Array | null {
  const raw = b64.replace(/^data:[a-z/+.-]+;base64,/i, "").replace(/\s+/g, "");
  if (!raw) return null;
  try {
    return new Uint8Array(Buffer.from(raw, "base64"));
  } catch {
    return null;
  }
}

/** 原子写插画：临时文件 → rename；返回相对路径（供 image_path 用）；无效返回 {ok:false} */
export function writeIllustration(id: string, bytes: Uint8Array): { ok: true; relativePath: string; mime: ImageMime } | { ok: false; reason: string } {
  const mime = detectImageMime(bytes);
  if (!mime) return { ok: false, reason: "返回的内容不是有效图片" };
  if (bytes.byteLength > MAX_ILLUSTRATION_BYTES) return { ok: false, reason: "图片太大（上限 5MB）" };
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const fileName = `${id.replace(/[^A-Za-z0-9_-]/g, "")}.${ext}`;
  fs.mkdirSync(MATERIALS_DIR, { recursive: true });
  const abs = path.join(MATERIALS_DIR, fileName);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不影响主流程 */
    }
    return { ok: false, reason: `写入图片失败：${(err as Error).message}` };
  }
  return { ok: true, relativePath: path.posix.join("materials", fileName), mime };
}

/** 删掉插画文件（换图前/清理用）；ENOENT 忽略 */
export function deleteIllustration(relativePath: string | null): void {
  if (!relativePath) return;
  const abs = resolveMaterialPath(relativePath);
  if (!abs) return;
  try {
    fs.unlinkSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[illustration] 删除失败", abs, err);
  }
}

/** 按扩展名给 content-type（/api/materials/:id/image 用） */
export function mimeForPath(relativePath: string | null): string {
  const ext = (relativePath ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}
