import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AUDIO_DIR, DATA_DIR } from "@/db";

const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
};

export function extFromMime(mime: string | null | undefined, fallback = "webm"): string {
  if (!mime) return fallback;
  const base = mime.split(";")[0].trim().toLowerCase();
  return EXT_BY_MIME[base] ?? fallback;
}

export function contentTypeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "webm":
      return "audio/webm";
    case "ogg":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

/**
 * 落盘到 data/audio/<user_id>/<yyyy-mm>/<id>.<ext>（契约 §10）。
 * 返回值是相对 DATA_DIR 的路径，存进 attempts.audio_path —— 数据库里不存二进制。
 */
export function saveAudio(
  userId: string,
  data: Buffer | Uint8Array,
  ext: string,
  id = randomUUID().replace(/-/g, "").slice(0, 16),
): { relativePath: string; absolutePath: string; bytes: number; id: string } {
  const now = new Date();
  const yyyyMm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(AUDIO_DIR, safeUser, yyyyMm);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${id}.${ext}`;
  const absolutePath = path.join(dir, fileName);
  fs.writeFileSync(absolutePath, data);
  return {
    relativePath: path.posix.join("audio", safeUser, yyyyMm, fileName),
    absolutePath,
    bytes: data.byteLength,
    id,
  };
}

/** 只允许解析到 AUDIO_DIR 内部，防目录穿越。 */
export function resolveAudioPath(relativePath: string): string | null {
  const abs = path.resolve(DATA_DIR, relativePath);
  const root = path.resolve(AUDIO_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

export function statAudio(relativePath: string): { size: number; mtimeMs: number } | null {
  const abs = resolveAudioPath(relativePath);
  if (!abs) return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
