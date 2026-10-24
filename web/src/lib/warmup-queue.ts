"use client";

/**
 * 参考音静默预热（task-14 A）。
 *
 * 目标：句子被选中时就悄悄把参考音合成掉（voice `/v1/warmup` 落缓存），
 * 用户点「听示范」应当秒出；每句第一次评测也不会因为现合成 TTS 而变慢。
 *
 * 约定：
 *   - **不播放、不 loading、不阻塞 UI、失败静默忽略**（fire-and-forget，调用方不 await）；
 *   - **严格串行**：云 TTS 免费层并发=1，所以用一个 promise 链把请求排成一条队（每次一句）；
 *   - **去重**：同一 (文本, 语速, 音色) 只发一次，重复选择不重复请求。
 */

const warmed = new Set<string>();
let chain: Promise<void> = Promise.resolve();
let sent = 0;

function keyOf(text: string, rate: string, voice: string): string {
  return `${rate}\u001f${voice}\u001f${text}`;
}

/** 已预热条数（自测/调试用） */
export function warmedCount(): number {
  return warmed.size;
}

/** 实际发出的预热请求数（自测/调试用） */
export function warmupRequestCount(): number {
  return sent;
}

export interface WarmOptions {
  rate?: "slow" | "normal";
  voice?: string | null;
}

/** 把一句话排进预热队列（不返回 Promise，调用方 fire-and-forget） */
export function warmSentence(text: string, opts: WarmOptions = {}): void {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return;
  const rate = opts.rate ?? "normal";
  const voice = opts.voice ?? "";
  const key = keyOf(trimmed, rate, voice);
  if (warmed.has(key)) return;
  warmed.add(key);

  chain = chain
    .then(async () => {
      sent += 1;
      try {
        await fetch("/api/warmup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ texts: [trimmed], rate, voice: opts.voice ?? null }),
          keepalive: true,
        });
      } catch {
        // 静默忽略：预热失败不影响任何用户操作（评测时 voice 会自己再合成）
      }
    })
    .catch(() => undefined);
}

/** 低优先级批量预热（同样串行、去重）——用于"当前等级前 N 句" */
export function warmSentences(texts: string[], opts: WarmOptions = {}): void {
  for (const t of texts) warmSentence(t, opts);
}

/** 预热请求完成（自测用：等队列排空） */
export function warmupIdle(): Promise<void> {
  return chain;
}

export function resetWarmupCache(): void {
  warmed.clear();
  sent = 0;
  chain = Promise.resolve();
}
