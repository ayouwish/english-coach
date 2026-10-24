"use client";

import { useEffect, useRef } from "react";

/**
 * 录音回放。
 *
 * ## 为什么要单独写一个组件
 * `MediaRecorder` 产出的 **webm 头部不含时长信息**（它是流式容器，时长要读到末尾才知道），
 * 所以原生 `<audio controls>` 一开始会显示 `0:00` / `∞`，**播一下之后**才变回真实长度——
 * 用户会以为"录音丢了"。
 *
 * 两个补救一起用：
 * 1. **强制跳转到极远位置**（`currentTime = 1e101`）：浏览器为了 seek 会把整段扫完、算出真实
 *    duration，然后 `timeupdate` 触发时把播放头拉回开头。这是 webm 无时长问题的标准修法。
 * 2. 我们自己**本来就知道录了多久**（录音计时器），所以额外显示一个文字时长兜底——
 *    即使浏览器还没算出 duration，用户也能看到正确长度。
 */
export function RecordedAudio({
  src,
  durationMs,
  label = "我的录音",
}: {
  src: string;
  durationMs?: number | null;
  label?: string;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;

    const fixDuration = () => {
      if (cancelled) return;
      // Infinity / NaN / 0 都说明浏览器还没算出真实时长
      if (!Number.isFinite(el.duration) || el.duration === 0) {
        const onTimeUpdate = () => {
          el.removeEventListener("timeupdate", onTimeUpdate);
          // 时长已经算出来了，把播放头拨回开头，避免用户看到"已播完"
          try {
            el.currentTime = 0;
          } catch {
            /* 某些浏览器此时还不允许 seek，忽略 */
          }
        };
        el.addEventListener("timeupdate", onTimeUpdate);
        try {
          el.currentTime = 1e101;
        } catch {
          /* 忽略：极少数浏览器拒绝超大 seek，此时靠下面的文字兜底 */
        }
      }
    };

    if (el.readyState >= 1) fixDuration();
    el.addEventListener("loadedmetadata", fixDuration);
    return () => {
      cancelled = true;
      el.removeEventListener("loadedmetadata", fixDuration);
    };
  }, [src]);

  return (
    <span className="flex items-center gap-2">
      {label}：
      <audio ref={ref} controls preload="metadata" src={src} className="h-9" data-testid="recorded-audio" />
      {durationMs ? (
        <span className="text-xs tabular-nums text-[var(--ec-muted)]" data-testid="recorded-duration">
          {formatMs(durationMs)}
        </span>
      ) : null}
    </span>
  );
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) / 10); // 0.1s 精度
  return `${total.toFixed(1)} 秒`;
}
