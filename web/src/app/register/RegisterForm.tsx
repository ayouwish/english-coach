"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Mode = "create" | "join" | "newfamily";

/**
 * 注册表单（task-97/99）：创建新家庭 / 用邀请码加入。
 * ALLOW_SELF_SIGNUP=0 时"创建家庭"关闭（仅展示说明），但"用邀请码加入"仍可用。
 */
export function RegisterForm({ allowSelfSignup }: { allowSelfSignup: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(allowSelfSignup ? "create" : "join");
  const [familyName, setFamilyName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // task-106 rev2：newfamily 模式必须填邀请码（之前该模式不渲染邀请码输入，永远为空）
    if (mode === "newfamily" && !inviteCode.trim()) {
      setError("请填写管理员给你的新家庭邀请码");
      return;
    }
    if (mode === "join" && !inviteCode.trim()) {
      setError("请填写邀请码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          display_name: displayName,
          email,
          password,
          ...(mode === "create"
            ? { family_name: familyName }
            : mode === "newfamily"
              ? { family_name: familyName, new_family_code: inviteCode }
              : { invite_code: inviteCode }),
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `注册失败（HTTP ${res.status}）`);
        return;
      }
      router.push("/practice");
      router.refresh();
    } catch (err) {
      setError(`注册失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* 关闭自助注册时：不渲染"创建家庭"入口，只保留"用邀请码加入"（家长可控） */}
      {allowSelfSignup ? (
        <div className="mt-3 flex flex-wrap gap-2" data-testid="register-mode" data-self-signup="1">
          <button
            type="button"
            data-testid="register-mode-create"
            aria-pressed={mode === "create"}
            className={`ec-btn ${mode === "create" ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-1 text-xs`}
            onClick={() => setMode("create")}
          >
            🆕 创建家庭
          </button>
          <button
            type="button"
            data-testid="register-mode-join"
            aria-pressed={mode === "join"}
            className={`ec-btn ${mode === "join" ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-1 text-xs`}
            onClick={() => setMode("join")}
          >
            🔑 用邀请码加入
          </button>
          <button
            type="button"
            data-testid="register-mode-newfamily"
            aria-pressed={mode === "newfamily"}
            className={`ec-btn ${mode === "newfamily" ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-1 text-xs`}
            onClick={() => setMode("newfamily")}
          >
            🏠 受邀创建新家庭
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2" data-testid="register-mode" data-self-signup="0">
          <button
            type="button"
            data-testid="register-mode-join"
            aria-pressed={mode === "join"}
            className={`ec-btn ${mode === "join" ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-1 text-xs`}
            onClick={() => setMode("join")}
          >
            🔑 受邀加入家庭
          </button>
          <button
            type="button"
            data-testid="register-mode-newfamily"
            aria-pressed={mode === "newfamily"}
            className={`ec-btn ${mode === "newfamily" ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-1 text-xs`}
            onClick={() => setMode("newfamily")}
          >
            🏠 受邀创建新家庭
          </button>
        </div>
      )}

      {!allowSelfSignup ? (
        <p className="mt-2 rounded-xl bg-[#fff3d6] p-3 text-sm text-[#7a4d00]" data-testid="register-signup-disabled">
          公开注册已关闭（ALLOW_SELF_SIGNUP=0）。请用家长分享的邀请码加入家庭；需要新家庭请联系管理员。
        </p>
      ) : null}

      <form onSubmit={submit} className="mt-3 flex flex-col gap-3" data-testid="register-form" data-mode={mode}>
        {/* task-106 rev2：「受邀创建新家庭」= 邀请码 + 家庭名称（两个都要）；加入家庭只要邀请码 */}
        {mode !== "create" ? (
          <label className="text-sm font-semibold">
            {mode === "newfamily" ? "新家庭邀请码" : "邀请码"}
            <input
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              required
              maxLength={12}
              placeholder={mode === "newfamily" ? "管理员提供的新家庭邀请码" : "8 位邀请码（一次性）"}
              data-testid="register-invite-code"
              className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-3 py-2 text-base font-normal tracking-widest"
            />
          </label>
        ) : null}
        {mode !== "join" ? (
          <label className="text-sm font-semibold">
            家庭名称
            <input
              value={familyName}
              onChange={(e) => setFamilyName(e.target.value)}
              required
              maxLength={20}
              placeholder={mode === "newfamily" ? "你的新家庭名称（例如：李家）" : "例如：王家"}
              data-testid="register-family-name"
              className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-3 py-2 text-base font-normal"
            />
          </label>
        ) : null}
        <label className="text-sm font-semibold">
          你的昵称
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            maxLength={20}
            placeholder="例如：爸爸"
            data-testid="register-display-name"
            className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-3 py-2 text-base font-normal"
          />
        </label>
        <label className="text-sm font-semibold">
          邮箱
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            data-testid="register-email"
            className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-3 py-2 text-base font-normal"
          />
        </label>
        <label className="text-sm font-semibold">
          密码（至少 8 位）
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            data-testid="register-password"
            className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-3 py-2 text-base font-normal"
          />
        </label>
        {error ? (
          <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" data-testid="register-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy} className="ec-btn ec-btn-primary" data-testid="register-submit">
          {busy ? "正在创建…" : mode === "create" ? "创建家庭并开始" : "加入家庭并开始"}
        </button>
      </form>

      <p className="mt-3 text-xs text-[var(--ec-muted)]">
        孩子账号由家长在「家长面板 → 家庭成员」里创建。邀请码一次性使用，家长可在面板重置。
      </p>
      <p className="mt-2 text-sm">
        已有账号？{" "}
        <Link href="/login" className="underline">
          去登录
        </Link>
      </p>
    </>
  );
}
