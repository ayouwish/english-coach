"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** 盲测「取消这轮」按钮（task-103）：二次确认 → DELETE 软取消 → 刷新周报。 */
export function BlindCancelButton({ blindTestId, isChild = false }: { blindTestId: string; isChild?: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/blind-tests/${encodeURIComponent(blindTestId)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `取消失败（HTTP ${res.status}）`);
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch (err) {
      setError(`取消失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2" data-testid="blind-cancel-area">
      {error ? (
        <p className="mb-1 rounded-xl bg-red-50 p-2 text-xs text-red-700" role="alert" data-testid="blind-cancel-error">
          {error}
        </p>
      ) : null}
      {!confirming ? (
        <button
          type="button"
          className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
          data-testid="blind-cancel"
          onClick={() => setConfirming(true)}
        >
          {isChild ? "不想测了就取消～" : "取消这轮盲测"}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--ec-muted)]">取消后这轮不计入周报，确定吗？</span>
          <button
            type="button"
            className="ec-btn ec-btn-warn !px-2 !py-0.5 text-xs"
            data-testid="blind-cancel-confirm"
            disabled={busy}
            onClick={() => void cancel()}
          >
            {busy ? "取消中…" : "确认取消"}
          </button>
          <button
            type="button"
            className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
            data-testid="blind-cancel-abort"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            再想想
          </button>
        </div>
      )}
    </div>
  );
}
