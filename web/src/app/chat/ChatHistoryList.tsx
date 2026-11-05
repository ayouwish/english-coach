"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SwipeToDelete } from "@/components/SwipeToDelete";

export interface ChatHistoryItem {
  id: string;
  startedAt: string;
  scenarioTitle: string;
  turnCount: number;
  /** 非儿童才展示平均发音 */
  avgPron: number | null;
  hasAudio: boolean;
}

/**
 * 历史对话列表（task-74 ④）+ 左划删除。
 *
 * 列表本身仍是服务端渲染的内容结构（testid 与文案保持不变），
 * 这里只在外面套一层左划交互：向左拖动 → 露出「删除」→ 删掉自己的这次对话。
 */
export function ChatHistoryList({ items, isChild }: { items: ChatHistoryItem[]; isChild: boolean }) {
  const router = useRouter();
  const [list, setList] = useState(items);

  async function removeSession(id: string) {
    if (!window.confirm("确定删除这次对话吗？删除后无法恢复。")) {
      throw new Error("已取消");
    }
    const res = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `删除失败（HTTP ${res.status}）`);
    }
    setList((prev) => prev.filter((s) => s.id !== id));
    // 「最近一次对话」区块等在服务端渲染，刷新一次保持页面各处一致
    router.refresh();
  }

  if (list.length === 0) return null;

  return (
    <section className="ec-card" data-testid="chat-history-list">
      <h2 className="font-bold">📚 历史对话（{list.length} 次）</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">向左滑动可删除不想保留的记录</p>
      <ul className="mt-2 flex flex-col gap-1">
        {list.map((sess) => (
          <li key={sess.id}>
            <SwipeToDelete
              testId="chat-history-delete"
              label="删除"
              onDelete={() => removeSession(sess.id)}
              className="rounded-lg"
            >
              <Link
                href={`/chat/sessions/${sess.id}`}
                data-testid="chat-history-item"
                className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-sm hover:bg-[var(--ec-primary-soft)]"
              >
                <span className="text-xs text-[var(--ec-muted)]">
                  {new Date(sess.startedAt).toLocaleString("zh-CN")}
                </span>
                <span className="font-medium">{sess.scenarioTitle}</span>
                <span className="text-xs text-[var(--ec-muted)]">{sess.turnCount} 轮</span>
                {isChild ? (
                  <span className="text-xs text-[var(--ec-muted)]">聊完了</span>
                ) : sess.avgPron !== null && sess.avgPron !== undefined ? (
                  <span className="rounded-full bg-[#eef0f8] px-2 py-0.5 text-xs">平均发音 {sess.avgPron}</span>
                ) : null}
                {sess.hasAudio ? <span className="text-xs">🎧 有回放</span> : null}
              </Link>
            </SwipeToDelete>
          </li>
        ))}
      </ul>
    </section>
  );
}
