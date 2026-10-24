"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const DEMO = [
  { label: "👨 爸爸（家长）", email: "dad@example.com", password: "Dad12345!" },
  { label: "👩 妈妈（家长）", email: "mom@example.com", password: "Mom12345!" },
  { label: "🧒 女儿（儿童）", email: "girl@example.com", password: "Girl12345!" },
];

export function LoginForm() {
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
          {DEMO.map((d) => (
            <button
              key={d.email}
              type="button"
              className="ec-btn ec-btn-ghost justify-start"
              onClick={() => {
                setEmail(d.email);
                setPassword(d.password);
              }}
            >
              {d.label} · {d.email}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-[var(--ec-muted)]">
          初始密码见 web/README.md；部署时可用 BOOTSTRAP_*_PASSWORD 覆盖。
        </p>
      </details>
    </form>
  );
}
