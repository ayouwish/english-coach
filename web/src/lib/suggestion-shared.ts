/**
 * 「提建议」的**客户端安全**部分（无 DB 依赖）：枚举、文案、校验、Markdown 导出。
 * 服务端实现见 `src/lib/suggestions.ts`（那里才 import DB）。
 */
import { stripIpaGlyphs } from "./child-safe";

export const SUGGESTION_CATEGORIES = ["experience", "content", "feature", "bug", "other"] as const;
export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

/** 儿童版只给三类（其余归到「其他」），文案口语化 */
export const CHILD_SUGGESTION_CATEGORIES = ["experience", "content", "other"] as const;

export const SUGGESTION_STATUSES = ["open", "read", "resolved"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const MAX_SUGGESTION_LENGTH = 2000;

export const CATEGORY_LABELS: Record<SuggestionCategory, string> = {
  experience: "体验问题",
  content: "内容建议",
  feature: "新功能想法",
  bug: "程序出错",
  other: "其他",
};

export const CATEGORY_LABELS_CHILD: Record<SuggestionCategory, string> = {
  experience: "用起来哪里不顺手",
  content: "想读 / 想聊的内容",
  feature: "想要的新功能",
  bug: "哪里出错了",
  other: "其他想法",
};

export const STATUS_LABELS: Record<SuggestionStatus, string> = {
  open: "未读",
  read: "已读",
  resolved: "已解决",
};

export function isSuggestionCategory(v: unknown): v is SuggestionCategory {
  return typeof v === "string" && (SUGGESTION_CATEGORIES as readonly string[]).includes(v);
}

export function isSuggestionStatus(v: unknown): v is SuggestionStatus {
  return typeof v === "string" && (SUGGESTION_STATUSES as readonly string[]).includes(v);
}

export interface SuggestionView {
  id: string;
  user_role: string | null;
  page: string | null;
  category: string | null;
  content: string;
  status: string;
  created_at: string;
  handled_at: string | null;
  context: Record<string, unknown> | null;
}

export class SuggestionValidationError extends Error {}

/** 校验 + 归一化正文；儿童提交的正文剥掉 IPA 字形（硬约束：儿童可见载荷零 IPA） */
export function normalizeSuggestionContent(raw: unknown, isChild: boolean): string {
  const text = typeof raw === "string" ? raw.replace(/\r\n/g, "\n").trim() : "";
  if (!text) throw new SuggestionValidationError("请先写点什么再提交");
  if (text.length > MAX_SUGGESTION_LENGTH) {
    throw new SuggestionValidationError(`建议最多 ${MAX_SUGGESTION_LENGTH} 字（当前 ${text.length} 字）`);
  }
  // 儿童：剥掉 IPA 字形后顺手收拾一下留下的多余空格（"还有  和" → "还有 和"）
  return isChild ? stripIpaGlyphs(text).replace(/[ \t]{2,}/g, " ").trim() : text;
}

/** 只允许站内路径作为 page */
export function sanitizePage(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || !s.startsWith("/") || s.length > 120) return null;
  return s;
}

export function pickPage(referer: string | null, clientPage: unknown): string | null {
  const fromClient = sanitizePage(typeof clientPage === "string" ? clientPage : null);
  if (fromClient) return fromClient;
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return sanitizePage(u.pathname + (u.search || ""));
  } catch {
    return null;
  }
}

export function sanitizeContext(input: {
  userAgent?: string | null;
  voiceMode?: string | null;
  viewport?: unknown;
}): Record<string, unknown> {
  const viewport =
    input.viewport && typeof input.viewport === "object"
      ? {
          w: Number((input.viewport as { w?: unknown }).w) || null,
          h: Number((input.viewport as { h?: unknown }).h) || null,
        }
      : null;
  return {
    ua: (input.userAgent ?? "").slice(0, 300) || null,
    app_version: "0.1.0",
    voice_mode: input.voiceMode ?? null,
    viewport,
  };
}

/** 导出为 Markdown（方便直接贴给 AI/开发者继续优化） */
export function suggestionsToMarkdown(
  items: SuggestionView[],
  meta: { generatedAt: string; counts: Record<string, number>; total: number },
): string {
  const lines: string[] = [];
  lines.push("# English Coach · 建议汇总");
  lines.push("");
  lines.push(`- 导出时间：${meta.generatedAt}`);
  lines.push(
    `- 共 ${meta.total} 条（未读 ${meta.counts.open ?? 0} / 已读 ${meta.counts.read ?? 0} / 已解决 ${
      meta.counts.resolved ?? 0
    }）`,
  );
  lines.push("");
  if (items.length === 0) lines.push("（还没有建议）");
  for (const it of items) {
    const role = it.user_role === "child" ? "孩子" : it.user_role === "parent" ? "家长" : "未知";
    const cat = it.category && isSuggestionCategory(it.category) ? CATEGORY_LABELS[it.category] : (it.category ?? "未分类");
    const st = isSuggestionStatus(it.status) ? STATUS_LABELS[it.status] : it.status;
    lines.push(`## ${it.created_at.slice(0, 16).replace("T", " ")} · ${role} · ${cat} · ${st}`);
    lines.push("");
    if (it.page) lines.push(`页面：\`${it.page}\``);
    if (it.context) {
      const ctx = it.context as { voice_mode?: string; viewport?: { w?: number; h?: number } | null };
      const bits = [
        ctx.voice_mode ? `voice=${ctx.voice_mode}` : null,
        ctx.viewport?.w ? `viewport=${ctx.viewport.w}x${ctx.viewport.h}` : null,
      ].filter(Boolean);
      if (bits.length) lines.push(`上下文：${bits.join(" · ")}`);
    }
    lines.push("");
    lines.push(it.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}
