"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** 重新转录录音（task-77）：录音已在服务端，直接重跑 ASR，不用重录。 */
export function RecordingRetryButton({ recordingId, provider }: { recordingId: string; provider?: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/story/recordings/${encodeURIComponent(recordingId)}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(provider ? { provider } : {}),
      });
      const data = (await res.json().catch(() => null)) as { status?: string; error?: string | { message?: string } } | null;
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : data?.error?.message ?? `重试失败（HTTP ${res.status}）`);
        return;
      }
      if (data?.status !== "transcribed") {
        setError(typeof data?.error === "string" ? data.error : "还是没听清；录音还在，可以稍后再试");
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`重试失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
        data-testid="recording-retry"
        disabled={busy}
        onClick={() => void retry()}
      >
        {busy ? "转录中…" : "🔁 重试转录"}
      </button>
      {error ? (
        <span className="text-xs text-red-700" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
