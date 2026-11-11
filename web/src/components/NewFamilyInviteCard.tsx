"use client";

import { useCallback, useEffect, useState } from "react";

/** 「🏠 邀请新家庭」卡片（task-105）：管理员家庭可生成；其他家庭显示 0 名额。 */
export function NewFamilyInviteCard() {
  const [data, setData] = useState<{ is_admin: boolean; quota_remaining: number; invites: { code: string; created_at: string; used_at: string | null; used_by_family_name: string | null }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastCode, setLastCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/family/family-invites", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { is_admin?: boolean; quota_remaining?: number; invites?: { code: string; created_at: string; used_at: string | null; used_by_family_name: string | null }[]; error?: { message?: string } } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `读取失败（HTTP ${res.status}）`);
        setData({ is_admin: false, quota_remaining: 0, invites: [] });
        return;
      }
      setData({ is_admin: Boolean(body?.is_admin), quota_remaining: body?.quota_remaining ?? 0, invites: body?.invites ?? [] });
    } catch (err) {
      setError(`读取失败：${(err as Error).message}`);
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/family/family-invites", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { code?: string; quota_remaining?: number; error?: { message?: string } } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `生成失败（HTTP ${res.status}）`);
        return;
      }
      setLastCode(body?.code ?? null);
      await load();
    } catch (err) {
      setError(`生成失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ec-card" data-testid="new-family-invite-card">
      <h2 className="text-base font-extrabold">🏠 邀请新家庭</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        每个邀请码可让一位朋友创建一个<strong>全新家庭</strong>，消耗本家庭 1 个名额（该码一次性）。共同家长请用上面的「家庭邀请码」。
      </p>
      {error ? <p className="mt-2 rounded-xl bg-red-50 p-2 text-xs text-red-700" role="alert" data-testid="new-family-invite-error">{error}</p> : null}
      {data ? (
        <>
          <p className="mt-2 text-sm" data-testid="new-family-quota">剩余名额 {data.quota_remaining}</p>
          <button
            type="button"
            className="ec-btn ec-btn-primary !px-2 !py-0.5 text-xs"
            data-testid="new-family-generate"
            disabled={busy || !data.is_admin || data.quota_remaining <= 0}
            onClick={() => void generate()}
          >
            {busy ? "生成中…" : data.is_admin ? (data.quota_remaining > 0 ? "生成新家庭邀请码" : "名额已用完") : "名额 0 · 联系管理员"}
          </button>
          {lastCode ? (
            <p className="mt-2 rounded-lg bg-[var(--ec-primary-soft)] p-2 text-sm" data-testid="new-family-last-code">
              新码：<code className="font-extrabold tracking-widest">{lastCode}</code>
            </p>
          ) : null}
          {data.invites.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="new-family-invite-list">
              {data.invites.map((inv) => (
                <li key={inv.code} className="flex justify-between">
                  <code>{inv.code}</code>
                  <span>{inv.used_at ? `已用（${inv.used_by_family_name ?? "新家庭"}）` : "未使用"}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-xs text-[var(--ec-muted)]">正在读取名额…</p>
      )}
    </section>
  );
}
