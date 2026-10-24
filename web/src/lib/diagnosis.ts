/**
 * 薄弱音素诊断（task-16 A）：把 `phoneme_mastery` 的历史数据聚合成"该练什么 + 为什么"。
 *
 * 规则（按契约与 task 要求）：
 *   - 只统计样本量 ≥2 的音素（1 次的噪声太大）
 *   - 分档：avg<65 weak / 65–80 watch / ≥80 ok
 *   - 每个音素带：近 3 次趋势方向、关联错误词（该音素得分最低的词）、可练句数
 *   - 排序：weak 优先（avg 升序），其次 watch，最后 ok
 *   - 儿童请求**绝不返回 IPA**：只给 childLabel / tipChildZh / 例词，
 *     contrast 的音素符号与含 IPA 的文案都会被剥离（最后再走 childSafeDeep 兜底）
 */
import { eq } from "drizzle-orm";
import { getDb, getSqlite } from "@/db";
import { phonemeMastery } from "@/db/schema";
import { getArticulation, type Articulation } from "./articulation";
import { WORD_LEVEL_KEY } from "./attempt-service";
import type { SessionUser } from "./auth";
import { childSafeDeep, childSafeText } from "./child-safe";

export type DiagnosisStatus = "weak" | "watch" | "ok";

export interface DiagnosisItem {
  /** 儿童视图为空串（不下发 IPA） */
  phoneme: string;
  /** 儿童可见名（无 IPA），成人视图也给出便于展示 */
  child_label: string;
  /** 强化练习链接用的 token：成人为 IPA，儿童为 childLabel（服务端都能解析回来） */
  focus_token: string;
  status: DiagnosisStatus;
  attempts: number;
  avg_score: number;
  last_score: number | null;
  best_score: number | null;
  trend: { direction: "improving" | "flat" | "declining"; delta: number | null; points: number[] };
  error_words: { word: string; score: number | null }[];
  /** 语料里含该音素、可用来强化练习的句子数 */
  practice_count: number;
  tip_zh: string;
  tip_child_zh: string;
  common_errors: string[];
  examples: string[];
  contrasts: { phoneme: string; pair: [string, string]; note: string }[];
}

export interface DiagnosisPayload {
  generated_at: string;
  min_samples: number;
  total_phonemes: number;
  counted_phonemes: number;
  counts: { weak: number; watch: number; ok: number };
  summary_zh: string;
  /** 先练哪几个（weak 优先，最多 3 个） */
  focus_phonemes: string[];
  items: DiagnosisItem[];
}

/** 儿童视图：把含 IPA 的字段整体剥掉（ipa/tipZh/contrast.phoneme），文案走 childSafeText */
export function toChildArticulation(art: Articulation): Articulation {
  return {
    ...art,
    ipa: "",
    tipZh: childSafeText(art.tipZh),
    commonErrorsZh: art.commonErrorsZh.map(childSafeText),
    contrasts: art.contrasts.map((c) => ({
      phoneme: "",
      pair: c.pair,
      noteZh: childSafeText(c.noteZh),
    })),
    art: { ...art.art },
  };
}

function statusOf(avg: number): DiagnosisStatus {
  if (avg < 65) return "weak";
  if (avg < 80) return "watch";
  return "ok";
}

function trendOf(points: number[]): DiagnosisItem["trend"] {
  const last3 = points.slice(-3);
  if (last3.length < 2) return { direction: "flat", delta: null, points: last3 };
  const delta = Math.round((last3[last3.length - 1] - last3[0]) * 10) / 10;
  return {
    direction: delta > 3 ? "improving" : delta < -3 ? "declining" : "flat",
    delta,
    points: last3,
  };
}

function parseTrend(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { s?: number }[];
    return Array.isArray(v) ? v.map((x) => Number(x?.s)).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

/**
 * 聚合原始诊断（**含 IPA**，仅服务端页面内部使用，绝不整包下发给儿童）。
 * 对外 API 请用 buildDiagnosis()（会按角色剥离 IPA）。
 */
export async function buildDiagnosisRaw(user: SessionUser): Promise<DiagnosisPayload> {
  return aggregate(user, false);
}

/** 对外 API /report 页面用：儿童请求自动剥离 IPA（双保险：显式剥离 + childSafeDeep 兜底） */
export async function buildDiagnosis(user: SessionUser): Promise<DiagnosisPayload> {
  return aggregate(user, user.isChild);
}

async function aggregate(user: SessionUser, forChild: boolean): Promise<DiagnosisPayload> {
  const minSamples = 2;
  const db = getDb();
  const sqlite = getSqlite();

  const rows = await db.select().from(phonemeMastery).where(eq(phonemeMastery.userId, user.id));
  const counted = rows.filter((r) => r.phoneme !== WORD_LEVEL_KEY && r.attempts >= minSamples);

  const errorWordStmt = sqlite.prepare(
    `SELECT word, MIN(score) AS s FROM phoneme_scores
     WHERE user_id = ? AND phoneme = ? AND score IS NOT NULL
     GROUP BY word ORDER BY s ASC LIMIT 3`,
  );
  const practiceStmt = sqlite.prepare(
    "SELECT COUNT(*) AS c FROM sentences WHERE focus_phonemes LIKE ?",
  );

  const items: DiagnosisItem[] = counted.map((r) => {
    const ipa = r.phoneme;
    const art = getArticulation(ipa);
    const avg = Math.round((r.avgScore ?? 0) * 10) / 10;
    const errorWords = (errorWordStmt.all(user.id, ipa) as { word: string; s: number | null }[]).map(
      (w) => ({ word: w.word, score: w.s }),
    );
    const practice = (practiceStmt.get(`%"${ipa}"%`) as { c: number } | undefined)?.c ?? 0;
    return {
      phoneme: forChild ? "" : ipa,
      child_label: art?.childLabel ?? ipa,
      focus_token: forChild ? (art?.childLabel ?? ipa) : ipa,
      status: statusOf(avg),
      attempts: r.attempts,
      avg_score: avg,
      last_score: r.lastScore === null ? null : Math.round(r.lastScore * 10) / 10,
      best_score: r.bestScore === null ? null : Math.round(r.bestScore * 10) / 10,
      trend: trendOf(parseTrend(r.trendJson)),
      error_words: errorWords,
      practice_count: practice,
      tip_zh: art?.tipZh ?? "",
      tip_child_zh: art?.tipChildZh ?? "",
      common_errors: art?.commonErrorsZh ?? [],
      examples: art?.examples ?? [],
      contrasts: (art?.contrasts ?? []).map((c) => ({
        phoneme: forChild ? "" : c.phoneme,
        pair: c.pair,
        note: forChild ? childSafeText(c.noteZh) : c.noteZh,
      })),
    };
  });

  const order: Record<DiagnosisStatus, number> = { weak: 0, watch: 1, ok: 2 };
  items.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return a.status === "ok" ? b.avg_score - a.avg_score : a.avg_score - b.avg_score;
  });

  const weak = items.filter((i) => i.status === "weak");
  const watch = items.filter((i) => i.status === "watch");
  const ok = items.filter((i) => i.status === "ok");

  const nameOf = (i: DiagnosisItem) => (forChild ? `「${i.child_label}」` : `/${i.phoneme}/`);
  let summary: string;
  if (items.length === 0) {
    summary =
      counted.length === 0
        ? `练习数据还不够（每个音素至少要有 ${minSamples} 次记录），先去跟读几句吧。`
        : "还没有达到统计样本量的音素，多读几句再来看看。";
  } else if (weak.length > 0) {
    const top = weak.slice(0, 2).map(nameOf).join("、");
    summary = forChild
      ? `你最需要练的是${top}，我们先从这里开始，慢慢来就好。`
      : `你最需要练的是${top}，建议先做这 2 个的强化练习。`;
  } else if (watch.length > 0) {
    summary = `${nameOf(watch[0])} 还可以再稳一点（平均 ${watch[0].avg_score} 分），其它音素都不错。`;
  } else {
    summary = `已统计的 ${items.length} 个音素都在 80 分以上，保持住！`;
  }

  const payload: DiagnosisPayload = {
    generated_at: new Date().toISOString(),
    min_samples: minSamples,
    total_phonemes: rows.filter((r) => r.phoneme !== WORD_LEVEL_KEY).length,
    counted_phonemes: items.length,
    counts: { weak: weak.length, watch: watch.length, ok: ok.length },
    summary_zh: summary,
    focus_phonemes: [...weak, ...watch].slice(0, 3).map((i) => i.focus_token),
    items,
  };

  // 儿童：最后再整体兜底一遍（任何新增字段都不会漏 IPA）
  return forChild ? childSafeDeep(payload, "diagnosis") : payload;
}
