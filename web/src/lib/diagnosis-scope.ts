/**
 * 作用域诊断（task-71 A）：单句 / 连读批次 / 最近 / 全部 分开统计。
 *
 * 用户原话：「单句/连读，任何地方的发音诊断，只诊断那一段内容。和总体的发音诊断要分开。
 * 不然每次点进去不知道最近的问题是啥」。
 *
 * - `all`    ：沿用 `buildDiagnosis()`（全量累计，结构不变）
 * - `recent` ：最近 N 天（默认 7）或最近 limit 条 attempt
 * - `attempt`：只诊断指定 attempt（必须属于本人）
 * - `batch`  ：连读这一批 attempt（≤20，全部属于本人）
 *
 * **只返回范围内真正出现过的音素**；范围数据来自 `phoneme_scores` join `attempts`（强制 user_id 过滤，防越权）。
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb, getSqlite } from "@/db";
import { attempts } from "@/db/schema";
import type { SessionUser } from "./auth";
import { getArticulation } from "./articulation";
import { childSafeDeep } from "./child-safe";
import {
  dedupeContrasts,
  dedupeStrings,
  pairKey,
  statusOf,
  trendOf,
  type DiagnosisItem,
  type DiagnosisPayload,
} from "./diagnosis";
import { WORD_LEVEL_KEY } from "./attempt-service";

export type DiagnosisScope = "all" | "recent" | "attempt" | "batch";

export const MAX_BATCH_IDS = 20;
export const RECENT_DEFAULT_DAYS = 7;

export interface ScopedRange {
  scope: DiagnosisScope;
  /** 参与统计的 attempt 数 */
  attempt_count: number;
  /** 最近的窗口（days/limit），仅 recent 有 */
  days?: number;
  limit?: number;
  /** attempt/batch 的 id（调试用，非敏感） */
  attempt_ids?: string[];
}

export interface ScopedDiagnosisPayload extends DiagnosisPayload {
  scope: DiagnosisScope;
  range: ScopedRange;
}

/** 非法/越权统一用这个（不区分"不存在"与"别人的"，避免泄漏） */
export class DiagnosisScopeError extends Error {
  code: "invalid_scope" | "not_found" | "forbidden";
  constructor(code: DiagnosisScopeError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "DiagnosisScopeError";
  }
}

interface ScopeOptions {
  scope?: DiagnosisScope;
  attemptId?: string | null;
  attemptIds?: string[];
  days?: number;
  limit?: number;
}

function practiceCount(sentencePhoneme: string): number {
  const sqlite = getSqlite();
  return (sqlite.prepare("SELECT COUNT(*) AS c FROM sentences WHERE focus_phonemes LIKE ?").get(`%"${sentencePhoneme}"%`) as { c: number } | undefined)?.c ?? 0;
}

/** 校验 attempt ids 属于本人（不存在/别人的统一 404） */
async function assertOwnedAttempts(userId: string, ids: string[]): Promise<Record<string, string>> {
  const db = getDb();
  const rows = await db
    .select({ id: attempts.id, createdAt: attempts.createdAt })
    .from(attempts)
    .where(and(eq(attempts.userId, userId), inArray(attempts.id, ids)));
  const found = new Map(rows.map((r) => [r.id, r.createdAt]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw new DiagnosisScopeError("not_found", "练习记录不存在或不属于当前账号");
  return Object.fromEntries(found);
}

/** 最近 N 天的 attempt ids（或最近 limit 条） */
async function recentAttemptIds(userId: string, days: number, limit?: number): Promise<{ ids: string[]; attemptCount: number }> {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const query = db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.userId, userId), gte(attempts.createdAt, since)))
    .orderBy(desc(attempts.createdAt));
  const rows = limit && limit > 0 ? await query.limit(limit) : await query;
  return { ids: rows.map((r) => r.id), attemptCount: rows.length };
}

/** 范围内的音素统计（只含有数据的音素） */
async function aggregateScoped(user: SessionUser, attemptIds: string[], forChild: boolean): Promise<DiagnosisItem[]> {
  if (attemptIds.length === 0) return [];
  const sqlite = getSqlite();
  const placeholders = attemptIds.map(() => "?").join(",");
  // 强制 user_id：即使调用方传了别人的 id，也拿不到任何行
  const rows = sqlite
    .prepare(
      `SELECT attempt_id, phoneme, word, score, created_at FROM phoneme_scores
       WHERE user_id = ? AND attempt_id IN (${placeholders}) AND phoneme != ?`,
    )
    .all(user.id, ...attemptIds, WORD_LEVEL_KEY) as {
    attempt_id: string;
    phoneme: string;
    word: string;
    score: number | null;
    created_at: string;
  }[];
  if (rows.length === 0) return [];

  const byPhoneme = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byPhoneme.get(r.phoneme) ?? [];
    list.push(r);
    byPhoneme.set(r.phoneme, list);
  }

  const items: DiagnosisItem[] = [];
  for (const [ipa, list] of byPhoneme) {
    const scored = list.filter((r) => typeof r.score === "number") as (typeof list[number] & { score: number })[];
    if (scored.length === 0) continue;
    const sortedByTime = [...scored].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    const points = sortedByTime.map((r) => r.score);
    const avg = Math.round((points.reduce((a, b) => a + b, 0) / points.length) * 10) / 10;
    const attemptSet = new Set(list.map((r) => r.attempt_id));
    // 范围内最低的 3 个词（按词取最低分）
    const byWord = new Map<string, number>();
    for (const r of scored) {
      const w = r.word?.trim();
      if (!w) continue;
      byWord.set(w, Math.min(byWord.get(w) ?? 100, r.score));
    }
    const errorWords = [...byWord.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3)
      .map(([word, score]) => ({ word, score: Math.round(score * 10) / 10 }));
    const art = getArticulation(ipa);
    items.push({
      phoneme: forChild ? "" : ipa,
      child_label: art?.childLabel ?? ipa,
      focus_token: forChild ? (art?.childLabel ?? ipa) : ipa,
      status: statusOf(avg),
      attempts: attemptSet.size,
      avg_score: avg,
      last_score: Math.round(points[points.length - 1] * 10) / 10,
      best_score: Math.round(Math.max(...points) * 10) / 10,
      trend: trendOf(points),
      error_words: errorWords,
      practice_count: practiceCount(ipa),
      tip_zh: art?.tipZh ?? "",
      tip_child_zh: art?.tipChildZh ?? "",
      common_errors: dedupeStrings(art?.commonErrorsZh ?? []),
      examples: dedupeStrings(art?.examples ?? []),
      contrasts: (art?.contrasts ?? []).map((c) => ({
        phoneme: forChild ? "" : c.phoneme,
        pair: c.pair as [string, string],
        note: forChild ? childSafeDeep(c.noteZh, "diagnosis-note") : c.noteZh,
      })),
    });
  }

  // 只保留范围内真正出现过的音素（上面已保证）；排序弱→强
  const order = { weak: 0, watch: 1, ok: 2 } as const;
  items.sort((a, b) => order[a.status] - order[b.status] || a.avg_score - b.avg_score);
  dedupeContrasts(items);
  return items;
}

function scopedSummary(scope: DiagnosisScope, items: DiagnosisItem[], forChild: boolean, attemptCount: number): string {
  const nameOf = (i: DiagnosisItem) => (forChild ? `「${i.child_label}」` : `/${i.phoneme}/`);
  if (items.length === 0) {
    if (scope === "attempt") return "这一句没有发现明显的发音问题，读得不错！";
    if (scope === "batch") return "这一批没有发现明显的发音问题，很棒！";
    return `最近 ${RECENT_DEFAULT_DAYS} 天还没有练习记录，跟读一句就有了。`;
  }
  const worst = items.slice(0, 2).map(nameOf).join("、");
  if (scope === "attempt") {
    const weak = items.filter((i) => i.status !== "ok");
    if (weak.length === 0) return "这一句读得不错，音都比较稳。";
    return `这一句最需要练的是${weak.slice(0, 2).map(nameOf).join("、")}，先慢一点读。`;
  }
  if (scope === "batch") {
    const weak = items.filter((i) => i.status !== "ok");
    if (weak.length === 0) return "这一批读得不错，音都比较稳。";
    return `这一批（${attemptCount} 句）最需要练的是${weak.slice(0, 2).map(nameOf).join("、")}。`;
  }
  return forChild ? `最近最需要练的是${worst}，先从这里开始。` : `最近最需要练的是${worst}，建议先做强化练习。`;
}

/**
 * 作用域诊断（**含 IPA**；对外请用 buildScopedDiagnosis 剥 IPA）。
 */
export async function buildScopedDiagnosisRaw(user: SessionUser, opts: ScopeOptions = {}): Promise<ScopedDiagnosisPayload> {
  return buildScopedInner(user, opts, false);
}

async function buildScopedInner(
  user: SessionUser,
  opts: ScopeOptions,
  forChild: boolean,
): Promise<ScopedDiagnosisPayload> {
  const scope: DiagnosisScope = opts.scope ?? "all";

  if (scope === "all") {
    // 全量累计：儿童走 buildDiagnosis（已剥离 IPA），成人走 raw
    const base = forChild ? await import("./diagnosis").then((m) => m.buildDiagnosis(user)) : await import("./diagnosis").then((m) => m.buildDiagnosisRaw(user));
    return {
      ...base,
      scope,
      range: { scope, attempt_count: base.counted_phonemes },
    };
  }

  let ids: string[] = [];
  let range: ScopedRange;
  if (scope === "attempt") {
    const id = (opts.attemptId ?? "").trim();
    if (!id) throw new DiagnosisScopeError("invalid_scope", "scope=attempt 需要 attempt_id");
    await assertOwnedAttempts(user.id, [id]);
    ids = [id];
    range = { scope, attempt_count: 1, attempt_ids: ids };
  } else if (scope === "batch") {
    const raw = (opts.attemptIds ?? []).map((s) => s.trim()).filter(Boolean);
    const unique = [...new Set(raw)];
    if (unique.length === 0) throw new DiagnosisScopeError("invalid_scope", "scope=batch 需要 attempt_ids");
    if (unique.length > MAX_BATCH_IDS) throw new DiagnosisScopeError("invalid_scope", `一次最多 ${MAX_BATCH_IDS} 条`);
    await assertOwnedAttempts(user.id, unique);
    ids = unique;
    range = { scope, attempt_count: ids.length, attempt_ids: ids };
  } else {
    const days = opts.days && opts.days > 0 ? Math.min(Math.floor(opts.days), 365) : RECENT_DEFAULT_DAYS;
    const limit = opts.limit && opts.limit > 0 ? Math.min(Math.floor(opts.limit), 200) : undefined;
    const recent = await recentAttemptIds(user.id, days, limit);
    ids = recent.ids;
    range = { scope: "recent", attempt_count: recent.attemptCount, days, limit };
  }

  const items = await aggregateScoped(user, ids, forChild);
  const weak = items.filter((i) => i.status === "weak");
  const watch = items.filter((i) => i.status === "watch");
  const ok = items.filter((i) => i.status === "ok");
  const payload: ScopedDiagnosisPayload = {
    generated_at: new Date().toISOString(),
    min_samples: 1, // 作用域统计不再要求 ≥2 次（单句只有 1 次）
    total_phonemes: items.length,
    counted_phonemes: items.length,
    counts: { weak: weak.length, watch: watch.length, ok: ok.length },
    summary_zh: scopedSummary(scope, items, forChild, range.attempt_count),
    focus_phonemes: [...weak, ...watch].slice(0, 3).map((i) => i.focus_token),
    items,
    scope,
    range,
  };
  return payload;
}

/** 对外 API：儿童请求自动剥 IPA（items 的 phoneme 为空串、summary 用 childLabel 口吻） */
export async function buildScopedDiagnosis(user: SessionUser, opts: ScopeOptions = {}): Promise<ScopedDiagnosisPayload> {
  if (!user.isChild) return buildScopedInner(user, opts, false);
  const payload = await buildScopedInner(user, opts, true);
  return childSafeDeep(payload, "diagnosis") as ScopedDiagnosisPayload;
}

/** 供 UI 判断：这批/这句里有没有问题 */
export function hasIssues(payload: ScopedDiagnosisPayload): boolean {
  return payload.items.some((i) => i.status !== "ok");
}

export { pairKey };
