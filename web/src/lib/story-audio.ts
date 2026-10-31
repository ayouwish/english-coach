/**
 * 故事整段朗读回放（task-74 ①）：把该故事**已完成的朗读录音**按时间顺序拼成一段 WAV。
 *
 * 与对话回放（`lib/chat-audio.ts`）同一套思路：
 * - 异步预生成 + sidecar 状态（`DATA_DIR/story-audio/<materialId>.json`），
 *   `{status: building|ready|failed, signature, attempt_count, error, duration_ms}`
 * - 进程内 inflight/pending 去重；路由只读状态，GET audio 触发后台构建
 * - **只有 1 条录音时不拼接**：直接复用那条录音（`single: true`），避免无意义构建
 * - 失败可读降级（voice concat 未就绪 → "音频拼接服务暂未就绪"），不卡死
 */
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { DATA_DIR, getDb } from "@/db";
import { attempts } from "@/db/schema";
import { resolveAudioPath } from "@/lib/audio";
import { wavDurationMs } from "@/lib/chat-audio";
import { callAudioConcat, VoiceError, type ConcatPart } from "@/lib/voice";

export const STORY_AUDIO_DIR = path.join(DATA_DIR, "story-audio");
const GAP_MS = 250;

const STALE_ERROR = "上次生成被中断了，点「重新生成」再试一次";
const NO_AUDIO_ERROR = "这个故事还没有可回放的朗读录音，先读一遍再来听吧";

export type StoryAudioStatus = "building" | "ready" | "failed";

export interface StoryAudioMeta {
  status: StoryAudioStatus;
  /** attempts 签名（id 列表），用于判断缓存是否过期 */
  signature: string;
  attempt_count: number;
  single?: boolean;
  error?: string;
  duration_ms?: number;
  started_at?: string;
  ready_at?: string | null;
}

export interface StoryAudioState {
  status: StoryAudioStatus;
  attempt_count: number;
  single?: boolean;
  duration_ms?: number;
  error?: string;
}

export class StoryAudioBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryAudioBuildError";
  }
}

function safeId(materialId: string): string {
  return materialId.replace(/[^A-Za-z0-9_-]/g, "");
}

export function storyAudioPaths(materialId: string): { audioFile: string; metaFile: string } {
  const safe = safeId(materialId);
  return {
    audioFile: path.join(STORY_AUDIO_DIR, `${safe}.wav`),
    metaFile: path.join(STORY_AUDIO_DIR, `${safe}.json`),
  };
}

export function readStoryAudioMeta(materialId: string): StoryAudioMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(storyAudioPaths(materialId).metaFile, "utf8")) as StoryAudioMeta;
    return parsed && typeof parsed === "object" && parsed.status ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoryAudioMeta(materialId: string, meta: StoryAudioMeta): void {
  fs.mkdirSync(STORY_AUDIO_DIR, { recursive: true });
  const { metaFile } = storyAudioPaths(materialId);
  const tmp = `${metaFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, metaFile);
}

interface StoryAttempt {
  id: string;
  audioPath: string | null;
  createdAt: string;
}

/** 该用户在这个故事上的、已完成且有录音的朗读（时间升序） */
export async function listStoryAudioAttempts(materialId: string, userId: string): Promise<StoryAttempt[]> {
  return getDb()
    .select({ id: attempts.id, audioPath: attempts.audioPath, createdAt: attempts.createdAt })
    .from(attempts)
    .where(and(eq(attempts.materialId, materialId), eq(attempts.userId, userId), eq(attempts.status, "done")))
    .orderBy(asc(attempts.createdAt));
}

function signatureOf(list: StoryAttempt[]): string {
  return list
    .filter((a) => a.audioPath)
    .map((a) => a.id)
    .join(",");
}

const inflight = new Map<string, Promise<StoryAudioMeta>>();
const pending = new Set<string>();

export function isStoryAudioBuilding(materialId: string): boolean {
  const key = safeId(materialId);
  return inflight.has(key) || pending.has(key);
}

function mimeFor(rel: string | null): string {
  const ext = (rel ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "wav") return "audio/wav";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "m4a") return "audio/mp4";
  return "audio/webm";
}

function readableError(err: unknown): string {
  if (err instanceof StoryAudioBuildError) return err.message;
  if (err instanceof VoiceError) {
    if (err.code === "voice_unreachable" || err.status === 404 || err.status === 503 || err.status === 504) {
      return "音频拼接服务暂未就绪（voice /v1/audio/concat 不可用）。可以先逐句听。";
    }
    return `拼装朗读音频失败：${err.message}`;
  }
  return "拼装朗读音频出错了，请稍后再试";
}

/** 构建（幂等 + 并发去重）；返回最终 meta（failed 时含可读 error） */
export function buildStoryAudio(materialId: string, userId: string, opts: { force?: boolean } = {}): Promise<StoryAudioMeta> {
  const key = safeId(materialId);
  const running = inflight.get(key);
  if (running) return running;
  const promise = doBuild(materialId, userId, opts.force === true);
  inflight.set(key, promise);
  void promise
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    })
    .catch(() => {
      /* 失败信息已写进 sidecar */
    });
  return promise;
}

export function triggerStoryAudioBuild(materialId: string, userId: string, opts: { force?: boolean } = {}): void {
  const key = safeId(materialId);
  pending.add(key);
  void buildStoryAudio(materialId, userId, opts)
    .catch((err) => console.warn(`[story-audio] 后台构建失败（${key}）：${err instanceof Error ? err.message : err}`))
    .finally(() => pending.delete(key));
}

async function doBuild(materialId: string, userId: string, force: boolean): Promise<StoryAudioMeta> {
  const list = await listStoryAudioAttempts(materialId, userId);
  const withAudio = list.filter((a): a is StoryAttempt & { audioPath: string } => Boolean(a.audioPath));
  const signature = signatureOf(list);
  const { audioFile } = storyAudioPaths(materialId);

  if (!force) {
    const cached = readStoryAudioMeta(materialId);
    if (cached?.status === "ready" && cached.signature === signature && fs.existsSync(audioFile)) return cached;
  }

  const startedAt = new Date().toISOString();
  if (withAudio.length === 0) {
    const meta: StoryAudioMeta = { status: "failed", signature, attempt_count: 0, error: NO_AUDIO_ERROR, started_at: startedAt, ready_at: null };
    writeStoryAudioMeta(materialId, meta);
    return meta;
  }

  writeStoryAudioMeta(materialId, { status: "building", signature, attempt_count: withAudio.length, started_at: startedAt, ready_at: null });

  try {
    let bytes: Uint8Array;
    let durationMs: number | null = null;
    if (withAudio.length === 1) {
      // 只有 1 条录音：不拼接，直接复用
      const abs = resolveAudioPath(withAudio[0].audioPath);
      if (!abs || !fs.existsSync(abs)) throw new StoryAudioBuildError("录音文件不见了，重新读一遍试试");
      bytes = new Uint8Array(fs.readFileSync(abs));
      durationMs = wavDurationMs(Buffer.from(bytes));
      fs.mkdirSync(STORY_AUDIO_DIR, { recursive: true });
      fs.writeFileSync(audioFile, bytes);
    } else {
      const parts: ConcatPart[] = [];
      for (const a of withAudio) {
        const abs = resolveAudioPath(a.audioPath);
        if (!abs || !fs.existsSync(abs)) continue;
        const mime = mimeFor(a.audioPath);
        parts.push({ data: new Uint8Array(fs.readFileSync(abs)), mime, filename: `a.${mime.split("/")[1]}` });
      }
      if (parts.length === 0) throw new StoryAudioBuildError("录音文件都不见了，重新读一遍试试");
      const merged = await callAudioConcat(parts, GAP_MS);
      fs.mkdirSync(STORY_AUDIO_DIR, { recursive: true });
      const tmp = `${audioFile}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, merged.bytes);
      fs.renameSync(tmp, audioFile);
      durationMs = wavDurationMs(Buffer.from(merged.bytes));
    }

    const readyAt = new Date().toISOString();
    const meta: StoryAudioMeta = {
      status: "ready",
      signature,
      attempt_count: withAudio.length,
      single: withAudio.length === 1,
      ...(durationMs ? { duration_ms: durationMs } : {}),
      started_at: startedAt,
      ready_at: readyAt,
    };
    writeStoryAudioMeta(materialId, meta);
    return meta;
  } catch (err) {
    const error = readableError(err);
    console.warn(`[story-audio] 构建失败（${safeId(materialId)}）：${error}`);
    const meta: StoryAudioMeta = { status: "failed", signature, attempt_count: withAudio.length, error, started_at: startedAt, ready_at: null };
    writeStoryAudioMeta(materialId, meta);
    return meta;
  }
}

/** 只读状态（绝不触发构建）；签名不一致 → building（需要重建） */
export async function getStoryAudioState(materialId: string, userId: string): Promise<StoryAudioState> {
  const list = await listStoryAudioAttempts(materialId, userId);
  const withAudio = list.filter((a): a is StoryAttempt & { audioPath: string } => Boolean(a.audioPath));
  const signature = signatureOf(list);
  const meta = readStoryAudioMeta(materialId);
  const building = isStoryAudioBuilding(materialId);

  if (withAudio.length === 0) {
    return { status: "failed", attempt_count: 0, error: NO_AUDIO_ERROR };
  }
  if (building) return { status: "building", attempt_count: withAudio.length };
  if (!meta) return { status: "building", attempt_count: withAudio.length };
  if (meta.status === "building") return { status: "failed", attempt_count: meta.attempt_count ?? withAudio.length, error: STALE_ERROR };
  if (meta.status === "failed") return { status: "failed", attempt_count: meta.attempt_count ?? withAudio.length, error: meta.error ?? "拼装朗读音频出错了" };
  if (meta.signature !== signature || !fs.existsSync(storyAudioPaths(materialId).audioFile)) {
    return { status: "building", attempt_count: withAudio.length };
  }
  return {
    status: "ready",
    attempt_count: meta.attempt_count ?? withAudio.length,
    single: meta.single === true,
    ...(meta.duration_ms ? { duration_ms: meta.duration_ms } : {}),
  };
}

/** 缓存是否对当前 attempts 有效（ready + 签名一致 + 文件在） */
export async function isStoryAudioReady(materialId: string, userId: string): Promise<boolean> {
  const state = await getStoryAudioState(materialId, userId);
  return state.status === "ready";
}
