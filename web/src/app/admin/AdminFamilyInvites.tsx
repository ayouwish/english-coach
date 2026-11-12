"use client";

import { useCallback, useEffect, useState } from "react";

interface Invite { code: string; created_at: string; used_at: string | null; used_by_family_name: string | null }

/** 后台「邀请码管理」（task-111）：剩余名额 / 生成 / 最近 50 条 / 调整名额。 */
export function AdminFamilyInvites() {
  const [data, setData] = useState<{ quota_remaining: number; invites: Invite[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const [quotaInput, setQuotaInput] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/family-invites", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { quota_remaining?: number; invites?: Invite[]; error?: { message?: string } } | null;
      if (!res.ok) { setError(body?.error?.message ?? `读取失败（HTTP ${res.status}）`); return; }
      setData({ quota_remaining: body?.quota_remaining ?? 0, invites: body?.invites ?? [] });
    } catch (err) { setError(`读取失败：${(err as Error).message}`); }
  }, []);
  useEffect(() => void load(), [load]);

  async function generate() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/admin/family-invites", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { code?: string; quota_remaining?: number; error?: { message?: string } } | null;
      if (!res.ok) { setError(body?.error?.message ?? `生成失败（HTTP ${res.status}）`); return; }
      setLastCode(body?.code ?? null);
      await load();
    } catch (err) { setError(`生成失败：${(err as Error).message}`); } finally { setBusy(false); }
  }

  async function adjust(mode: "set" | "add") {
    const n = Number(quotaInput);
    if (!Number.isFinite(n) || n < 0) { setError("请输入非负数字"); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/admin/family-invites/quota", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [mode]: mode === "set" ? n : Math.floor(n) }),
      });
      const body = (await res.json().catch(() => null)) as { quota_remaining?: number; error?: { message?: string } } | null;
      if (!res.ok) { setError(body?.error?.message ?? `调整失败（HTTP ${res.status}）`); return; }
      setNotice(`名额已更新为 ${body?.quota_remaining ?? "—"}`);
      setQuotaInput("");
      await load();
    } catch (err) { setError(`调整失败：${(err as Error).message}`); } finally { setBusy(false); }
  }

  return (
    <section className="ec-card" data-testid="admin-invites">
      <h2 className="text-base font-extrabold">🎟️ 邀请码管理（新家庭）</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        每个码可让一位朋友创建一个全新家庭（一次性，生成时扣 1 个名额）。共同家长的「家庭邀请码」仍在家庭端。
      </p>
      {error ? <p className="mt-2 rounded-xl bg-red-50 p-2 text-xs text-red-700" role="alert" data-testid="admin-invites-error">{error}</p> : null}
      {notice ? <p className="mt-2 rounded-xl bg-[#e8f7ee] p-2 text-xs text-[#166534]" data-testid="admin-invites-notice">{notice}</p> : null}
      {data ? (
        <>
          <p className="mt-2 text-sm">剩余名额：<strong className="text-lg" data-testid="admin-invites-quota">{data.quota_remaining}</strong></p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="ec-btn ec-btn-primary !px-2 !py-0.5 text-xs" data-testid="admin-invites-generate" disabled={busy || data.quota_remaining <= 0} onClick={() => void generate()}>
              {busy ? "处理中…" : data.quota_remaining > 0 ? "生成新家庭邀请码" : "名额已用完"}
            </button>
            <input
              value={quotaInput}
              onChange={(e) => setQuotaInput(e.target.value)}
              placeholder="名额数"
              data-testid="admin-invites-quota-input"
              className="w-24 rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
            />
            <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs" data-testid="admin-invites-quota-set" disabled={busy} onClick={() => void adjust("set")}>设为</button>
            <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs" data-testid="admin-invites-quota-add" disabled={busy} onClick={() => void adjust("add")}>增加</button>
          </div>
          {lastCode ? <p className="mt-2 rounded-lg bg-[var(--ec-primary-soft)] p-2 text-sm" data-testid="admin-invites-last-code">新码：<code className="font-extrabold tracking-widest">{lastCode}</code></p> : null}
          {data.invites.length > 0 ? (
            <ul className="mt-2 flex max-h-60 flex-col gap-1 overflow-y-auto text-xs" data-testid="admin-invites-list">
              {data.invites.map((inv) => (
                <li key={inv.code} className="flex justify-between border-t border-[#eef0f8] py-1">
                  <code>{inv.code}</code>
                  <span className="text-[var(--ec-muted)]">{new Date(inv.created_at).toLocaleDateString("zh-CN")} · {inv.used_at ? `已用（${inv.used_by_family_name ?? "新家庭"}）` : "未使用"}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : <p className="mt-2 text-xs text-[var(--ec-muted)]">读取中…</p>}
    </section>
  );
}
