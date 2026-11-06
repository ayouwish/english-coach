/**
 * 家庭成本台账（task-101）：voice 返回原始 usage，web 按 env 单价换算成金额并记账。
 *
 * 约定：
 *  - 金额用**微元整数**（1 元 = 1_000_000 micro_cny），避免浮点误差；
 *  - 单价全部走 env（带默认值）；voice 没给 usage → **不记账、不编造**；
 *  - 记账失败只 console.warn，**绝不影响主流程**。
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { costEvents } from "@/db/schema";

export const MICRO_PER_CNY = 1_000_000;

/** 读 env 单价（元）；非法/缺失用默认值 */
function envPrice(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function priceTable() {
  return {
    llmInputPer1M: envPrice("COST_LLM_INPUT_CNY_PER_1M", 1.0),
    llmOutputPer1M: envPrice("COST_LLM_OUTPUT_CNY_PER_1M", 2.0),
    imagePerImage: envPrice("COST_IMAGE_CNY_PER_IMAGE", 0.1),
    ttsPer1KChars: envPrice("COST_TTS_CNY_PER_1K_CHARS", 0.02),
    asrPerMinute: envPrice("COST_ASR_CNY_PER_MINUTE", 0.006),
  };
}

export interface LlmUnits {
  llm_prompt_tokens?: number | null;
  llm_completion_tokens?: number | null;
  llm_total_tokens?: number | null;
}
export interface ImageUnits {
  images?: number | null;
  size?: string | null;
  model?: string | null;
}
export interface TtsUnits {
  tts_chars?: number | null;
}
export interface AsrUnits {
  asr_seconds?: number | null;
}

export type CostKind = "llm" | "image" | "tts" | "asr";

export interface CostContext {
  familyId: string;
  userId: string | null;
  scene?: string;
  meta?: Record<string, unknown>;
}

function micro(cny: number): number {
  return Math.max(0, Math.round(cny * MICRO_PER_CNY));
}

/** 计算金额（微元）；usage 全缺失 → null（不记账） */
export function computeCostMicro(
  kind: CostKind,
  units: unknown,
): number | null {
  const p = priceTable();
  if (!units || typeof units !== "object") return null;
  if (kind === "llm") {
    const u = units as LlmUnits;
    const prompt = Number(u.llm_prompt_tokens ?? 0);
    const completion = Number(u.llm_completion_tokens ?? 0);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || (prompt <= 0 && completion <= 0)) return null;
    return micro((prompt / 1_000_000) * p.llmInputPer1M + (completion / 1_000_000) * p.llmOutputPer1M);
  }
  if (kind === "image") {
    const u = units as ImageUnits;
    const images = Number(u.images ?? 0);
    if (!Number.isFinite(images) || images <= 0) return null;
    return micro(images * p.imagePerImage);
  }
  if (kind === "tts") {
    const u = units as TtsUnits;
    const chars = Number(u.tts_chars ?? 0);
    if (!Number.isFinite(chars) || chars <= 0) return null;
    return micro((chars / 1000) * p.ttsPer1KChars);
  }
  if (kind === "asr") {
    const u = units as AsrUnits;
    const seconds = Number(u.asr_seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return micro((seconds / 60) * p.asrPerMinute);
  }
  return null;
}

/** 记一笔成本（失败只 warn，不抛出） */
export async function logCost(
  ctx: CostContext,
  entry: {
    kind: CostKind;
    provider?: string | null;
    model?: string | null;
    units: unknown;
    scene?: string | null;
    meta?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    const cost = computeCostMicro(entry.kind, entry.units);
    if (cost === null) return; // usage 缺失 → 不记账
    await getDb().insert(costEvents).values({
      id: `ce_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      familyId: ctx.familyId,
      userId: ctx.userId,
      kind: entry.kind,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      unitsJson: JSON.stringify(entry.units ?? {}),
      costMicroCny: cost,
      metaJson: JSON.stringify({ scene: entry.scene ?? ctx.scene ?? null, ...(ctx.meta ?? {}), ...(entry.meta ?? {}) }),
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[cost] 记账失败（不影响主流程）：${(err as Error).message}`);
  }
}

export interface CostSummary {
  month: string;
  family_id: string;
  total_cny: number;
  by_kind: Record<string, number>;
  by_user: { user_id: string | null; display_name: string | null; cny: number; count: number }[];
  by_day: { date: string; cny: number }[];
  prices: ReturnType<typeof priceTable>;
}

/** 月度汇总（仅本家庭；micro → 元 2 位） */
export async function costSummary(familyId: string, month?: string | null): Promise<CostSummary> {
  const now = new Date();
  const m = /^\d{4}-\d{2}$/.test(month ?? "") ? (month as string) : now.toISOString().slice(0, 7);
  const start = `${m}-01T00:00:00.000Z`;
  const [y, mo] = m.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1)).toISOString();
  const db = getDb();
  const rows = await db
    .select()
    .from(costEvents)
    .where(and(eq(costEvents.familyId, familyId), gte(costEvents.createdAt, start), lt(costEvents.createdAt, nextMonth)))
    .orderBy(desc(costEvents.createdAt))
    .limit(5000);

  const byKindMicro: Record<string, number> = {};
  const byUserMicro = new Map<string | null, { micro: number; count: number }>();
  const byDayMicro = new Map<string, number>();
  let totalMicro = 0;
  for (const r of rows) {
    totalMicro += r.costMicroCny;
    byKindMicro[r.kind] = (byKindMicro[r.kind] ?? 0) + r.costMicroCny;
    const u = byUserMicro.get(r.userId) ?? { micro: 0, count: 0 };
    u.micro += r.costMicroCny;
    u.count += 1;
    byUserMicro.set(r.userId, u);
    const day = r.createdAt.slice(0, 10);
    byDayMicro.set(day, (byDayMicro.get(day) ?? 0) + r.costMicroCny);
  }
  const userIds = [...byUserMicro.keys()].filter((x): x is string => Boolean(x));
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const { users } = await import("@/db/schema");
    const userRows = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(sql`${users.id} in (${sql.join(userIds.map((i) => sql`${i}`), sql`, `)})`);
    for (const u of userRows) names.set(u.id, u.displayName);
  }
  const toCny = (micro: number) => Math.round(micro) / MICRO_PER_CNY;
  return {
    month: m,
    family_id: familyId,
    total_cny: toCny(totalMicro),
    by_kind: Object.fromEntries(Object.entries(byKindMicro).map(([k, v]) => [k, toCny(v)])),
    by_user: [...byUserMicro.entries()]
      .map(([userId, v]) => ({ user_id: userId, display_name: userId ? names.get(userId) ?? null : null, cny: toCny(v.micro), count: v.count }))
      .sort((a, b) => b.cny - a.cny),
    by_day: [...byDayMicro.entries()].map(([date, micro]) => ({ date, cny: toCny(micro) })).sort((a, b) => a.date.localeCompare(b.date)),
    prices: priceTable(),
  };
}
