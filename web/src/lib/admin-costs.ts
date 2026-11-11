/**
 * 管理员成本看板（task-108）：**跨家庭**聚合 cost_events。
 * 仅管理员家庭使用（requireAdminFamily 在路由层强制）。
 */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { costEvents, families, users } from "@/db/schema";

export interface AdminCosts {
  month: string;
  totals: {
    cost_cny: number;
    llm_prompt_tokens: number;
    llm_completion_tokens: number;
    llm_total_tokens: number;
    image_count: number;
    tts_chars: number;
    asr_seconds: number;
    calls: number;
  };
  by_family: {
    family_id: string;
    family_name: string;
    members: number;
    cost_cny: number;
    llm_total_tokens: number;
    image_count: number;
    tts_chars: number;
    asr_seconds: number;
    calls: number;
  }[];
  by_day: { date: string; cost_cny: number }[];
  recent_events: {
    id: string;
    created_at: string;
    family_id: string;
    family_name: string;
    user_id: string | null;
    display_name: string | null;
    kind: string;
    provider: string | null;
    model: string | null;
    cost_cny: number;
    units: Record<string, unknown> | null;
  }[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function parseUnits(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const microToCny = (m: number) => Math.round(m) / 1_000_000;

export async function buildAdminCosts(month?: string | null): Promise<AdminCosts> {
  const now = new Date();
  const m = /^\d{4}-\d{2}$/.test(month ?? "") ? (month as string) : now.toISOString().slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  const start = `${m}-01T00:00:00.000Z`;
  const next = new Date(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1)).toISOString();
  const db = getDb();
  const rows = await db
    .select({ ev: costEvents, familyName: families.name })
    .from(costEvents)
    .leftJoin(families, eq(families.id, costEvents.familyId))
    .where(and(gte(costEvents.createdAt, start), lt(costEvents.createdAt, next)))
    .orderBy(desc(costEvents.createdAt))
    .limit(5000);

  const familyRows = await db.select({ id: families.id, name: families.name }).from(families);
  const memberCounts = new Map<string, number>();
  for (const u of await db.select({ familyId: users.familyId }).from(users)) {
    memberCounts.set(u.familyId, (memberCounts.get(u.familyId) ?? 0) + 1);
  }
  const userIds = [...new Set(rows.map((r) => r.ev.userId).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    for (const u of await db.select({ id: users.id, displayName: users.displayName }).from(users)) names.set(u.id, u.displayName);
  }

  const totals = { cost_cny: 0, llm_prompt_tokens: 0, llm_completion_tokens: 0, llm_total_tokens: 0, image_count: 0, tts_chars: 0, asr_seconds: 0, calls: 0 };
  const byFamily = new Map<string, AdminCosts["by_family"][number]>();
  const byDay = new Map<string, number>();
  const recent: AdminCosts["recent_events"] = [];
  for (const { ev, familyName } of rows) {
    const units = parseUnits(ev.unitsJson) ?? {};
    const prompt = num(units.llm_prompt_tokens);
    const completion = num(units.llm_completion_tokens);
    const totalTok = num(units.llm_total_tokens) || prompt + completion;
    const images = num(units.images);
    const tts = num(units.tts_chars);
    const asr = num(units.asr_seconds);
    const cny = microToCny(ev.costMicroCny);
    totals.cost_cny += cny;
    totals.llm_prompt_tokens += prompt;
    totals.llm_completion_tokens += completion;
    totals.llm_total_tokens += totalTok;
    totals.image_count += images;
    totals.tts_chars += tts;
    totals.asr_seconds += asr;
    totals.calls += 1;
    const fam = byFamily.get(ev.familyId) ?? {
      family_id: ev.familyId,
      family_name: familyName ?? familyRows.find((f) => f.id === ev.familyId)?.name ?? ev.familyId,
      members: memberCounts.get(ev.familyId) ?? 0,
      cost_cny: 0,
      llm_total_tokens: 0,
      image_count: 0,
      tts_chars: 0,
      asr_seconds: 0,
      calls: 0,
    };
    fam.cost_cny += cny;
    fam.llm_total_tokens += totalTok;
    fam.image_count += images;
    fam.tts_chars += tts;
    fam.asr_seconds += asr;
    fam.calls += 1;
    byFamily.set(ev.familyId, fam);
    const day = ev.createdAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + cny);
    if (recent.length < 50) {
      recent.push({
        id: ev.id,
        created_at: ev.createdAt,
        family_id: ev.familyId,
        family_name: fam.family_name,
        user_id: ev.userId,
        display_name: ev.userId ? names.get(ev.userId) ?? null : null,
        kind: ev.kind,
        provider: ev.provider,
        model: ev.model,
        cost_cny: cny,
        units,
      });
    }
  }
  const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  return {
    month: m,
    totals: {
      cost_cny: round6(totals.cost_cny),
      llm_prompt_tokens: totals.llm_prompt_tokens,
      llm_completion_tokens: totals.llm_completion_tokens,
      llm_total_tokens: totals.llm_total_tokens,
      image_count: totals.image_count,
      tts_chars: totals.tts_chars,
      asr_seconds: Math.round(totals.asr_seconds * 100) / 100,
      calls: totals.calls,
    },
    by_family: [...byFamily.values()]
      .map((f) => ({ ...f, cost_cny: round6(f.cost_cny) }))
      .sort((a, b) => b.cost_cny - a.cost_cny),
    by_day: [...byDay.entries()].map(([date, c]) => ({ date, cost_cny: round6(c) })).sort((a, b) => a.date.localeCompare(b.date)),
    recent_events: recent,
  };
}
