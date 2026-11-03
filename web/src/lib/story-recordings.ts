/**
 * 故事录音（task-77）：**先落盘再转录**——录音永远不因转录失败而丢。
 *
 * - 音频存 `DATA_DIR/story-audio/<userId>/<id>.<ext>`（与整段朗读缓存同目录、不同子目录）
 * - 转录走 `/v1/asr`（中文；voice 侧支持 `provider` 选择 zhipu/azure）
 * - 失败：行保留 status=failed + 可读 error，音频文件保留 → 可重试/换 provider
 */
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { DATA_DIR, getDb } from "@/db";
import { storyRecordings } from "@/db/schema";
import { HttpError } from "@/lib/auth";
import { callAsr, VoiceError } from "@/lib/voice";

export const RECORDINGS_DIR = path.join(DATA_DIR, "story-audio");
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
export const MAX_LIST = 20;

export interface RecordingView {
  id: string;
  status: "transcribed" | "failed" | "pending";
  transcript_zh: string | null;
  provider: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  mime: string | null;
  error: string | null;
  audio_url: string;
  created_at: string;
  material_id: string | null;
}

/** 常见音频容器 magic bytes（防把任意文件当录音存下来） */
export function detectAudioMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 12) {
    const riff = String.fromCharCode(...b.slice(0, 4));
    const wave = String.fromCharCode(...b.slice(8, 12));
    if (riff === "RIFF" && wave === "WAVE") return "audio/wav";
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (b.length >= 4) {
    const sig = String.fromCharCode(...b.slice(0, 4));
    if (sig === "OggS") return "audio/ogg";
    if (sig === "fLaC") return "audio/flac";
  }
  if (b.length >= 8 && String.fromCharCode(...b.slice(4, 8)) === "ftyp") return "audio/mp4";
  if (b.length >= 3 && String.fromCharCode(...b.slice(0, 3)) === "ID3") return "audio/mpeg";
  return null;
}

/** 录音文件路径解析（只允许 story-audio 目录内，防目录穿越） */
export function resolveRecordingPath(relativePath: string): string | null {
  const abs = path.resolve(DATA_DIR, relativePath);
  const root = path.resolve(RECORDINGS_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function extFor(mime: string): string {
  return mime === "audio/wav" ? "wav" : mime === "audio/ogg" ? "ogg" : mime === "audio/mp4" ? "m4a" : mime === "audio/mpeg" ? "mp3" : mime === "audio/flac" ? "flac" : "webm";
}

export function toView(row: typeof storyRecordings.$inferSelect): RecordingView {
  return {
    id: row.id,
    status: (row.status as RecordingView["status"]) ?? "failed",
    transcript_zh: row.transcriptZh,
    provider: row.provider,
    duration_ms: row.durationMs,
    size_bytes: row.sizeBytes,
    mime: row.mime,
    error: row.error,
    audio_url: `/api/story/recordings/${row.id}/audio`,
    created_at: row.createdAt,
    material_id: row.materialId,
  };
}

function readableAsrError(err: unknown): string {
  if (err instanceof VoiceError) {
    if (err.code === "voice_unreachable" || err.status === 404 || err.status === 503 || err.status === 504) {
      return "语音识别服务暂时不可用；录音已保存，可以稍后重试转录。";
    }
    if (err.code === "provider_timeout") {
      return "这段录音转录超时了（可能太长）；录音已保存，可以重试或换一个识别服务。";
    }
    return `转录失败（${err.code}${err.status ? `/${err.status}` : ""}）：${err.message.slice(0, 100)}；录音已保存，可以重试。`;
  }
  return "转录失败；录音已保存，可以重试。";
}

/** 落盘并建行（不转录） */
export async function saveRecording(userId: string, bytes: Uint8Array, declaredMime: string, opts: { materialId?: string | null } = {}) {
  if (bytes.byteLength === 0) throw new HttpError(400, "bad_request", "录音是空的，再说一遍试试");
  if (bytes.byteLength > MAX_RECORDING_BYTES) throw new HttpError(413, "payload_too_large", "录音太大（上限 25MB），说短一点试试");
  const detected = detectAudioMime(bytes);
  if (!detected) throw new HttpError(400, "bad_request", "这不是有效的音频文件（支持 wav/webm/ogg/m4a/mp3/flac）");
  const mime = detected || declaredMime || "audio/webm";
  const safeUser = userId.replace(/[^A-Za-z0-9_-]/g, "");
  const id = `rec_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const dir = path.join(RECORDINGS_DIR, safeUser);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${id}.${extFor(mime)}`;
  const abs = path.join(dir, fileName);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, abs);
  const relativePath = path.posix.join("story-audio", safeUser, fileName);
  const now = new Date().toISOString();
  await getDb().insert(storyRecordings).values({
    id,
    userId,
    materialId: opts.materialId ?? null,
    audioPath: relativePath,
    mime,
    durationMs: null,
    sizeBytes: bytes.byteLength,
    transcriptZh: null,
    provider: null,
    status: "pending",
    error: null,
    createdAt: now,
  });
  return { id, relativePath, mime, createdAt: now };
}

/** 转录（首次或重试）；失败不抛错，返回 status=failed 的行 */
export async function transcribeRecording(
  userId: string,
  recordingId: string,
  opts: { provider?: string | null } = {},
): Promise<typeof storyRecordings.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(storyRecordings)
    .where(and(eq(storyRecordings.id, recordingId), eq(storyRecordings.userId, userId)))
    .limit(1);
  if (!row) throw new HttpError(404, "not_found", "录音不存在");
  const abs = resolveRecordingPath(row.audioPath);
  if (!abs || !fs.existsSync(abs)) throw new HttpError(404, "not_found", "录音文件不存在（可能已被清理）");

  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(fs.readFileSync(abs))], { type: row.mime ?? "audio/webm" }), `recording.${extFor(row.mime ?? "audio/webm")}`);
  form.append("language", "zh-CN");
  if (opts.provider) form.append("provider", opts.provider);

  try {
    const result = await callAsr(form);
    const [updated] = await db
      .update(storyRecordings)
      .set({
        transcriptZh: result.text,
        provider: result.provider ?? opts.provider ?? null,
        durationMs: typeof result.duration_ms === "number" ? result.duration_ms : row.durationMs,
        status: "transcribed",
        error: null,
      })
      .where(eq(storyRecordings.id, row.id))
      .returning();
    return updated;
  } catch (err) {
    const message = readableAsrError(err);
    console.warn(`[story-recording] 转录失败（${row.id}）：${message}`);
    const [updated] = await db
      .update(storyRecordings)
      .set({ status: "failed", error: message, provider: opts.provider ?? row.provider ?? null })
      .where(eq(storyRecordings.id, row.id))
      .returning();
    return updated;
  }
}

export async function listRecordings(userId: string, limit = MAX_LIST): Promise<RecordingView[]> {
  const rows = await getDb()
    .select()
    .from(storyRecordings)
    .where(eq(storyRecordings.userId, userId))
    .orderBy(desc(storyRecordings.createdAt))
    .limit(Math.min(Math.max(limit, 1), MAX_LIST));
  return rows.map((row) => toView(row));
}

export async function getRecording(userId: string, recordingId: string): Promise<typeof storyRecordings.$inferSelect | null> {
  const [row] = await getDb()
    .select()
    .from(storyRecordings)
    .where(and(eq(storyRecordings.id, recordingId), eq(storyRecordings.userId, userId)))
    .limit(1);
  return row ?? null;
}
