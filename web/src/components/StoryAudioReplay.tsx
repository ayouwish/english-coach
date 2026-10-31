"use client";

import { useCallback, useEffect, useState } from "react";

type Phase = "loading" | "building" | "ready" | "failed";
const POLL_MS = 2000;

/**
 * 故事整段朗读回放（task-74 ①）。
 *
 * - 打开页面先查 `/api/story/:id/audio/status`（只读）；
 * - 没有缓存 → GET `/audio` 触发一次后台构建（202）→ 每 2s 轮询；
 * - ready → 拉 wav → `<audio controls preload="metadata">` + 下载；
 * - failed → 可读错误 + 「重新生成」（`?force=1`）；
 * - **只有 1 条录音**时后端直接返回那条（不拼接）。
 */
export function StoryAudioReplay({ materialId, isChild = false }: { materialId: string; isChild?: boolean }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = useCallback(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let objectUrl: string | null = null;
    // retryNonce>0 时首次请求带 force=1（用户点了「重新生成」）
    const forceFirst = retryNonce > 0;
    const endpoint = `/api/story/${encodeURIComponent(materialId)}/audio${forceFirst ? "?force=1" : ""}`;
    const statusEndpoint = `${endpoint}/status`;

    const revoke = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    };
    const schedule = () => {
      if (!disposed) timer = setTimeout(() => void poll(), POLL_MS);
    };

    const fetchAudio = async () => {
      const res = await fetch(endpoint, { cache: "no-store" });
      if (res.status === 200) {
        const blob = await res.blob();
        if (disposed) return;
        revoke();
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setPhase("ready");
        return true;
      }
      if (res.status === 202) {
        setPhase("building");
        schedule();
        return true;
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!disposed) {
        setError(body?.error?.message ?? `回放暂时不可用（HTTP ${res.status}）`);
        setPhase("failed");
      }
      return true;
    };

    const poll = async () => {
      try {
        const res = await fetch(statusEndpoint, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as
          | { status?: Phase; attempt_count?: number; error?: string }
          | null;
        if (disposed) return;
        if (body?.status === "ready") {
          await fetchAudio();
        } else if (body?.status === "failed") {
          setError(body?.error ?? "拼装朗读音频出错了");
          setPhase("failed");
        } else {
          setPhase("building");
          // 状态是 building 但没有构建在进行（首次打开）→ 触发一次
          await fetchAudio();
        }
      } catch (err) {
        if (!disposed) {
          setError(`读取回放状态失败：${(err as Error).message}`);
          setPhase("failed");
        }
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      revoke();
    };
  }, [materialId, retryNonce]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  const title = isChild ? "🎧 听一听我读的故事" : "🎧 回放整段朗读";

  return (
    <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3" data-testid="story-audio">
      <p className="text-sm font-semibold">{title}</p>
      {phase === "loading" ? <p className="mt-1 text-xs text-[var(--ec-muted)]">读取回放…</p> : null}
      {phase === "building" ? (
        <p className="mt-1 text-xs text-[var(--ec-muted)]" data-testid="story-audio-building">
          正在生成整段朗读…（可以先看文字，翻页回来就能听）
        </p>
      ) : null}
      {url ? (
        <div className="mt-2 flex flex-col gap-1">
          <audio controls preload="metadata" src={url} data-testid="story-audio-player" className="w-full max-w-md" />
          <a href={url} download={`story-${materialId}.wav`} className="text-xs underline" data-testid="story-audio-download">
            ⬇️ 下载整段朗读
          </a>
        </div>
      ) : null}
      {error ? (
        <div className="mt-1" data-testid="story-audio-error">
          <p className="rounded-lg bg-[#fff3d6] p-2 text-xs text-[#7a4d00]" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs mt-1"
            data-testid="story-audio-retry"
            onClick={() => {
              setError(null);
              setPhase("loading");
              fetch(`/api/story/${encodeURIComponent(materialId)}/audio?force=1`, { cache: "no-store" }).catch(() => null);
              setRetryNonce((n) => n + 1);
            }}
          >
            重新生成
          </button>
        </div>
      ) : null}
    </div>
  );
}
