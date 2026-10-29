/**
 * 盲测（blind test）—— 契约 v1.1 §13。
 *
 * §13.3 的三条硬性行为要求（功能正确性，不是 UI 偏好）：
 *   1) 进行中接口不得返回任何分数/反馈（否则用户会立刻重读，盲测静默失效）；
 *   2) is_blind=1 的记录不参与 phoneme_mastery / 练习趋势 / SRS 排期；
 *   3) 抽题必须来自"该学习者练过的语料"，并且固定同一组句子（才能和上周比）。
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { attempts, blindTests, sentences } from "@/db/schema";
import { HttpError, type SessionUser } from "./auth";
import { practicedSentenceIds, visibleSentencesWhere } from "./corpus";

export const BLIND_TEST_SIZE = 10;

export interface BlindTestRowView {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  item_count: number;
  avg_pron: number | null;
  avg_accuracy: number | null;
  avg_fluency: number | null;
  avg_intonation_distance: number | null;
  sentence_ids: string[];
}

function toView(row: typeof blindTests.$inferSelect): BlindTestRowView {
  return {
    id: row.id,
    user_id: row.userId,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    item_count: row.itemCount,
    avg_pron: row.avgPron,
    avg_accuracy: row.avgAccuracy,
    avg_fluency: row.avgFluency,
    avg_intonation_distance: row.avgIntonationDistance,
    sentence_ids: safeArray(row.sentenceIdsJson),
  };
}

/**
 * 抽题：优先复用上一次盲测的句子组（"固定一组"），否则从"练过的语料"里确定性抽。
 * 确定性 = sha1(user_id + sentence_id) 排序，与时间无关 → 同一用户每次得到同一组。
 */
export async function pickBlindSentenceIds(user: SessionUser): Promise<{
  sentenceIds: string[];
  source: "reused_previous" | "from_practiced";
  practicedCount: number;
}> {
  const db = getDb();
  const visible = await visibleSentencesWhere(user);

  // 1) 复用上一次盲测的固定句子组（仍然存在且对当前用户可见的部分）
  const [previous] = await db
    .select()
    .from(blindTests)
    .where(eq(blindTests.userId, user.id))
    .orderBy(desc(blindTests.startedAt))
    .limit(1);
  if (previous) {
    const prevIds = safeArray(previous.sentenceIdsJson);
    if (prevIds.length > 0) {
      const stillThere = await db
        .select({ id: sentences.id })
        .from(sentences)
        .where(and(visible, inArray(sentences.id, prevIds)));
      const alive = new Set(stillThere.map((r) => r.id));
      const reusable = prevIds.filter((id) => alive.has(id));
      if (reusable.length > 0) {
        return { sentenceIds: reusable, source: "reused_previous", practicedCount: reusable.length };
      }
    }
  }

  // 2) 从"练过的语料"里抽（绝不抽没练过的，否则分数没有可比性）
  const practiced = await practicedSentenceIds(user.id);
  const practicedVisible = await db
    .select({ id: sentences.id })
    .from(sentences)
    .where(and(visible, inArray(sentences.id, practiced.length > 0 ? practiced : ["__none__"])));
  const pool = practicedVisible.map((r) => r.id);
  pool.sort((a, b) => hashKey(user.id, a).localeCompare(hashKey(user.id, b)));
  return {
    sentenceIds: pool.slice(0, BLIND_TEST_SIZE),
    source: "from_practiced",
    practicedCount: pool.length,
  };
}

function hashKey(userId: string, sentenceId: string): string {
  return createHash("sha1").update(`${userId}:${sentenceId}`).digest("hex");
}

/** 开始一次盲测；若已有进行中的，直接返回它（页面刷新/重进不产生重复批次）。 */
export async function startBlindTest(user: SessionUser): Promise<{
  test: BlindTestRowView;
  resumed: boolean;
  sentence_ids: string[];
  total: number;
}> {
  const db = getDb();
  const [inProgress] = await db
    .select()
    .from(blindTests)
    .where(and(eq(blindTests.userId, user.id), isNull(blindTests.endedAt)))
    .orderBy(desc(blindTests.startedAt))
    .limit(1);
  if (inProgress) {
    const view = toView(inProgress);
    return { test: view, resumed: true, sentence_ids: view.sentence_ids, total: view.sentence_ids.length };
  }

  const picked = await pickBlindSentenceIds(user);
  if (picked.sentenceIds.length === 0) {
    throw new HttpError(
      409,
      "no_practiced_sentences",
      "还没有练过的句子，无法开始盲测。先去「跟读练习」读几句，再来做盲测吧。",
    );
  }

  const now = new Date().toISOString();
  const id = `bt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db.insert(blindTests).values({
    id,
    userId: user.id,
    startedAt: now,
    endedAt: null,
    itemCount: picked.sentenceIds.length,
    sentenceIdsJson: JSON.stringify(picked.sentenceIds),
    createdAt: now,
  });
  const [row] = await db.select().from(blindTests).where(eq(blindTests.id, id)).limit(1);
  const view = toView(row);
  return { test: view, resumed: false, sentence_ids: view.sentence_ids, total: view.sentence_ids.length };
}

/** 进行中批次必须存在、属于本人、且未结束（§13.3 第 1 条的入口校验）。 */
export async function requireOpenBlindTest(user: SessionUser, blindTestId: string) {
  const db = getDb();
  const [row] = await db.select().from(blindTests).where(eq(blindTests.id, blindTestId)).limit(1);
  if (!row || row.userId !== user.id) throw new HttpError(404, "not_found", "盲测批次不存在");
  if (row.endedAt) {
    throw new HttpError(409, "blind_test_closed", "这次盲测已经结束了");
  }
  return toView(row);
}

/**
 * 盲测进度（task-33 异步口径）：
 *   - `done` = **已评分数**（status='done'）
 *   - `submitted` = 已提交条数（含评分中/失败）
 *   - `pending` = 未评完条数（pending/scoring/failed）
 */
export async function blindProgress(
  blindTestId: string,
  total: number,
): Promise<{ done: number; total: number; submitted: number; pending: number }> {
  const db = getDb();
  const rows = await db
    .select({ id: attempts.id, status: attempts.status })
    .from(attempts)
    .where(and(eq(attempts.blindTestId, blindTestId), eq(attempts.isBlind, 1)));
  const submitted = rows.length;
  const done = rows.filter((r) => r.status === "done").length;
  return { done, total, submitted, pending: submitted - done };
}

function round1(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((a, b) => a + b, 0) / values.length);
}

function safeArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 用盲测批次的 attempts 计算平均分。
 * **只统计 status='done'（已评分）的记录** —— 未评完的不参与平均，也不当作 0 分（task-33）。
 */
export async function computeBlindAverages(blindTestId: string): Promise<{
  submitted: number;
  scored: number;
  pending: number;
  avgPron: number | null;
  avgAccuracy: number | null;
  avgFluency: number | null;
  avgIntonationDistance: number | null;
}> {
  const db = getDb();
  const allRows = await db
    .select({
      id: attempts.id,
      status: attempts.status,
      scoresJson: attempts.scoresJson,
      intonationJson: attempts.intonationJson,
    })
    .from(attempts)
    .where(and(eq(attempts.blindTestId, blindTestId), eq(attempts.isBlind, 1)));
  const rows = allRows.filter((r) => r.status === "done");

  const pron: number[] = [];
  const accuracy: number[] = [];
  const fluency: number[] = [];
  const dtw: number[] = [];
  for (const r of rows) {
    if (r.scoresJson) {
      try {
        const s = JSON.parse(r.scoresJson) as Record<string, number | null>;
        if (typeof s.pron === "number") pron.push(s.pron);
        if (typeof s.accuracy === "number") accuracy.push(s.accuracy);
        if (typeof s.fluency === "number") fluency.push(s.fluency);
      } catch {
        /* 忽略坏 JSON */
      }
    }
    if (r.intonationJson) {
      try {
        const it = JSON.parse(r.intonationJson) as { dtw_distance?: number | null };
        if (typeof it.dtw_distance === "number") dtw.push(it.dtw_distance);
      } catch {
        /* 忽略坏 JSON */
      }
    }
  }

  return {
    submitted: allRows.length,
    scored: rows.length,
    pending: allRows.length - rows.length,
    avgPron: avg(pron),
    avgAccuracy: avg(accuracy),
    avgFluency: avg(fluency),
    avgIntonationDistance: round1(dtw.length ? dtw.reduce((a, b) => a + b, 0) / dtw.length : NaN),
  };
}

/** 结束盲测：写入 avg_*，返回本次汇总 + 与上一次的差值（此后分数才可读）。 */
export async function finishBlindTest(user: SessionUser, blindTestId: string) {
  const db = getDb();
  const [row] = await db.select().from(blindTests).where(eq(blindTests.id, blindTestId)).limit(1);
  if (!row || row.userId !== user.id) throw new HttpError(404, "not_found", "盲测批次不存在");

  let view = toView(row);
  let lastStats: Awaited<ReturnType<typeof computeBlindAverages>> | null = null;
  if (!row.endedAt) {
    const stats = await computeBlindAverages(blindTestId);
    if (stats.submitted === 0) {
      throw new HttpError(409, "no_attempts", "这次盲测还没有提交任何一句，无法结束");
    }
    // 异步评分：未评完的条目不参与平均（avg_* 保持 null，不返回 0 冒充数据）
    lastStats = stats;
    const endedAt = new Date().toISOString();
    await db
      .update(blindTests)
      .set({
        endedAt,
        itemCount: stats.submitted,
        avgPron: stats.avgPron,
        avgAccuracy: stats.avgAccuracy,
        avgFluency: stats.avgFluency,
        avgIntonationDistance: stats.avgIntonationDistance,
      })
      .where(eq(blindTests.id, blindTestId));
    const [fresh] = await db.select().from(blindTests).where(eq(blindTests.id, blindTestId)).limit(1);
    view = toView(fresh);
  }

  // 上一次已完成的盲测（按开始时间倒序，排除自己）
  const previous =
    (
      await db
        .select()
        .from(blindTests)
        .where(and(eq(blindTests.userId, user.id), isNotNull(blindTests.endedAt)))
        .orderBy(desc(blindTests.startedAt))
        .limit(5)
    )
      .map(toView)
      .find((t) => t.id !== view.id) ?? null;

  const delta = (a: number | null, b: number | null) =>
    a !== null && b !== null ? round1(a - b) : null;

  const stats = lastStats ?? (await computeBlindAverages(blindTestId));
  const notice =
    stats.scored === 0
      ? `本次没有任何一条评完的句子（已提交 ${stats.submitted} 条，其中 ${stats.pending} 条仍在后台评分/失败），所以平均分暂缺；等评分完成后再看报告。`
      : stats.pending > 0
        ? `有 ${stats.pending} 条仍在后台评分，本次平均分只基于已评完的 ${stats.scored} 条。`
        : null;

  return {
    blind_test_id: view.id,
    user_id: view.user_id,
    started_at: view.started_at,
    ended_at: view.ended_at,
    item_count: view.item_count,
    submitted: stats.submitted,
    /** 已评分数（avg_* 的口径：只基于这些） */
    scored: stats.scored,
    /** 未评完数（含 pending/scoring/failed）；>0 时 avg_* 只代表已评完部分 */
    pending: stats.pending,
    notice,
    avg_pron: view.avg_pron,
    avg_accuracy: view.avg_accuracy,
    avg_fluency: view.avg_fluency,
    avg_intonation_distance: view.avg_intonation_distance,
    previous: previous
      ? {
          blind_test_id: previous.id,
          ended_at: previous.ended_at,
          avg_pron: previous.avg_pron,
          avg_accuracy: previous.avg_accuracy,
          avg_fluency: previous.avg_fluency,
          avg_intonation_distance: previous.avg_intonation_distance,
        }
      : null,
    delta_pron: delta(view.avg_pron, previous?.avg_pron ?? null),
    delta_accuracy: delta(view.avg_accuracy, previous?.avg_accuracy ?? null),
    delta_fluency: delta(view.avg_fluency, previous?.avg_fluency ?? null),
    delta_intonation_distance: delta(
      view.avg_intonation_distance,
      previous?.avg_intonation_distance ?? null,
    ),
  };
}

/** 历史 + 周环比趋势（契约 §13.4 的字段名）。 */
export async function listBlindTests(userId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(blindTests)
    .where(eq(blindTests.userId, userId))
    .orderBy(desc(blindTests.startedAt));
  // 每个批次的评分进度（异步口径）：scored = 已评分条数，pending = 未评完条数
  const counts = await db
    .select({
      blindTestId: attempts.blindTestId,
      status: attempts.status,
      c: sql<number>`count(*)`,
    })
    .from(attempts)
    .where(and(eq(attempts.userId, userId), eq(attempts.isBlind, 1)))
    .groupBy(attempts.blindTestId, attempts.status);
  const scoredById = new Map<string, number>();
  const pendingById = new Map<string, number>();
  for (const row of counts) {
    const id = row.blindTestId;
    if (!id) continue;
    const n = Number(row.c);
    if (row.status === "done") scoredById.set(id, (scoredById.get(id) ?? 0) + n);
    else pendingById.set(id, (pendingById.get(id) ?? 0) + n);
  }
  const withCounts = (t: ReturnType<typeof toView>) => ({
    ...t,
    scored: scoredById.get(t.id) ?? 0,
    pending: pendingById.get(t.id) ?? 0,
  });
  const tests = rows.map(toView).map(withCounts);
  const finished = tests.filter((t) => t.ended_at !== null);
  const current = finished[0] ?? null;
  const previous = finished[1] ?? null;
  const delta = (a: number | null | undefined, b: number | null | undefined) =>
    typeof a === "number" && typeof b === "number" ? round1(a - b) : null;

  return {
    user_id: userId,
    tests,
    in_progress: tests.find((t) => t.ended_at === null) ?? null,
    /** 所有未评完的盲测条目总数（周报顶部「待评分 N 条」） */
    pending_total: [...pendingById.values()].reduce((a, b) => a + b, 0),
    trend: {
      current: current
        ? {
            blind_test_id: current.id,
            ended_at: current.ended_at,
            avg_pron: current.avg_pron,
            avg_accuracy: current.avg_accuracy,
            avg_fluency: current.avg_fluency,
            avg_intonation_distance: current.avg_intonation_distance,
          }
        : null,
      previous: previous
        ? {
            blind_test_id: previous.id,
            ended_at: previous.ended_at,
            avg_pron: previous.avg_pron,
            avg_accuracy: previous.avg_accuracy,
            avg_fluency: previous.avg_fluency,
            avg_intonation_distance: previous.avg_intonation_distance,
          }
        : null,
      delta_pron: delta(current?.avg_pron, previous?.avg_pron),
      delta_accuracy: delta(current?.avg_accuracy, previous?.avg_accuracy),
      delta_fluency: delta(current?.avg_fluency, previous?.avg_fluency),
      delta_intonation_distance: delta(
        current?.avg_intonation_distance,
        previous?.avg_intonation_distance,
      ),
      /** 已完成的盲测次数 = 周报数据点个数 */
      weeks: finished.length,
    },
    /** 已完成的批次（供家长面板画折线，按时间正序） */
    series: [...finished].reverse().map((t) => ({
      blind_test_id: t.id,
      ended_at: t.ended_at,
      avg_pron: t.avg_pron,
      avg_accuracy: t.avg_accuracy,
      avg_fluency: t.avg_fluency,
      avg_intonation_distance: t.avg_intonation_distance,
      item_count: t.item_count,
    })),
  };
}

/** /blindtest 页面用：进行中的批次 + 句子文本 + 进度（**不含任何历史分数**）。 */
export async function getBlindTestForPage(user: SessionUser) {
  const db = getDb();
  const [inProgress] = await db
    .select()
    .from(blindTests)
    .where(and(eq(blindTests.userId, user.id), isNull(blindTests.endedAt)))
    .orderBy(desc(blindTests.startedAt))
    .limit(1);

  if (!inProgress) {
    const picked = await pickBlindSentenceIds(user);
    return {
      inProgress: false as const,
      canStart: picked.sentenceIds.length > 0,
      plannedTotal: picked.sentenceIds.length,
      practicedCount: picked.practicedCount,
      sentenceIds: [] as string[],
      sentences: [] as { id: string; text: string; translation_zh: string }[],
      progress: { done: 0, total: 0 },
    };
  }

  const view = toView(inProgress);
  const rows = await db
    .select()
    .from(sentences)
    .where(inArray(sentences.id, view.sentence_ids.length > 0 ? view.sentence_ids : ["__none__"]))
    .orderBy(asc(sentences.sortOrder));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = view.sentence_ids
    .map((id) => byId.get(id))
    .filter((r): r is typeof sentences.$inferSelect => Boolean(r));

  return {
    inProgress: true as const,
    blindTestId: view.id,
    startedAt: view.started_at,
    plannedTotal: view.sentence_ids.length,
    practicedCount: view.sentence_ids.length,
    sentenceIds: view.sentence_ids,
    sentences: ordered.map((r) => ({
      id: r.id,
      text: r.text,
      translation_zh: r.translationZh,
    })),
    progress: await blindProgress(view.id, view.sentence_ids.length),
  };
}
