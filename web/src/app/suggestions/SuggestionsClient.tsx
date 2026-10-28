"use client";

import { useMemo, useState } from "react";
import {
  CATEGORY_LABELS,
  isSuggestionCategory,
  isSuggestionStatus,
  STATUS_LABELS,
  suggestionsToMarkdown,
  SUGGESTION_STATUSES,
  type SuggestionStatus,
  type SuggestionView,
} from "@/lib/suggestion-shared";

interface Data {
  items: SuggestionView[];
  counts: Record<string, number>;
  total: number;
}

/**
 * 建议列表（家长）：状态筛选、标记已读/已解决、复制 Markdown、下载导出。
 * 失败一律可见（不静默失败）。
 */
export function SuggestionsClient({ initial }: { initial: Data }) {
  const [data, setData] = useState<Data>(initial);
  const [filter, setFilter] = useState<SuggestionStatus | "all">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () => (filter === "all" ? data.items : data.items.filter((s) => s.status === filter)),
    [data.items, filter],
  );

  async function mark(id: string, status: SuggestionStatus) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/suggestions/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
      if (!res.ok || !body?.ok) {
        setError(body?.error?.message ?? `标记失败（HTTP ${res.status}）`);
        return;
      }
      setData((prev) => {
        const items = prev.items.map((s) => (s.id === id ? { ...s, status } : s));
        const counts: Record<string, number> = { open: 0, read: 0, resolved: 0 };
        for (const s of items) counts[s.status] = (counts[s.status] ?? 0) + 1;
        return { ...prev, items, counts };
      });
    } catch (err) {
      setError(`标记失败：${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function copyAll() {
    setError(null);
    const md = suggestionsToMarkdown(visible, {
      generatedAt: new Date().toISOString(),
      counts: data.counts,
      total: visible.length,
    });
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      setError(`复制失败（浏览器可能不允许）：${(err as Error).message}`);
    }
  }

  return (
    <>
      <section className="ec-card">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold">共 {data.total} 条：</span>
          {SUGGESTION_STATUSES.map((st) => (
            <span key={st} className="rounded-full bg-[#eef0f8] px-3 py-1 text-sm" data-testid={`count-${st}`}>
              {STATUS_LABELS[st]} {data.counts[st] ?? 0}
            </span>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`ec-btn ${filter === "all" ? "ec-btn-primary" : "ec-btn-ghost"}`}
            onClick={() => setFilter("all")}
          >
            全部
          </button>
          {SUGGESTION_STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              data-testid={`filter-${st}`}
              className={`ec-btn ${filter === st ? "ec-btn-primary" : "ec-btn-ghost"}`}
              onClick={() => setFilter(st)}
            >
              {STATUS_LABELS[st]}
            </button>
          ))}
          <span className="mx-2 h-5 w-px bg-[#e6e8f5]" />
          <button type="button" className="ec-btn ec-btn-ghost" data-testid="copy-markdown" onClick={() => void copyAll()}>
            📋 复制全部为 Markdown
          </button>
          {/* 下载接口必须用原生 <a>：next/link 会走客户端路由，无法触发文件下载 */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className="ec-btn ec-btn-ghost" href="/api/suggestions/export?format=md" data-testid="download-md">
            ⬇️ 下载 .md
          </a>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className="ec-btn ec-btn-ghost" href="/api/suggestions/export?format=json">
            ⬇️ 下载 .json
          </a>
          {copied ? <span className="text-sm font-semibold text-[#166534]">已复制 ✅</span> : null}
        </div>
        {error ? (
          <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="suggestions-error">
            {error}
          </p>
        ) : null}
      </section>

      {visible.length === 0 ? (
        <section className="ec-card">
          <p className="text-sm text-[var(--ec-muted)]">
            这里还没有建议。家人用的时候可以点导航栏的「💡 提建议」随手留言。
          </p>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          {visible.map((s) => {
            const cat = s.category && isSuggestionCategory(s.category) ? CATEGORY_LABELS[s.category] : (s.category ?? "未分类");
            const st = isSuggestionStatus(s.status) ? STATUS_LABELS[s.status] : s.status;
            return (
              <article key={s.id} className="ec-card" data-testid="suggestion-item" data-status={s.status}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-[var(--ec-primary-soft)] px-2 py-0.5 text-xs font-medium text-[var(--ec-primary)]">
                      {s.user_role === "child" ? "孩子" : s.user_role === "parent" ? "家长" : "未知"}
                    </span>
                    <span className="rounded-full bg-[#eef0f8] px-2 py-0.5 text-xs">{cat}</span>
                    <span className="text-xs text-[var(--ec-muted)]">{st}</span>
                    {s.page ? <code className="text-xs text-[var(--ec-muted)]">{s.page}</code> : null}
                  </div>
                  <span className="text-xs text-[var(--ec-muted)]">
                    {new Date(s.created_at).toLocaleString("zh-CN")}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm" data-testid="suggestion-content">
                  {s.content}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="ec-btn ec-btn-ghost"
                    data-testid="mark-read"
                    disabled={busyId === s.id || s.status !== "open"}
                    onClick={() => void mark(s.id, "read")}
                  >
                    👁 标记已读
                  </button>
                  <button
                    type="button"
                    className="ec-btn ec-btn-primary"
                    data-testid="mark-resolved"
                    disabled={busyId === s.id || s.status === "resolved"}
                    onClick={() => void mark(s.id, "resolved")}
                  >
                    ✅ 标记已解决
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </>
  );
}
