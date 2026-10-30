"use client";

import { useCallback, useEffect, useState } from "react";
import { CEFR_LEVELS } from "@/lib/levels";

interface Member {
  id: string;
  email: string;
  display_name: string;
  role: string;
  age_band: string;
  cefr_level: string;
  avatar: string | null;
  daily_limit_minutes: number;
  allow_free_chat: boolean;
  created_at: string;
  stats: { attempts: number; last_active_at: string | null };
}

/**
 * 家庭成员管理（task-54）—— 仅家长可见（服务端 /parent 已 403 拦截，API 也有 requireParent 双保险）。
 * 创建账号（不同英语水平）、改昵称/水平/时长、重置密码；错误一律可见。
 */
export function FamilyMembersPanel({ viewerId }: { viewerId: string }) {
  const [items, setItems] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  // 新建表单
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"parent" | "child">("parent");
  const [cefr, setCefr] = useState("A2");
  const [limit, setLimit] = useState(20);
  const [freeChat, setFreeChat] = useState(true);

  // 编辑
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCefr, setEditCefr] = useState("A2");
  const [editLimit, setEditLimit] = useState(20);
  const [editFreeChat, setEditFreeChat] = useState(true);

  // 重置密码
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPwd, setResetPwd] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/family/members");
      const data = (await res.json().catch(() => null)) as { items?: Member[]; error?: { message?: string } } | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `加载家庭成员失败（HTTP ${res.status}）`);
        return;
      }
      setItems(data?.items ?? []);
      setError(null);
    } catch (err) {
      setError(`加载家庭成员失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/family/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          display_name: name,
          login,
          password,
          role,
          cefr_level: cefr,
          daily_limit_minutes: limit,
          allow_free_chat: freeChat,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { member?: Member; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `创建失败（HTTP ${res.status}）`);
        return;
      }
      setNotice(`已创建 ${data?.member?.display_name ?? "成员"}（登录名 ${data?.member?.email ?? login}）`);
      setShowAdd(false);
      setName("");
      setLogin("");
      setPassword("");
      await load();
    } catch (err) {
      setError(`创建失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/family/members/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          display_name: editName,
          cefr_level: editCefr,
          daily_limit_minutes: editLimit,
          allow_free_chat: editFreeChat,
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `保存失败（HTTP ${res.status}）`);
        return;
      }
      setEditingId(null);
      setNotice("已保存");
      await load();
    } catch (err) {
      setError(`保存失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/family/members/${id}/password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_password: resetPwd }),
      });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `重置密码失败（HTTP ${res.status}）`);
        return;
      }
      setResetId(null);
      setResetPwd("");
      setNotice("密码已重置（旧密码已失效）");
    } catch (err) {
      setError(`重置密码失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ec-card" data-testid="family-members-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-extrabold">👨‍👩‍👧 家庭成员</h2>
          <p className="mt-1 text-xs text-[var(--ec-muted)]">
            给家里人各建一个账号（不同英语水平）。登录名可以只写简称，会自动补 @family.local。
          </p>
        </div>
        <button
          type="button"
          className="ec-btn ec-btn-primary"
          data-testid="family-add-open"
          onClick={() => {
            setShowAdd((v) => !v);
            setError(null);
            setNotice(null);
          }}
        >
          ＋ 添加成员
        </button>
      </div>

      {error ? (
        <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="family-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 rounded-xl bg-[#e8f7ee] p-3 text-sm text-[#166534]" data-testid="family-notice">
          {notice}
        </p>
      ) : null}

      {showAdd ? (
        <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3" data-testid="family-add-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              昵称
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 20))}
                data-testid="family-input-name"
                className="rounded-lg border border-[#d9dcf0] px-2 py-1"
                placeholder="比如：爸爸 / 奶奶"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              登录名（可只写简称）
              <input
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                data-testid="family-input-login"
                className="rounded-lg border border-[#d9dcf0] px-2 py-1"
                placeholder="比如：dad2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              初始密码（至少 8 位）
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="family-input-password"
                className="rounded-lg border border-[#d9dcf0] px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              角色
              <select
                value={role}
                onChange={(e) => setRole(e.target.value === "child" ? "child" : "parent")}
                data-testid="family-input-role"
                className="rounded-lg border border-[#d9dcf0] px-2 py-1"
              >
                <option value="parent">家长</option>
                <option value="child">孩子</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              英语水平
              <select
                value={cefr}
                onChange={(e) => setCefr(e.target.value)}
                data-testid="family-input-cefr"
                className="rounded-lg border border-[#d9dcf0] px-2 py-1"
              >
                {CEFR_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              每日时长（分钟）
              <input
                type="number"
                min={5}
                max={180}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 20)}
                className="rounded-lg border border-[#d9dcf0] px-2 py-1"
              />
            </label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={freeChat} onChange={(e) => setFreeChat(e.target.checked)} />
            允许自由对话（不按剧本）
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="ec-btn ec-btn-primary" data-testid="family-create" disabled={busy} onClick={() => void create()}>
              {busy ? "创建中…" : "创建账号"}
            </button>
            <button type="button" className="ec-btn ec-btn-ghost" onClick={() => setShowAdd(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {loading ? <p className="mt-3 text-sm text-[var(--ec-muted)]">加载中…</p> : null}
      <ul className="mt-3 flex flex-col gap-2" data-testid="family-members-list">
        {items.map((m) => (
          <li key={m.id} className="rounded-xl border border-[#e6e8f5] p-3" data-testid="family-member" data-member-id={m.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xl" aria-hidden>
                {m.avatar ?? (m.role === "child" ? "🧒" : "👤")}
              </span>
              <span className="font-semibold">{m.display_name}</span>
              <span className="rounded-full bg-[var(--ec-primary-soft)] px-2 py-0.5 text-xs text-[var(--ec-primary)]">
                {m.role === "parent" ? "家长" : "孩子"}
              </span>
              <span className="rounded-full bg-[#eef0f8] px-2 py-0.5 text-xs">{m.cefr_level}</span>
              <span className="text-xs text-[var(--ec-muted)]">
                {m.daily_limit_minutes} 分钟/天 · 练过 {m.stats.attempts} 次
                {m.stats.last_active_at ? ` · 最近 ${new Date(m.stats.last_active_at).toLocaleDateString("zh-CN")}` : ""}
                {m.id === viewerId ? " · 你自己" : ""}
              </span>
              <span className="ml-auto flex flex-wrap gap-2">
                <button
                  type="button"
                  className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                  data-testid="family-member-edit"
                  onClick={() => {
                    setEditingId(m.id);
                    setEditName(m.display_name);
                    setEditCefr(m.cefr_level);
                    setEditLimit(m.daily_limit_minutes);
                    setEditFreeChat(m.allow_free_chat);
                    setError(null);
                    setNotice(null);
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                  data-testid="family-member-reset"
                  onClick={() => {
                    setResetId(m.id);
                    setResetPwd("");
                    setError(null);
                    setNotice(null);
                  }}
                >
                  重置密码
                </button>
              </span>
            </div>
            {m.email ? <p className="mt-1 text-xs text-[var(--ec-muted)]">登录名：{m.email}</p> : null}

            {editingId === m.id ? (
              <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-[#f8f9ff] p-2" data-testid="family-edit-form">
                <label className="flex flex-col gap-1 text-xs">
                  昵称
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value.slice(0, 20))}
                    className="w-32 rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  英语水平
                  <select
                    value={editCefr}
                    onChange={(e) => setEditCefr(e.target.value)}
                    data-testid="family-edit-cefr"
                    className="rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
                  >
                    {CEFR_LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  每日时长
                  <input
                    type="number"
                    min={5}
                    max={180}
                    value={editLimit}
                    onChange={(e) => setEditLimit(Number(e.target.value) || 20)}
                    className="w-20 rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
                  />
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={editFreeChat} onChange={(e) => setEditFreeChat(e.target.checked)} />
                  自由对话
                </label>
                <button
                  type="button"
                  className="ec-btn ec-btn-primary !px-2 !py-0.5 text-xs"
                  data-testid="family-save-edit"
                  disabled={busy}
                  onClick={() => void saveEdit(m.id)}
                >
                  保存
                </button>
                <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs" onClick={() => setEditingId(null)}>
                  取消
                </button>
              </div>
            ) : null}

            {resetId === m.id ? (
              <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-[#fff3d6] p-2" data-testid="family-reset-form">
                <label className="flex flex-col gap-1 text-xs">
                  新密码（至少 8 位）
                  <input
                    type="password"
                    value={resetPwd}
                    onChange={(e) => setResetPwd(e.target.value)}
                    data-testid="family-reset-password"
                    className="w-40 rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
                  />
                </label>
                <button
                  type="button"
                  className="ec-btn ec-btn-primary !px-2 !py-0.5 text-xs"
                  data-testid="family-reset-submit"
                  disabled={busy}
                  onClick={() => void resetPassword(m.id)}
                >
                  确认重置
                </button>
                <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs" onClick={() => setResetId(null)}>
                  取消
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
