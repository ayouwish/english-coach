"use client";

import { useCallback, useEffect, useState } from "react";

type Phase = "loading" | "building" | "ready" | "failed";

/** task-72：生成状态轮询间隔（服务端 /end、done=true 时已异步预生成）。 */
const POLL_MS = 2000;

/**
 * 整段对话音频（task-68 / task-72）。
 *
 * 挂载时先查 `GET /api/chat/sessions/:id/audio/status`（只读，不触发构建）：
 * - ready  → 取 wav blob → `<audio controls preload="metadata">` + 下载
 * - building/未生成 → 「正在生成整段回放…（可以先看文字）」，每 2s 轮询
 * - failed → 可读错误 + 「重新生成」（GET audio?force=1 → 后台重建）
 *
 * 用 fetch 拿 blob 再播放：能显示可读错误，也便于「下载」。
 */
export function ChatSessionAudio({ sessionId, isChild = false }: { sessionId: string; isChild?: boolean }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let objectUrl: string | null = null;
    let kicked = false;
    const endpoint = `/api/chat/sessions/${encodeURIComponent(sessionId)}/audio`;

    const revoke = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    };
    const schedule = () => {
      if (!disposed) timer = setTimeout(() => void poll(), POLL_MS);
    };

    async function loadAudio(): Promise<boolean> {
      const res = await fetch(endpoint, { cache: "no-store" });
      if (res.status === 202) return false; // 服务端还在拼（或缓存过期）→ 继续轮询
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `整段回放暂时不可用（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      if (disposed) return true;
      revoke();
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
      return true;
    }

    async function poll() {
      if (disposed) return;
      try {
        const res = await fetch(`${endpoint}/status`, { cache: "no-store" });
        if (disposed) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `回放状态暂时不可用（HTTP ${res.status}）`);
        }
        const body = (await res.json()) as { status?: string; error?: string };
        if (body.status === "ready") {
          const ok = await loadAudio();
          if (disposed) return;
          if (!ok) {
            setPhase("building");
            schedule();
            return;
          }
          setPhase("ready");
          setError(null);
          return;
        }
        if (body.status === "failed") {
          setPhase("failed");
          setError(body.error ?? "整段回放生成失败了，点「重新生成」再试一次");
          return;
        }
        // 兜底：老会话（本功能上线前结束的）没有 sidecar，status 会报 building 但没人触发构建；
        // 这里最多补一次 GET audio（202 只触发后台构建，不阻塞），正常新会话会直接命中缓存/构建中。
        if (!kicked) {
          kicked = true;
          void fetch(endpoint, { cache: "no-store" }).catch(() => {});
        }
        setPhase("building");
        schedule();
      } catch (err) {
        if (disposed) return;
        setPhase("failed");
        setError(err instanceof Error ? err.message : "整段回放暂时不可用");
      }
    }

    setPhase("loading");
    setError(null);
    setUrl(null);
    void poll();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      revoke();
    };
  }, [sessionId, retryNonce]);

  const regenerate = useCallback(async () => {
    setPhase("building");
    setError(null);
    setUrl(null);
    try {
      // force=1 → 后台重建（202）；服务端会同步打上“构建中”标记，轮询不会读到旧 failed
      await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/audio?force=1`, {
        cache: "no-store",
      });
    } catch {
      /* 轮询会给出可读错误 */
    }
    setRetryNonce((n) => n + 1);
  }, [sessionId]);

  const preparing = phase === "loading" || phase === "building";

  return (
    <div className="mt-2 rounded-xl bg-[#f8f9ff] p-3" data-testid="chat-session-audio">
      <p className="text-sm font-semibold">
        {isChild
          ? phase === "ready"
            ? "🎧 听一听我们的对话"
            : "听一听我们的对话（正在准备…）"
          : phase === "ready"
            ? "🎧 回放整段对话"
            : "回放整段对话"}
      </p>
      {preparing ? (
        <p
          className="mt-1 text-xs text-[var(--ec-muted)]"
          data-testid="chat-session-audio-preparing"
        >
          🎧 正在生成整段回放…（可以先看文字）
        </p>
      ) : null}
      {phase === "ready" && url ? (
        <div className="mt-2 flex flex-col gap-1">
          <audio
            controls
            preload="metadata"
            src={url}
            data-testid="chat-session-audio-player"
            aria-label={isChild ? "听一听我们的对话" : "回放整段对话"}
            className="w-full max-w-md"
          />
          <a
            href={url}
            download={`conversation-${sessionId}.wav`}
            className="text-xs underline"
            data-testid="chat-session-audio-download"
          >
            ⬇️ 下载这段对话
          </a>
        </div>
      ) : null}
      {phase === "failed" ? (
        <div
          className="mt-1 rounded-lg bg-[#fff3d6] p-2 text-xs text-[#7a4d00]"
          role="alert"
          data-testid="chat-session-audio-error"
        >
          <p>{error ?? "整段回放暂时不可用"}</p>
          <button
            type="button"
            onClick={() => void regenerate()}
            className="ec-btn ec-btn-ghost mt-2 text-xs"
            data-testid="chat-session-audio-retry"
            aria-label="重新生成整段回放"
          >
            🔄 重新生成
          </button>
        </div>
      ) : null}
    </div>
  );
}
