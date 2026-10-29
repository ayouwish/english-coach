/**
 * voice 客户端（AI Gateway 的唯一入口）。
 * - web 不持有任何模型密钥，只走 HTTP（契约 §0）。
 * - 超时/重试严格按契约 §9。
 * - 任何失败都抛 VoiceError，由调用方决定降级策略；本文件从不吞掉"评测失败"这件事。
 */
import type {
  AsrResult,
  OcrResult,
  DialogueResult,
  FeedbackResult,
  PronounceResult,
  VoiceCapabilities,
  VoiceErrorCode,
  VoiceHealth,
} from "./types";

export const VOICE_SERVICE_URL = (
  process.env.VOICE_SERVICE_URL ?? "http://127.0.0.1:8100"
).replace(/\/$/, "");

export const TIMEOUTS = {
  health: 3_000,
  /** 预热是后台任务，契约 §12 的示例耗时 45s，给足余量；失败无副作用 */
  warmup: 120_000,
  asr: 30_000,
  /** OCR：首次识别要加载模型（1–2s，最坏更久），给 60s；失败由调用方给可操作提示 */
  ocr: 60_000,
  pronounce: 60_000,
  tts: 20_000,
  feedback: 40_000,
  dialogue: 40_000,
} as const;

export class VoiceError extends Error {
  code: VoiceErrorCode;
  status?: number;
  detail?: unknown;

  constructor(code: VoiceErrorCode, message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

async function callVoice<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${VOICE_SERVICE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const e = err as Error;
    const timeout = e.name === "TimeoutError" || e.name === "AbortError";
    throw new VoiceError(
      timeout ? "provider_timeout" : "voice_unreachable",
      timeout
        ? `voice ${path} 超时（${timeoutMs}ms）`
        : `voice 不可达（${VOICE_SERVICE_URL}${path}）：${e.message}`,
    );
  }

  if (!res.ok) {
    let code: VoiceErrorCode = "provider_error";
    let message = `${path} 返回 ${res.status}`;
    let detail: unknown;
    try {
      const body = (await res.json()) as {
        error?: { code?: VoiceErrorCode; message?: string; detail?: unknown };
      };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
      detail = body?.error?.detail;
    } catch {
      /* 非 JSON 错误体，保留默认信息 */
    }
    throw new VoiceError(code, message, res.status, detail);
  }

  return (await res.json()) as T;
}

/** 契约 §1：3s 超时，不重试。失败返回 null（web 必须能在 voice 未就绪时启动）。 */
export async function fetchVoiceHealth(): Promise<VoiceHealth | null> {
  try {
    return await callVoice<VoiceHealth>("/v1/health", { method: "GET" }, TIMEOUTS.health);
  } catch {
    return null;
  }
}

export const FALLBACK_CAPABILITIES: VoiceCapabilities = {
  phoneme_level: false,
  prosody: false,
  intonation_curve: false,
  nbest_phonemes: false,
  ssml: false,
  gpu: false,
};

let healthCache: { at: number; value: VoiceHealth | null } | null = null;
const HEALTH_TTL_MS = 15_000;

/** 带缓存的健康探测；永远不抛异常。 */
export async function getVoiceHealth(force = false): Promise<VoiceHealth | null> {
  const now = Date.now();
  if (!force && healthCache && now - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
  const value = await fetchVoiceHealth();
  healthCache = { at: now, value };
  return value;
}

export async function getCapabilities(force = false): Promise<{
  reachable: boolean;
  mode: string;
  capabilities: VoiceCapabilities;
  health: VoiceHealth | null;
}> {
  const health = await getVoiceHealth(force);
  return {
    reachable: health !== null,
    mode: health?.mode ?? "unreachable",
    capabilities: health?.capabilities ?? FALLBACK_CAPABILITIES,
    health,
  };
}

/** 契约 §3：multipart 上传；60s 超时；**不重试**（评测重试会重复计费）。 */
export async function callPronounce(form: FormData): Promise<PronounceResult> {
  return callVoice<PronounceResult>(
    "/v1/pronounce",
    { method: "POST", body: form },
    TIMEOUTS.pronounce,
  );
}

/** 契约 §2：30s 超时，允许 1 次重试。 */
export async function callAsr(form: FormData): Promise<AsrResult> {
  return withRetry(() =>
    callVoice<AsrResult>("/v1/asr", { method: "POST", body: form }, TIMEOUTS.asr),
  );
}

/**
 * 拍照识别（OCR）：`POST /v1/ocr`（multipart，字段 image）。
 * voice 未实现该端点时会 404 / 503 —— 调用方必须给"可操作的中文提示"，不许静默失败。
 */
export async function callOcr(image: { data: Uint8Array; mime: string; filename: string }): Promise<OcrResult> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image.data)], { type: image.mime }), image.filename);
  return callVoice<OcrResult>("/v1/ocr", { method: "POST", body: form }, TIMEOUTS.ocr);
}

/** 契约 §5：40s 超时，1 次重试后由调用方降级到本地模板。 */
export async function callFeedback(payload: unknown): Promise<FeedbackResult> {
  return withRetry(() =>
    callVoice<FeedbackResult>(
      "/v1/feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      TIMEOUTS.feedback,
    ),
  );
}

/** 契约 §6：40s 超时，1 次重试后由调用方降级到固定话术。 */
export async function callDialogue(payload: unknown): Promise<DialogueResult> {
  return withRetry(() =>
    callVoice<DialogueResult>(
      "/v1/dialogue",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      TIMEOUTS.dialogue,
    ),
  );
}

export interface WarmupItem {
  text: string;
  voice?: string | null;
  rate?: "slow" | "normal";
}

export interface WarmupResult {
  requested: number;
  generated: number;
  cached: number;
  failed: { text: string; voice?: string | null; rate?: string; error: string }[];
  skipped_duplicates: number;
  elapsed_ms: number;
  cache?: { audio_entries: number; f0_entries: number; bytes: number };
}

/**
 * 契约 §12：缓存预热（参考音 + 参考 F0）。
 * 幂等：同一批第二次调用应全部命中 cached。concurrency 默认 1 —— 云 TTS 免费层并发=1，
 * 预热是后台任务，不要打满。
 */
export async function callWarmup(items: WarmupItem[], concurrency = 1): Promise<WarmupResult> {
  return callVoice<WarmupResult>(
    "/v1/warmup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items, concurrency }),
    },
    TIMEOUTS.warmup,
  );
}

/** 契约 §4：返回二进制音频。 */
export async function callTts(payload: {
  text: string;
  voice?: string | null;
  rate?: "slow" | "normal";
  format?: "mp3" | "wav";
  ssml?: string | null;
}): Promise<{ body: ArrayBuffer; contentType: string; durationMs: string | null; provider: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${VOICE_SERVICE_URL}/v1/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 用 wav 而不是 mp3：**和参考音分析共用同一份缓存**（voice 的 warmup / pronounce 统一用 fmt="wav"），
      // 所以预热过的句子点「跟我读」是 0 等待；24kHz PCM 也比 mp3 少了编解码损失，示范音更清晰。
      body: JSON.stringify({ format: "wav", rate: "normal", voice: null, ssml: null, ...payload }),
      signal: AbortSignal.timeout(TIMEOUTS.tts),
      cache: "no-store",
    });
  } catch (err) {
    throw new VoiceError("voice_unreachable", `TTS 失败：${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new VoiceError("provider_error", `TTS 返回 ${res.status}`, res.status);
  }
  return {
    body: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") ?? "audio/mpeg",
    durationMs: res.headers.get("x-audio-duration-ms"),
    provider: res.headers.get("x-tts-provider"),
  };
}

async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 请求格式错误重试也没用
      if (err instanceof VoiceError && (err.code === "bad_request" || err.code === "unsupported_audio")) {
        throw err;
      }
    }
  }
  throw lastErr;
}
