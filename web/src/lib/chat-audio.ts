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
  /** 失败时间（用于 60s backoff，避免 TTS 被刷爆） */
  failed_at?: string;
  /** 连续失败次数（≥3 后要求手动「重新生成」） */
  attempts?: number;
  /** 失败分类，便于 UI/排障（tts_unavailable / concat_unavailable / provider_error / no_audio） */
  error_code?: string;
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
  /** 失败分类（tts_unavailable / concat_unavailable / provider_error / no_audio） */
  error_code?: string;
  /** 连续失败次数（≥3 必须手动重新生成） */
  attempts?: number;
  /** 是否允许自动重试（false 时 UI 只显示「重新生成」按钮） */
  auto_retry: boolean;
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

/** 构建阶段标记：错误归因必须准确（TTS 失败 vs concat 未就绪，别互相甩锅） */
class StageError extends Error {
  stage: "tts" | "concat";
  cause: unknown;
  index?: number;
  constructor(stage: "tts" | "concat", cause: unknown, index?: number) {
    const base = cause instanceof Error ? cause.message : String(cause);
    super(`[${stage}] ${base}`);
    this.name = "StageError";
    this.stage = stage;
    this.cause = cause;
    this.index = index;
  }
}

export interface BuildFailure {
  message: string;
  code: string;
}

/** 把构建异常翻译成「用户能看懂 + 归因正确」的文案（Lead：别再一律说 concat 未上线） */
export function describeBuildFailure(err: unknown): BuildFailure {
  if (err instanceof ChatAudioBuildError) return { message: err.message, code: "no_audio" };
  if (err instanceof StageError) {
    const cause = err.cause;
    const ve = cause instanceof VoiceError ? cause : null;
    const status = ve?.status;
    const code = ve?.code ?? "provider_error";
    if (err.stage === "tts") {
      const unavailable = status === 503 || status === 429 || code === "provider_timeout" || code === "voice_unreachable";
      if (unavailable) {
        return {
          message: `语音合成暂时不可用（${status ?? code}），稍后可重试。可以先看文字记录。`,
          code: "tts_unavailable",
        };
      }
      return {
        message: `语音合成失败（${code}${status ? `/${status}` : ""}）：${(ve?.message ?? String(cause)).slice(0, 120)}`,
        code: "tts_failed",
      };
    }
    const unavailable = status === 404 || status === 503 || status === 504 || code === "voice_unreachable";
    if (unavailable) {
      return {
        message: `音频拼接服务暂未就绪（voice /v1/audio/concat ${status ?? code}）。可以先看文字记录。`,
        code: "concat_unavailable",
      };
    }
    return {
      message: `拼装对话音频失败（${code}${status ? `/${status}` : ""}）：${(ve?.message ?? String(cause)).slice(0, 120)}`,
      code: "provider_error",
    };
  }
  if (err instanceof VoiceError) {
    const unavailable = err.code === "voice_unreachable" || err.status === 404 || err.status === 503;
    return {
      message: unavailable ? `音频拼接服务暂未就绪（${err.code}/${err.status ?? "-"}）。可以先看文字记录。` : `拼装对话音频失败：${err.message}`,
      code: unavailable ? "concat_unavailable" : "provider_error",
    };
  }
  return { message: GENERIC_BUILD_ERROR, code: "provider_error" };
}

const FAILED_BACKOFF_MS = 60_000;
const MAX_AUTO_ATTEMPTS = 3;

/**
 * 失败后是否允许**自动**重建（Lead 补 bug ②）：
 * - 60s 内 → 不自动重试（避免 TTS 被刷到 429/503 的恶性循环）
 * - 连续失败 ≥3 次 → 必须手动「重新生成」（?force=1）
 */
export function shouldAutoRetry(meta: ChatAudioMeta | null, now = Date.now()): boolean {
  if (!meta || meta.status !== "failed") return true;
  const attempts = Number(meta.attempts ?? 1);
  if (attempts >= MAX_AUTO_ATTEMPTS) return false;
  const failedAt = meta.failed_at ? Date.parse(meta.failed_at) : 0;
  if (!failedAt) return true;
  return now - failedAt > FAILED_BACKOFF_MS;
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

  // 失败 backoff：60s 内或连续失败 ≥3 次 → 不自动重建（只有 force=1 才重试，避免 TTS 被刷爆）
  if (!force) {
    const prev = readChatAudioMeta(sessionId);
    if (prev?.status === "failed" && !shouldAutoRetry(prev)) {
      console.warn(
        `[chat-audio] backoff 命中（${safeSessionId(sessionId)}）：attempts=${prev.attempts ?? "?"}，跳过自动重建`,
      );
      return { ...prev, turn_count: turnCount };
    }
  }

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
        // 串行取 TTS（并发 1）：命中缓存秒回；单条失败只重试 1 次（间隔 500ms），仍失败 → 整体 failed（注明哪条）
        let tts: Awaited<ReturnType<typeof callTts>> | null = null;
        let lastErr: unknown = null;
        for (let tryIdx = 0; tryIdx < 2; tryIdx++) {
          try {
            tts = await callTts({ text: m.text, rate: "normal", format: "wav" });
            break;
          } catch (err) {
            lastErr = err;
            if (tryIdx === 0) await new Promise((r) => setTimeout(r, 500));
          }
        }
        if (!tts) throw new StageError("tts", lastErr, parts.length);
        parts.push({ data: new Uint8Array(tts.body), mime: "audio/wav", filename: "a.wav" });
      }
    }
    if (parts.length === 0) throw new ChatAudioBuildError(NO_AUDIO_ERROR);

    let merged: Awaited<ReturnType<typeof callAudioConcat>>;
    try {
      merged = await callAudioConcat(parts, GAP_MS);
    } catch (err) {
      throw new StageError("concat", err);
    }
    fs.mkdirSync(CHAT_AUDIO_DIR, { recursive: true });
    const tmp = `${audioFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, merged.bytes);
    fs.renameSync(tmp, audioFile);

    const readyAt = new Date().toISOString();
    const meta: ChatAudioMeta = {
      status: "ready",
      turn_count: turnCount,
      attempts: 0,
      failed_at: undefined,
      error_code: undefined,
      started_at: startedAt,
      ready_at: readyAt,
      parts: parts.length,
      missing,
      built_at: readyAt,
    };
    writeChatAudioMeta(sessionId, meta);
    return meta;
  } catch (err) {
    const failure = describeBuildFailure(err);
    const prev = readChatAudioMeta(sessionId);
    const attempts = (prev?.status === "failed" ? Number(prev.attempts ?? 0) : 0) + 1;
    const cause = err instanceof StageError ? err.cause : err;
    const raw =
      cause instanceof VoiceError
        ? `（raw: ${cause.code}/${cause.status ?? "-"} ${cause.message}）`
        : err instanceof Error
          ? `（raw: ${err.message}）`
          : "";
    console.warn(
      `[chat-audio] 构建失败（${safeSessionId(sessionId)}，attempts=${attempts}，stage=${err instanceof StageError ? err.stage : "-"}/${failure.code}）：${failure.message}${raw}`,
    );
    writeChatAudioMeta(sessionId, {
      status: "failed",
      turn_count: turnCount,
      error: failure.message,
      error_code: failure.code,
      attempts,
      failed_at: new Date().toISOString(),
      started_at: startedAt,
      ready_at: null,
    });
    if (err instanceof ChatAudioBuildError) throw err;
    throw new ChatAudioBuildError(failure.message);
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
    return { status: "building", turn_count: meta?.turn_count ?? turnCount, auto_retry: true };
  }
  if (!meta) {
    return { status: "building", turn_count: turnCount, auto_retry: true };
  }
  if (meta.status === "building") {
    return {
      status: "failed",
      turn_count: meta.turn_count ?? turnCount,
      error: STALE_BUILDING_ERROR,
      auto_retry: true,
    };
  }
  if (meta.status === "failed") {
    return {
      status: "failed",
      turn_count: meta.turn_count ?? turnCount,
      error: meta.error ?? GENERIC_BUILD_ERROR,
      error_code: meta.error_code,
      attempts: meta.attempts,
      auto_retry: shouldAutoRetry(meta),
    };
  }

  const { audioFile } = chatAudioPaths(sessionId);
  if (!fs.existsSync(audioFile)) {
    return {
      status: "failed",
      turn_count: meta.turn_count ?? turnCount,
      error: "回放文件不见了，点「重新生成」再试一次",
      auto_retry: true,
    };
  }
  const duration = wavDurationMs(fs.readFileSync(audioFile));
  return {
    status: "ready",
    turn_count: meta.turn_count ?? turnCount,
    auto_retry: true,
    ...(duration ? { duration_ms: duration } : {}),
  };
}
