"use client";

import { useEffect, useState } from "react";

/**
 * 整段对话音频（task-68）：`GET /api/chat/sessions/:id/audio` 拼接「用户录音 + 助手 TTS」。
 * 用 fetch 拿 blob 再播放：这样能显示可读错误（voice 拼接未就绪时 503），也便于「下载」。
 */
export function ChatSessionAudio({ sessionId, isChild = false }: { sessionId: string; isChild?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/audio`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          if (!cancelled) setError(body?.error?.message ?? `整段回放暂时不可用（HTTP ${res.status}）`);
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (err) {
        if (!cancelled) setError(`整段回放暂时不可用：${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId]);

  return (
    <div className="mt-2 rounded-xl bg-[#f8f9ff] p-3" data-testid="chat-session-audio">
      <p className="text-sm font-semibold">🎧 {isChild ? "听一听我们的对话" : "回放整段对话"}</p>
      {loading ? <p className="mt-1 text-xs text-[var(--ec-muted)]">正在把这段对话拼起来…</p> : null}
      {url ? (
        <div className="mt-2 flex flex-col gap-1">
          <audio controls preload="metadata" src={url} data-testid="chat-session-audio-player" className="w-full max-w-md" />
          <a href={url} download={`conversation-${sessionId}.wav`} className="text-xs underline" data-testid="chat-session-audio-download">
            ⬇️ 下载这段对话
          </a>
        </div>
      ) : null}
      {error ? (
        <p className="mt-1 rounded-lg bg-[#fff3d6] p-2 text-xs text-[#7a4d00]" role="alert" data-testid="chat-session-audio-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
