import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { attempts, chatMessages, chatSessions, practiceSessions } from "@/db/schema";

export function startOfToday(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface DailyUsage {
  userId: string;
  minutes: number;
  limitMinutes: number;
  remainingMinutes: number;
  exceeded: boolean;
  attemptCount: number;
  chatTurnCount: number;
}

export async function getDailyUsage(userId: string, limitMinutes: number): Promise<DailyUsage> {
  const db = getDb();
  const since = startOfToday().toISOString();

  const [minutesRow] = await db
    .select({ minutes: sql<number>`coalesce(sum(${practiceSessions.minutes}), 0)` })
    .from(practiceSessions)
    .where(and(eq(practiceSessions.userId, userId), gte(practiceSessions.startedAt, since)));

  const [attemptRow] = await db
    .select({ c: sql<number>`count(*)` })
    .from(attempts)
    .where(and(eq(attempts.userId, userId), gte(attempts.createdAt, since)));

  const [turnRow] = await db
    .select({ c: sql<number>`count(*)` })
    .from(chatMessages)
    .innerJoin(chatSessions, eq(chatSessions.id, chatMessages.chatSessionId))
    .where(
      and(
        eq(chatSessions.userId, userId),
        eq(chatMessages.role, "user"),
        gte(chatMessages.createdAt, since),
      ),
    );

  const minutes = Math.round(Number(minutesRow?.minutes ?? 0) * 10) / 10;
  const remaining = Math.max(0, Math.round((limitMinutes - minutes) * 10) / 10);
  return {
    userId,
    minutes,
    limitMinutes,
    remainingMinutes: remaining,
    exceeded: minutes >= limitMinutes,
    attemptCount: Number(attemptRow?.c ?? 0),
    chatTurnCount: Number(turnRow?.c ?? 0),
  };
}

/** 记账本次练习时长（用于 daily_limit_minutes 与家长面板统计）。 */
export async function recordPracticeTime(params: {
  userId: string;
  kind: "pronounce" | "chat" | "review" | "blindtest";
  id: string;
  minutes: number;
  itemCount: number;
  startedAt?: string;
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const startedAt = params.startedAt ?? now;
  const minutes = Math.max(0, Math.min(120, params.minutes));
  await db
    .insert(practiceSessions)
    .values({
      id: `ps_${params.kind}_${params.id}`.slice(0, 60),
      userId: params.userId,
      kind: params.kind,
      startedAt,
      endedAt: now,
      minutes: Math.round(minutes * 1000) / 1000,
      itemCount: params.itemCount,
    })
    .onConflictDoUpdate({
      target: practiceSessions.id,
      set: {
        endedAt: now,
        minutes: sql`${practiceSessions.minutes} + ${Math.round(minutes * 1000) / 1000}`,
        itemCount: sql`${practiceSessions.itemCount} + ${params.itemCount}`,
      },
    });
}
