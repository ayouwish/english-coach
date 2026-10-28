"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * 演示账号（由服务端计算后传入）。
 *
 * `password` 为 `null` 表示"部署时用 BOOTSTRAP_*_PASSWORD 覆盖过种子密码"，
 * 前端不知道真实密码，此时只填邮箱、不猜密码 —— 否则用户点一下就带着错误密码提交，
 * 只会看到"邮箱或密码不正确"，很难意识到问题在部署配置上。
 */
export type DemoAccount = { label: string; email: string; password: string | null };

export function LoginForm({
  demoAccounts = [],
  passwordsAreDefault = true,
}: {
  demoAccounts?: DemoAccount[];
  passwordsAreDefault?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setError(data?.error?.message ?? "登录失败");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium">
        邮箱
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-xl border border-[#d9dcf0] px-3 py-2 text-base"
          placeholder="dad@example.com"
          autoComplete="username"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        密码
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-xl border border-[#d9dcf0] px-3 py-2 text-base"
          placeholder="••••••••"
          autoComplete="current-password"
        />
      </label>
      {error ? (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="ec-btn ec-btn-primary mt-1" disabled={busy}>
        {busy ? "登录中…" : "登录"}
      </button>

      <details className="mt-2 rounded-xl bg-[var(--ec-primary-soft)] p-3 text-sm">
        <summary className="cursor-pointer font-semibold">演示账号（点一下自动填）</summary>
        <div className="mt-2 flex flex-col gap-2">
          {demoAccounts.map((d) => (
            <button
              key={d.email}
              type="button"
              className="ec-btn ec-btn-ghost justify-start"
              onClick={() => {
                setEmail(d.email);
                // 只有确认是内置默认密码时才一起填；否则只填邮箱
                setPassword(d.password ?? "");
                setError(null);
              }}
            >
              {d.label} · {d.email}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-[var(--ec-muted)]">
          {passwordsAreDefault ? (
            <>
              点一下会<strong>同时填入</strong>邮箱与内置初始密码（见 web/README.md）。
              若登录失败，说明部署时用 <code>BOOTSTRAP_*_PASSWORD</code> 改过密码 —— 用你设置的那个。
            </>
          ) : (
            <>
              点一下只填邮箱。<strong>密码是部署时设置的</strong>
              （<code>deploy/.env</code> 里的 <code>BOOTSTRAP_*_PASSWORD</code>），
              这里不显示、也不猜测。
            </>
          )}
        </p>
      </details>
    </form>
  );
}
