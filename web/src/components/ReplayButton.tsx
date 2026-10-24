"use client";

import { useState } from "react";
import { speak, type SpeechRate } from "@/lib/speech-player";

/**
 * 单条消息的「🔊 重播」按钮（task-18）。
 * 同一条消息重复点击会命中 speech-player 的 object URL 缓存，不会重复请求 `/api/tts`。
 */
export function ReplayButton({
  text,
  rate,
  label = "重播这句话",
  className = "",
  testid = "replay-button",
  forcePlaying = false,
  highlight = false,
}: {
  text: string;
  rate: SpeechRate;
  label?: string;
  className?: string;
  testid?: string;
  /** 自动朗读正在播这一条时，按钮也显示「正在播放」 */
  forcePlaying?: boolean;
  /** TTS 慢/超时后把这个按钮变成主按钮「🔊 重试播放」，更显眼 */
  highlight?: boolean;
}) {
  const [playing, setPlaying] = useState(false);

  async function replay() {
    setPlaying(true);
    const outcome = await speak(text, rate, { onEnd: () => setPlaying(false) });
    if (outcome !== "played") setPlaying(false);
  }

  return (
    <button
      type="button"
      data-testid={testid}
      data-rate={rate}
      aria-label={`${label}：${text}`}
      title={label}
      onClick={replay}
      className={`${highlight ? "ec-btn ec-btn-primary" : "ec-btn ec-btn-ghost"} !px-2 !py-0.5 text-xs ${className}`}
    >
      {playing || forcePlaying ? "⏸ 正在播放" : highlight ? "🔊 重试播放" : "🔊 重播"}
    </button>
  );
}
