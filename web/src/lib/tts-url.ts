/**
 * `/api/tts` 的 GET URL（task-19）。
 *
 * 为什么用 GET + 原生 `<audio>`：播放器里的 ▶ 是**真实用户手势**，永远能播；
 * 这样即使浏览器拦截了"自动朗读"，用户也总有一个 100% 可用的播放入口 —
 * 而不是我们 `new Audio()` 被拦截后彻底静音、只剩 console.warn。
 *
 * 聊天朗读默认 `format=mp3`（每次都是新文本 → 必 cache miss，体积小/传输快）；
 * 练习页的「听示范」仍走 POST + 默认 wav（与参考音分析共用预热缓存）。
 */
export type TtsRate = "slow" | "normal";
export type TtsFormat = "mp3" | "wav";

export function ttsUrl(text: string, rate: TtsRate, format: TtsFormat = "mp3"): string {
  const q = new URLSearchParams({ text, rate, format });
  return `/api/tts?${q.toString()}`;
}
