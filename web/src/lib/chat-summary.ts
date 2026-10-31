/**
 * 对话结束时的评价汇总（task-74 ③）：从该会话 `chat_messages.pron_json` 聚合，
 * 写入 `chat_sessions.summary_json`，供历史列表/详情回溯。
 *
 * 只存"有评分"的轮次（后台评分失败的轮次不计入 avg，但计入 turns）。
 */
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages } from "@/db/schema";
import type { ChatPron } from "./chat-pronunciation";

export interface SessionSummary {
  turns: number;
  scenario?: string;
  ended_by?: "user" | "assistant";
  /** 平均分（保留 1 位小数；没有评分则为 null） */
  avg_pron: number | null;
  avg_accuracy: number | null;
  avg_fluency: number | null;
  avg_completeness: number | null;
  /** 本会话最弱的 1–2 个音（非 IPA 名字） */
  weak_phonemes: { label: string; score: number }[];
  /** 有评分的轮次数 */
  scored_turns: number;
}

function parsePron(raw: string | null): ChatPron | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChatPron;
  } catch {
    return null;
  }
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
}

/** 计算会话评价汇总（只读；不写库） */
export async function computeSessionSummary(sessionId: string, scenarioId?: string | null): Promise<SessionSummary> {
  const db = getDb();
  const rows = await db
    .select({ role: chatMessages.role, pronJson: chatMessages.pronJson })
    .from(chatMessages)
    .where(eq(chatMessages.chatSessionId, sessionId))
    .orderBy(asc(chatMessages.createdAt));

  const prons = rows.map((r) => parsePron(r.pronJson)).filter((p): p is ChatPron => Boolean(p));
  const weak = new Map<string, number>();
  for (const p of prons) {
    for (const w of p.weak_phonemes ?? []) {
      if (!w.label) continue;
      const score = typeof w.score === "number" ? w.score : 0;
      weak.set(w.label, Math.min(weak.get(w.label) ?? 100, score));
    }
  }
  const weakPhonemes = [...weak.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2)
    .map(([label, score]) => ({ label, score: Math.round(score * 10) / 10 }));

  return {
    turns: rows.filter((r) => r.role === "user").length,
    ...(scenarioId ? { scenario: scenarioId } : {}),
    avg_pron: avg(prons.map((p) => p.pron).filter((n): n is number => typeof n === "number")),
    avg_accuracy: avg(prons.map((p) => p.accuracy).filter((n): n is number => typeof n === "number")),
    avg_fluency: avg(prons.map((p) => p.fluency).filter((n): n is number => typeof n === "number")),
    avg_completeness: avg(prons.map((p) => p.completeness).filter((n): n is number => typeof n === "number")),
    weak_phonemes: weakPhonemes,
    scored_turns: prons.length,
  };
}

/** 解析 summary_json（旧会话可能只有 turns/scenario，容错） */
export function parseSessionSummary(raw: string | null): (SessionSummary & { ended_by?: string }) | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SessionSummary> & { ended_by?: string };
    return typeof v === "object" && v ? (v as SessionSummary & { ended_by?: string }) : null;
  } catch {
    return null;
  }
}
