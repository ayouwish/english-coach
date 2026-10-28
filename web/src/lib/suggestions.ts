/**
 * 「提建议」的**服务端**实现（DB 读写）。客户端安全的枚举/校验见 `suggestion-shared.ts`。
 *
 * 设计要点：
 *  - 儿童也能提交，但**儿童可见载荷零 IPA**：儿童正文入库前剥掉特征 IPA 字形
 *    （家长正文原样保存，家长要看真实内容）。
 *  - 长度/枚举**服务端再校验一遍**；`page`/`user_role`/`context` 由服务端采集。
 */
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { suggestions } from "@/db/schema";
import type { SessionUser } from "./auth";
import {
  isSuggestionStatus,
  type SuggestionCategory,
  type SuggestionStatus,
  type SuggestionView,
} from "./suggestion-shared";

export * from "./suggestion-shared";

export async function createSuggestion(
  user: SessionUser,
  input: { category: SuggestionCategory; content: string; page: string | null; context: Record<string, unknown> },
): Promise<string> {
  const db = getDb();
  const id = `sug_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db.insert(suggestions).values({
    id,
    userId: user.id,
    userRole: user.role,
    page: input.page,
    category: input.category,
    content: input.content,
    contextJson: JSON.stringify(input.context),
    status: "open",
    createdAt: new Date().toISOString(),
    handledAt: null,
  });
  return id;
}

export async function listSuggestions(opts: {
  status?: string | null;
  limit?: number;
  offset?: number;
}): Promise<{ items: SuggestionView[]; counts: Record<string, number>; total: number }> {
  const db = getDb();
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const offset = Math.max(0, opts.offset ?? 0);
  const where = isSuggestionStatus(opts.status) ? eq(suggestions.status, opts.status) : undefined;

  const rows = await db
    .select()
    .from(suggestions)
    .where(where)
    .orderBy(desc(suggestions.createdAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ status: suggestions.status, c: sql<number>`count(*)` })
    .from(suggestions)
    .groupBy(suggestions.status);
  const counts: Record<string, number> = { open: 0, read: 0, resolved: 0 };
  let total = 0;
  for (const r of countRows) {
    counts[r.status] = Number(r.c);
    total += Number(r.c);
  }

  return {
    items: rows.map((r) => ({
      id: r.id,
      user_role: r.userRole,
      page: r.page,
      category: r.category,
      content: r.content,
      status: r.status,
      created_at: r.createdAt,
      handled_at: r.handledAt,
      context: safeJson(r.contextJson),
    })),
    counts,
    total,
  };
}

export async function setSuggestionStatus(id: string, status: SuggestionStatus): Promise<boolean> {
  const db = getDb();
  const existing = await db.select({ id: suggestions.id }).from(suggestions).where(eq(suggestions.id, id)).limit(1);
  if (existing.length === 0) return false;
  await db
    .update(suggestions)
    .set({ status, handledAt: status === "open" ? null : new Date().toISOString() })
    .where(eq(suggestions.id, id));
  return true;
}

function safeJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
