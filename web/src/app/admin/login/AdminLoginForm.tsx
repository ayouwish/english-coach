"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AdminLoginForm({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `登录失败（HTTP ${res.status}）`);
        return;
      }
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(`登录失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <p className="rounded-xl bg-[#fff3d6] p-3 text-sm" data-testid="admin-disabled">
        后台未启用：请先在服务端设置环境变量 <code>ADMIN_PASSWORD</code> 后重启。
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3" data-testid="admin-login-form">
      <label className="text-sm font-semibold">
        管理密码
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          data-testid="admin-password"
          className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-3 py-2 text-base font-normal"
        />
      </label>
      {error ? (
        <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="admin-login-error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy} className="ec-btn ec-btn-primary" data-testid="admin-login-submit">
        {busy ? "登录中…" : "进入后台"}
      </button>
    </form>
  );
}
