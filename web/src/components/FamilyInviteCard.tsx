"use client";

import { useCallback, useEffect, useState } from "react";

/** 家庭邀请码卡片（task-97）：仅家长可见，可复制 / 重置（旧码立即失效）。 */
export function FamilyInviteCard() {
  const [info, setInfo] = useState<{
    family_name: string;
    invite_code: string;
    invite_used?: boolean;
    parents_count?: number;
    parents_limit?: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/family/invite", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as
        | {
            family_name?: string;
            invite_code?: string;
            invite_used?: boolean;
            parents_count?: number;
            parents_limit?: number;
            error?: { message?: string };
          }
        | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `读取邀请码失败（HTTP ${res.status}）`);
        return;
      }
      setInfo({
        family_name: body?.family_name ?? "",
        invite_code: body?.invite_code ?? "",
        invite_used: body?.invite_used,
        parents_count: body?.parents_count,
        parents_limit: body?.parents_limit,
      });
    } catch (err) {
      setError(`读取邀请码失败：${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy() {
    if (!info?.invite_code) return;
    try {
      await navigator.clipboard.writeText(info.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("复制失败：请长按/手动选择邀请码复制");
    }
  }

  const atParentLimit = (info?.parents_count ?? 0) >= (info?.parents_limit ?? 3);

  async function rotate() {
    if (atParentLimit) return;
    if (!window.confirm("重置后旧邀请码立即失效，确定吗？")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/family/invite/rotate", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { invite_code?: string; family_name?: string; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `重置失败（HTTP ${res.status}）`);
        return;
      }
      setInfo({
        family_name: body?.family_name ?? info?.family_name ?? "",
        invite_code: body?.invite_code ?? "",
        invite_used: false,
        parents_count: info?.parents_count,
        parents_limit: info?.parents_limit,
      });
    } catch (err) {
      setError(`重置失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ec-card" data-testid="family-invite-card">
      <h2 className="text-base font-extrabold">🏠 家庭邀请码</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        把邀请码发给另一位家长，对方在登录页点「🆕 创建家庭 / 🔑 用邀请码加入」即可加入同一个家庭
        （家庭之间互相看不到数据）。孩子账号仍在下面「家庭成员」里创建。
      </p>
      {error ? (
        <p className="mt-2 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="invite-error">
          {error}
        </p>
      ) : null}
      {info ? (
        <>
        <p className="mt-2 text-xs text-[var(--ec-muted)]" data-testid="invite-usage">
          家长账号 {info.parents_count ?? "—"}/{info.parents_limit ?? 3} ·{" "}
          {atParentLimit
            ? "家长账号已满，不能再邀请新家长"
            : info.invite_used
              ? "邀请码已被使用（一次性），点「重置」生成新码"
              : "邀请码可用（一次性，用后失效）"}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-[var(--ec-muted)]">{info.family_name} · 邀请码：</span>
          <code
            className="rounded-lg bg-[var(--ec-primary-soft)] px-3 py-1 text-lg font-extrabold tracking-[0.2em]"
            data-testid="invite-code"
          >
            {info.invite_code || "—"}
          </code>
          <button
            type="button"
            className="ec-btn ec-btn-primary !px-2 !py-0.5 text-xs"
            data-testid="invite-copy"
            onClick={() => void copy()}
            disabled={!info.invite_code}
          >
            {copied ? "已复制 ✓" : "📋 复制"}
          </button>
          <button
            type="button"
            className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
            data-testid="invite-rotate"
            onClick={() => void rotate()}
            disabled={busy || atParentLimit}
          >
            {atParentLimit ? "家长账号已满（3/3）" : busy ? "重置中…" : "♻️ 重置邀请码"}
          </button>
        </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-[var(--ec-muted)]" data-testid="invite-loading">
          {error ? "" : "正在读取邀请码…"}
        </p>
      )}
    </section>
  );
}
