/**
 * 对话整段回放（task-72）：把「用户录音 + 助手 TTS」拼成一段 WAV，并**在对话结束时异步预生成**。
 *
 * 设计要点：
 * - 生成状态落盘到 `DATA_DIR/chat-audio/<sessionId>.json`（sidecar），
 *   `{ status: "building" | "ready" | "failed", turn_count, error?, started_at, ready_at }`。
 * - 同一会话**同一时刻只构建一次**：进程内 Map（inflight）+ 内存 pending 标记；
 *   sidecar 的 building 状态用于跨请求/重启后的可观测性。
 * - 路由层只负责鉴权 + 读状态：`/end`、turn done=true 用 Next `after()` 触发，
 *   GET audio 在“无缓存/force”时触发，都**不阻塞响应**。
 */
import fs from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { DATA_DIR, getDb } from "@/db";
import { chatMessages, chatSessions } from "@/db/schema";
import { HttpError } from "@/lib/auth";
import { resolveAudioPath } from "@/lib/audio";
import { callAudioConcat, callTts, VoiceError, type ConcatPart } from "@/lib/voice";

export const CHAT_AUDIO_DIR = path.join(DATA_DIR, "chat-audio");

/** 用户录音与助手回复之间留 250ms，听感上更像对话。 */
const GAP_MS = 250;

const STALE_BUILDING_ERROR = "上次生成被中断了，点「重新生成」再试一次";
const GENERIC_BUILD_ERROR = "拼装对话音频出错了，请稍后再试";
const NO_AUDIO_ERROR =
  "这段对话还没有可回放的音频（需要至少有一句语音输入，或助手回复）";

export type ChatAudioStatus = "building" | "ready" | "failed";

export interface ChatAudioMeta {
  status: ChatAudioStatus;
  turn_count: number;
  error?: string;
  started_at?: string;
  ready_at?: string | null;
  /** 额外信息：拼进来的段数与缺录音的消息（排障用） */
  parts?: number;
  missing?: string[];
  built_at?: string;
}

/** GET /audio/status 的响应体（只读，不触发构建）。 */
export interface ChatAudioState {
  status: ChatAudioStatus;
  turn_count: number;
  error?: string;
  duration_ms?: number;
}

/** 构建失败：消息已经是给用户看的可读文案。 */
export class ChatAudioBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatAudioBuildError";
  }
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "");
}

export function chatAudioPaths(sessionId: string): {
  safeId: string;
  audioFile: string;
  metaFile: string;
} {
  const safeId = safeSessionId(sessionId);
  return {
    safeId,
    audioFile: path.join(CHAT_AUDIO_DIR, `${safeId}.wav`),
    metaFile: path.join(CHAT_AUDIO_DIR, `${safeId}.json`),
  };
}

export function readChatAudioMeta(sessionId: string): ChatAudioMeta | null {
  const { metaFile } = chatAudioPaths(sessionId);
  try {
    const parsed = JSON.parse(fs.readFileSync(metaFile, "utf8")) as ChatAudioMeta;
    if (!parsed || typeof parsed !== "object" || !parsed.status) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeChatAudioMeta(sessionId: string, meta: ChatAudioMeta): void {
  const { metaFile } = chatAudioPaths(sessionId);
  fs.mkdirSync(CHAT_AUDIO_DIR, { recursive: true });
  const tmp = `${metaFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, metaFile);
}

/** 读 WAV 的 data 字节数 / byteRate 估算时长（voice 拼出来的都是 PCM WAV）。 */
export function wavDurationMs(bytes: Buffer): number | null {
  if (bytes.length < 12) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) byteRate = bytes.readUInt32LE(body + 8);
    if (id === "data") {
      dataSize = Math.min(size, bytes.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!byteRate || !dataSize) return null;
  return Math.round((dataSize / byteRate) * 1000);
}

/** 进程内：同一会话正在构建的 Promise（并发去重）。 */
const inflight = new Map<string, Promise<ChatAudioMeta>>();
/** 进程内：已触发但还没进入 inflight 的极短窗口（GET 触发时同步打标）。 */
const pending = new Set<string>();

export function isChatAudioBuilding(sessionId: string): boolean {
  const key = safeSessionId(sessionId);
  return inflight.has(key) || pending.has(key);
}

/** 缓存是否对当前轮数有效（wav + sidecar ready + turn_count 一致）。 */
export function isChatAudioReady(sessionId: string, turnCount: number): boolean {
  const meta = readChatAudioMeta(sessionId);
  if (!meta || meta.status !== "ready" || Number(meta.turn_count) !== turnCount) return false;
  return fs.existsSync(chatAudioPaths(sessionId).audioFile);
}

function mimeForAudioPath(rel: string | null): string {
  const ext = (rel ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "wav") return "audio/wav";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "m4a") return "audio/mp4";
  return "audio/webm";
}

function readableBuildError(err: unknown): string {
  if (err instanceof ChatAudioBuildError) return err.message;
  if (err instanceof VoiceError) {
    const unavailable =
      err.code === "voice_unreachable" ||
      err.status === 404 ||
      err.status === 503 ||
      err.status === 504;
    if (unavailable) {
      return "音频拼接服务暂未就绪（voice /v1/audio/concat 未上线）。可以先看文字记录。";
    }
    return `拼装对话音频失败：${err.message}`;
  }
  return GENERIC_BUILD_ERROR;
}

/**
 * 构建整段对话音频（幂等 + 并发去重）。
 *
 * - 已 ready 且轮数一致且非 force → 直接返回缓存（不调 TTS / concat）。
 * - 同一会话已在构建 → 直接复用同一个 Promise（并发两次触发只拼一次）。
 * - force=true → 忽略缓存重新构建。
 */
export function buildSessionAudio(
  sessionId: string,
  userId: string,
  opts: { force?: boolean } = {},
): Promise<ChatAudioMeta> {
  const key = safeSessionId(sessionId);
  const running = inflight.get(key);
  if (running) return running;

  const promise = doBuildSessionAudio(sessionId, userId, opts.force === true);
  inflight.set(key, promise);
  void promise
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    })
    .catch(() => {
      /* 构建失败已由调用方 / sidecar 处理，这里只负责清理标记 */
    });
  return promise;
}

/** 后台触发（不 await，失败只记日志）：GET audio 的 202 路径用。 */
export function triggerChatAudioBuild(
  sessionId: string,
  userId: string,
  opts: { force?: boolean } = {},
): void {
  const key = safeSessionId(sessionId);
  pending.add(key);
  void buildSessionAudio(sessionId, userId, opts)
    .catch((err) => {
      console.warn(
        `[chat-audio] 后台构建失败（${key}）：${err instanceof Error ? err.message : err}`,
      );
    })
    .finally(() => {
      pending.delete(key);
    });
}

async function doBuildSessionAudio(
  sessionId: string,
  userId: string,
  force: boolean,
): Promise<ChatAudioMeta> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  if (!session || session.userId !== userId) throw new HttpError(404, "not_found", "会话不存在");

  const { audioFile } = chatAudioPaths(sessionId);
  if (!force) {
    const cached = readChatAudioMeta(sessionId);
    if (
      cached?.status === "ready" &&
      Number(cached.turn_count) === session.turnCount &&
      fs.existsSync(audioFile)
    ) {
      return cached;
    }
  }

  const turnCount = session.turnCount;
  const startedAt = new Date().toISOString();
  writeChatAudioMeta(sessionId, {
    status: "building",
    turn_count: turnCount,
    started_at: startedAt,
    ready_at: null,
  });

  try {
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatSessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt));

    // 收集 parts（按时间顺序：用户录音 + 助手 TTS）
    const parts: ConcatPart[] = [];
    const missing: string[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        const abs = m.audioPath ? resolveAudioPath(m.audioPath) : null;
        if (abs && fs.existsSync(abs)) {
          const mime = mimeForAudioPath(m.audioPath);
          parts.push({
            data: new Uint8Array(fs.readFileSync(abs)),
            mime,
            filename: `u.${mime.split("/")[1]}`,
          });
        } else {
          missing.push(m.id);
        }
      } else if (m.role === "assistant" && m.text.trim()) {
        const tts = await callTts({ text: m.text, rate: "normal", format: "wav" });
        parts.push({ data: new Uint8Array(tts.body), mime: "audio/wav", filename: "a.wav" });
      }
    }
    if (parts.length === 0) throw new ChatAudioBuildError(NO_AUDIO_ERROR);

    const merged = await callAudioConcat(parts, GAP_MS);
    fs.mkdirSync(CHAT_AUDIO_DIR, { recursive: true });
    const tmp = `${audioFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, merged.bytes);
    fs.renameSync(tmp, audioFile);

    const readyAt = new Date().toISOString();
    const meta: ChatAudioMeta = {
      status: "ready",
      turn_count: turnCount,
      started_at: startedAt,
      ready_at: readyAt,
      parts: parts.length,
      missing,
      built_at: readyAt,
    };
    writeChatAudioMeta(sessionId, meta);
    return meta;
  } catch (err) {
    const error = readableBuildError(err);
    const raw =
      err instanceof VoiceError ? `（raw: ${err.code}/${err.status ?? "-"} ${err.message}）` : "";
    console.warn(`[chat-audio] 构建失败（${safeSessionId(sessionId)}）：${error}${raw}`);
    writeChatAudioMeta(sessionId, {
      status: "failed",
      turn_count: turnCount,
      error,
      started_at: startedAt,
      ready_at: null,
    });
    if (err instanceof ChatAudioBuildError) throw err;
    throw new ChatAudioBuildError(error);
  }
}

/**
 * 只读状态：GET /audio/status 用，**绝不触发构建**。
 *
 * - 正在构建（inflight/pending）→ building
 * - sidecar 缺失 → building（还没开始准备；首次 GET audio 会触发）
 * - sidecar building 但没有进程内任务 → 上次进程中断 → failed（可点重新生成）
 * - ready 但 wav 丢失 → failed
 */
export function getChatAudioState(sessionId: string, turnCount: number): ChatAudioState {
  const building = isChatAudioBuilding(sessionId);
  const meta = readChatAudioMeta(sessionId);

  if (building) {
    return { status: "building", turn_count: meta?.turn_count ?? turnCount };
  }
  if (!meta) {
    return { status: "building", turn_count: turnCount };
  }
  if (meta.status === "building") {
    return {
      status: "failed",
      turn_count: meta.turn_count ?? turnCount,
      error: STALE_BUILDING_ERROR,
    };
  }
  if (meta.status === "failed") {
    return {
      status: "failed",
      turn_count: meta.turn_count ?? turnCount,
      error: meta.error ?? GENERIC_BUILD_ERROR,
    };
  }

  const { audioFile } = chatAudioPaths(sessionId);
  if (!fs.existsSync(audioFile)) {
    return {
      status: "failed",
      turn_count: meta.turn_count ?? turnCount,
      error: "回放文件不见了，点「重新生成」再试一次",
    };
  }
  const duration = wavDurationMs(fs.readFileSync(audioFile));
  return {
    status: "ready",
    turn_count: meta.turn_count ?? turnCount,
    ...(duration ? { duration_ms: duration } : {}),
  };
}
