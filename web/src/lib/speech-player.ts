/**
 * 对话朗读播放器（task-18）。
 *
 * 设计要点：
 *  - **单实例**：同一时刻只有一条在播（新回复开播前先 stop 上一条）→ 永不重叠；
 *  - **object URL 缓存**：key = (语速, 文本)，同一条消息重播直接复用，不再请求 `/api/tts`；
 *  - **可回收**：`clearCache()`（切场景）/`dispose()`（卸载）统一 revoke；
 *  - **自动播放被拦截**：`play()` 抛 NotAllowedError 时返回 "blocked"，由 UI 显示「点这里开启朗读」。
 *
 * 注意：这个模块只在浏览器里用（Audio / URL.createObjectURL），服务端不会 import 它的函数。
 */

export type SpeechRate = "slow" | "normal";
/** 聊天朗读默认 mp3（每次都是新文本 → 必 cache miss，体积小/传输快）；练习页示范音走 wav 共用预热缓存 */
export type AudioFormat = "mp3" | "wav";
export type SpeakOutcome = "played" | "blocked" | "failed" | "cancelled" | "timeout";

export interface SpeakOptions {
  onEnd?: () => void;
  /** 透传 provider / 音频时长，便于排查（可选） */
  onMeta?: (meta: { provider: string | null; durationMs: string | null; format: AudioFormat }) => void;
  format?: AudioFormat;
  /** 超过这个时间还没拿到音频就放弃（默认 6s）——不让用户干等 */
  timeoutMs?: number;
}

export const SPEECH_TIMEOUT_MS = 6000;

const urlCache = new Map<string, string>();
let audioEl: HTMLAudioElement | null = null;
/** 每次 speak 递增；异步拿到音频后若已过期（用户又点/又发消息）就放弃播放 */
let token = 0;

function keyOf(text: string, rate: SpeechRate, format: AudioFormat): string {
  return `${format}\u001f${rate}\u001f${text}`;
}

class TtsTimeout extends Error {}

async function getObjectUrl(
  text: string,
  rate: SpeechRate,
  format: AudioFormat,
  timeoutMs: number,
  onMeta?: SpeakOptions["onMeta"],
): Promise<string> {
  const key = keyOf(text, rate, format);
  const hit = urlCache.get(key);
  if (hit) return hit;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, rate, format }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted) throw new TtsTimeout();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`tts ${res.status}`);
  onMeta?.({
    provider: res.headers.get("x-tts-provider"),
    durationMs: res.headers.get("x-audio-duration-ms"),
    format,
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

function ensureAudio(): HTMLAudioElement {
  if (!audioEl) audioEl = new Audio();
  return audioEl;
}

/** 停止当前播放（不清理缓存） */
export function stopSpeech(): void {
  token += 1;
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.currentTime = 0;
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 播放一句话。调用方不需要 await 也可以（fire-and-forget），但要处理返回值里的 "blocked"。
 */
export async function speak(
  text: string,
  rate: SpeechRate,
  opts: SpeakOptions = {},
): Promise<SpeakOutcome> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "failed";

  const mine = ++token;
  stopSpeech(); // 不重叠：先停上一条

  let url: string;
  try {
    url = await getObjectUrl(trimmed, rate, opts.format ?? "mp3", opts.timeoutMs ?? SPEECH_TIMEOUT_MS, opts.onMeta);
  } catch (err) {
    if (err instanceof TtsTimeout) {
      console.warn(`[chat-speech] TTS 超过 ${opts.timeoutMs ?? SPEECH_TIMEOUT_MS}ms 未返回，放弃等待（UI 会显示「重试播放」）`);
      return "timeout";
    }
    console.warn("[chat-speech] TTS 获取失败（静默忽略，不影响文字与流程）", err);
    return "failed";
  }
  if (mine !== token) return "cancelled"; // 期间用户又点了别的/发了新消息

  const el = ensureAudio();
  el.onended = () => opts.onEnd?.();
  el.onerror = () => opts.onEnd?.();
  el.src = url;
  try {
    await el.play();
    if (mine !== token) {
      el.pause();
      return "cancelled";
    }
    return "played";
  } catch (err) {
    const name = (err as Error)?.name ?? "";
    if (name === "NotAllowedError" || name === "AbortError") {
      // 浏览器自动播放策略拦截（或被打断）——必须让 UI 提供一次用户点击来解锁
      console.warn("[chat-speech] 自动播放被拦截，需要用户点击一次才能播放");
      return "blocked";
    }
    console.warn("[chat-speech] 播放失败（静默忽略）", err);
    return "failed";
  }
}

/** 清空缓存并释放 object URL（切场景 / 对话结束时调用） */
export function clearSpeechCache(): void {
  stopSpeech();
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/** 组件卸载时调用：停止播放 + 释放全部 object URL */
export function disposeSpeech(): void {
  clearSpeechCache();
  if (audioEl) {
    audioEl.onended = null;
    audioEl.onerror = null;
    audioEl.src = "";
    audioEl = null;
  }
}

/** 自测/调试用：当前缓存了多少条音频 */
export function speechCacheSize(): number {
  return urlCache.size;
}
