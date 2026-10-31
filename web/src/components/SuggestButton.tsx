"use client";

import { useEffect, useState } from "react";
import {
  CATEGORY_LABELS,
  CATEGORY_LABELS_CHILD,
  CHILD_SUGGESTION_CATEGORIES,
  MAX_SUGGESTION_LENGTH,
  SUGGESTION_CATEGORIES,
  type SuggestionCategory,
} from "@/lib/suggestion-shared";

/**
 * 导航栏「💡 提建议」+ 弹窗表单（task-23 C）。
 *
 * 硬约束：
 *  - 儿童也能用（大按钮、口语化文案）；
 *  - **不许静默失败**：提交失败显示可读原因；
 *  - 文案里不写 markdown 星号（用 <strong>）；
 *  - 不把用户输入直接渲染成 HTML（React 默认转义，无 dangerouslySetInnerHTML）。
 */
export function SuggestButton({
  isChild,
  presetCategory,
  presetContent,
  triggerLabel,
  triggerTestId,
  context,
  triggerClassName,
}: {
  isChild: boolean;
  /** 打开弹窗时预选分类（例如提示词问题用 bug） */
  presetCategory?: SuggestionCategory;
  /** 打开弹窗时预填正文（例如故事标题+提示词摘要） */
  presetContent?: string;
  /** 自定义按钮文案（不传 = 导航栏默认「💡 提建议」） */
  triggerLabel?: string;
  triggerTestId?: string;
  /** 随建议一起上报的上下文（task-62：prompt/story_id/style） */
  context?: Record<string, string | number | null>;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<SuggestionCategory>(presetCategory ?? "experience");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const categories = isChild ? CHILD_SUGGESTION_CATEGORIES : SUGGESTION_CATEGORIES;
  const labels = isChild ? CATEGORY_LABELS_CHILD : CATEGORY_LABELS;
  const remaining = MAX_SUGGESTION_LENGTH - content.trim().length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          content,
          context,
          page: typeof window !== "undefined" ? window.location.pathname + window.location.search : null,
          viewport:
            typeof window !== "undefined"
              ? { w: window.innerWidth, h: window.innerHeight }
              : null,
        }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error?.message ?? `提交失败（HTTP ${res.status}），请稍后再试`);
        return;
      }
      setDone(true);
      setContent("");
      setTimeout(() => {
        setOpen(false);
        setDone(false);
      }, 1200);
    } catch (err) {
      setError(`提交失败：${(err as Error).message}。请检查网络后重试。`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid={triggerTestId ?? "suggest-open"}
        aria-haspopup="dialog"
        aria-label={triggerLabel ?? "提建议"}
        onClick={() => {
          // 预填（提示词反馈场景）：分类 + 正文摘要，用户可再改
          if (presetCategory) setCategory(presetCategory);
          if (presetContent !== undefined) setContent(presetContent.slice(0, MAX_SUGGESTION_LENGTH));
          setOpen(true);
          setError(null);
          setDone(false);
        }}
        className={triggerClassName ?? "ec-btn ec-btn-ghost"}
      >
        {triggerLabel ?? `💡 ${isChild ? "我想说" : "提建议"}`}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="提建议"
          data-testid="suggest-dialog"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <h2 className={isChild ? "text-xl font-extrabold" : "text-lg font-extrabold"}>
                {isChild ? "💡 我想说点什么" : "💡 提建议"}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭"
                className="rounded-lg px-2 py-1 text-[var(--ec-muted)] hover:bg-[#eef0f8]"
              >
                ✕
              </button>
            </div>

            <p className="mt-1 text-sm text-[var(--ec-muted)]">
              {isChild
                ? "用起来哪里不顺手、想读什么故事、想加什么功能，都可以告诉我 🙂"
                : "哪里不好用、想要什么功能、内容有什么问题，都记在这里，家长可以统一查看和导出。"}
            </p>

            <div className="mt-4">
              <p className="text-sm font-semibold">{isChild ? "这是关于什么的？" : "分类"}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    data-testid={`suggest-category-${c}`}
                    data-category={c}
                    aria-pressed={category === c}
                    onClick={() => setCategory(c)}
                    className={`${category === c ? "ec-btn ec-btn-primary" : "ec-btn ec-btn-ghost"} ${isChild ? "text-base" : "text-sm"}`}
                  >
                    {labels[c]}
                  </button>
                ))}
              </div>
            </div>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-semibold">{isChild ? "想说的话" : "具体内容"}</span>
              <textarea
                data-testid="suggest-content"
                value={content}
                onChange={(e) => setContent(e.target.value.slice(0, MAX_SUGGESTION_LENGTH))}
                rows={isChild ? 5 : 4}
                placeholder={isChild ? "比如：我想读恐龙的故事" : "例如：跟读页的示范音有时要等很久…"}
                className={`w-full rounded-xl border border-[#d9dcf0] px-3 py-2 ${isChild ? "text-base" : "text-sm"}`}
              />
            </label>
            <div className="mt-1 flex items-center justify-between text-xs text-[var(--ec-muted)]">
              <span data-testid="suggest-count">
                {content.trim().length} / {MAX_SUGGESTION_LENGTH}
                {remaining < 100 ? "（快到上限了）" : ""}
              </span>
              <span>提交后家长可以在「建议」页统一查看和导出</span>
            </div>

            {error ? (
              <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" data-testid="suggest-error" role="alert">
                {error}
              </p>
            ) : null}
            {done ? (
              <p className="ec-pop mt-3 rounded-xl bg-[#e8f7ee] p-3 text-sm text-[#166534]" data-testid="suggest-done">
                {isChild ? "收到啦，谢谢你！🌟" : "收到啦，谢谢！已记到建议列表里。"}
              </p>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="ec-btn ec-btn-ghost" onClick={() => setOpen(false)}>
                取消
              </button>
              <button
                type="button"
                data-testid="suggest-submit"
                className="ec-btn ec-btn-primary"
                onClick={() => void submit()}
                disabled={busy || content.trim().length === 0}
              >
                {busy ? "提交中…" : isChild ? "✉️ 发送给爸爸妈妈" : "提交建议"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
