"use client";

import { useState } from "react";

/** 自助修改密码（task-59）：当前密码 + 新密码 + 确认；成功后清空。 */
export function PasswordChangeForm({ isChild = false }: { isChild?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (next !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `修改失败（HTTP ${res.status}）`);
        return;
      }
      setMessage("密码已更新 ✅（其他设备上的登录已失效）");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(`修改失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ec-card" data-testid="password-change-section">
      <h2 className="text-base font-extrabold">🔒 {isChild ? "改成新的秘密口令" : "修改密码"}</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        {isChild
          ? "先输入现在的秘密口令，再想一个新的（至少 8 位）。改好后其他设备要重新登录。"
          : "需要先输入当前密码；改好后当前设备保持登录，其他设备的登录会失效。"}
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2" data-testid="password-change-form">
        <label className="text-sm font-semibold">
          当前密码
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoComplete="current-password"
            data-testid="password-current"
            className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-3 py-2 text-base font-normal"
          />
        </label>
        <label className="text-sm font-semibold">
          新密码（至少 8 位）
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            data-testid="password-new"
            className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-3 py-2 text-base font-normal"
          />
        </label>
        <label className="text-sm font-semibold">
          再输一次新密码
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            data-testid="password-confirm"
            className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-3 py-2 text-base font-normal"
          />
        </label>
        {error ? (
          <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="password-error">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="rounded-xl bg-[#e8f7ee] p-3 text-sm text-[#166534]" data-testid="password-success">
            {message}
          </p>
        ) : null}
        <button type="submit" disabled={busy} className="ec-btn ec-btn-primary self-start" data-testid="password-submit">
          {busy ? "保存中…" : "保存新密码"}
        </button>
      </form>
    </section>
  );
}
