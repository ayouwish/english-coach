"use client";

import { useRef, useState } from "react";

/**
 * 示范音按钮：走 /api/tts（web 侧统一入口，浏览器不直连 voice）。
 * 用于发音诊断卡片里的「听示范」与例词点击。
 */
export function AudioButton({
  text,
  children,
  rate = "slow",
  className = "",
  testid,
}: {
  text: string;
  children?: React.ReactNode;
  rate?: "slow" | "normal";
  className?: string;
  testid?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  async function play() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, rate }),
      });
      if (!res.ok) {
        setErr("示范音暂时不可用");
        return;
      }
      const blob = await res.blob();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play().catch(() => undefined);
      }
    } catch {
      setErr("示范音暂时不可用");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        className={`ec-btn ec-btn-ghost ${className}`}
        onClick={play}
        disabled={busy}
        data-testid={testid}
        aria-label={`播放示范音：${text}`}
      >
        {busy ? "🔊…" : "🔊"} {children ?? text}
      </button>
      {err ? <span className="text-xs text-[#b45309]">{err}</span> : null}
      <audio ref={audioRef} className="hidden" />
    </span>
  );
}
