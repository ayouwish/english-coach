import { and, asc, eq, lte } from "drizzle-orm";
import { getDb, getSqlite } from "@/db";
import { phonemeMastery, sentences, srsCards } from "@/db/schema";
import { WORD_LEVEL_KEY } from "@/lib/attempt-service";
import { getChildHint, getHint } from "@/lib/hints";
import { childSafeDeep, childSafeText } from "@/lib/child-safe";
import { hintKeyForPhoneme } from "@/lib/phoneme-hints";

export interface ReviewCardView {
  id: string;
  kind: string;
  ref: string;
  due_at: string;
  ease: number;
  interval_days: number;
  reps: number;
  lapses: number;
  last_grade: string | null;
  is_phoneme: boolean;
  /** 成人视图展示的音素符号；儿童视图恒为 null（不下发 IPA） */
  phoneme: string | null;
  /** 映射到的教学提示键（成人/儿童通用，不含 IPA） */
  hint_key: string | null;
  /** 儿童模式下这是儿童化文案（无 IPA）；成人模式是「音素 + 教学提示」。 */
  label: string;
  why_zh: string;
  how_zh: string;
  practice_words: string[];
  demo_text: string;
  display: { text: string; translation_zh?: string; level?: string };
}

export interface WeakPhonemeView {
  /** 儿童视图恒为空串（不下发 IPA） */
  phoneme: string;
  hint_key: string | null;
  attempts: number;
  avg_score: number;
  best_score: number;
  last_score: number;
  trend: { t: string; s: number }[];
  label: string;
}

export interface ReviewData {
  now: string;
  stats: {
    total_cards: number;
    due_cards: number;
    phoneme_rows: number;
    phoneme_level: boolean;
    voice_reachable: boolean;
  };
  due_cards: ReviewCardView[];
  weak_phonemes: WeakPhonemeView[];
  word_level_errors: { word: string; count: number; avg_score: number; coarse: boolean }[];
}

/**
 * 错音本数据。儿童模式：所有 label 用儿童化文案，绝不输出 IPA 符号。
 * phoneme_scores 里 phoneme='@word' 的行是「单词级粗评」，与音素级严格分开统计。
 */
export async function buildReviewData(opts: {
  userId: string;
  isChild: boolean;
  limit?: number;
  phonemeLevel: boolean;
  voiceReachable: boolean;
}): Promise<ReviewData> {
  const db = getDb();
  const sqlite = getSqlite();
  const now = new Date().toISOString();
  const limit = Math.min(opts.limit ?? 20, 50);

  const due = await db
    .select()
    .from(srsCards)
    .where(and(eq(srsCards.userId, opts.userId), lte(srsCards.dueAt, now)))
    .orderBy(asc(srsCards.dueAt))
    .limit(limit);

  const masteryRows = await db
    .select()
    .from(phonemeMastery)
    .where(eq(phonemeMastery.userId, opts.userId))
    .orderBy(asc(phonemeMastery.avgScore));

  const sentenceRows = await db.select().from(sentences);
  const sentenceMap = new Map(sentenceRows.map((s) => [s.id, s]));

  const weak: WeakPhonemeView[] = masteryRows.map((m) => {
    const key = hintKeyForPhoneme(m.phoneme) || m.phoneme;
    const child = getChildHint(key);
    const hint = getHint(key);
    return {
      // 儿童模式：连音素符号本身都不下发（IPA 不能出现在儿童的 HTML 里）
      phoneme: opts.isChild ? "" : m.phoneme,
      hint_key: hintKeyForPhoneme(m.phoneme) || null,
      attempts: m.attempts,
      avg_score: m.avgScore ?? 0,
      best_score: m.bestScore ?? 0,
      last_score: m.lastScore ?? 0,
      trend: safeJson(m.trendJson),
      label: opts.isChild ? child.title : `${m.phoneme} · ${hint.title_zh}`,
    };
  });

  const due_cards: ReviewCardView[] = due.map((c) => {
    if (c.kind === "word") {
      // 单词级粗评卡片（provider 不支持音素级时的主要错音本内容）
      return {
        id: c.id,
        kind: c.kind,
        ref: c.ref,
        due_at: c.dueAt,
        ease: c.ease,
        interval_days: c.intervalDays,
        reps: c.reps,
        lapses: c.lapses,
        last_grade: c.lastGrade,
        is_phoneme: false,
        phoneme: null,
        hint_key: null,
        label: opts.isChild ? `再读一遍 ${c.ref}` : `${c.ref}（单词级粗评）`,
        why_zh: opts.isChild ? "这个词上次说得不太清楚。" : "该词在单词级（粗评）里得分偏低。",
        how_zh: opts.isChild
          ? `这个词上次说得不太清楚，我们再慢慢说一遍：${c.ref}`
          : `这个词上次读得不够清楚，放慢速度再读一遍：${c.ref}`,
        practice_words: [c.ref],
        demo_text: c.ref,
        display: { text: c.ref },
      };
    }
    if (c.kind === "sentence") {
      const s = sentenceMap.get(c.ref);
      return {
        id: c.id,
        kind: c.kind,
        ref: c.ref,
        due_at: c.dueAt,
        ease: c.ease,
        interval_days: c.intervalDays,
        reps: c.reps,
        lapses: c.lapses,
        last_grade: c.lastGrade,
        is_phoneme: false,
        phoneme: null,
        hint_key: null,
        label: s?.text ?? c.ref,
        why_zh: "这个句子是之前练习时记录下来的。",
        how_zh: "再读一遍这个句子，注意上次标出的地方。",
        practice_words: [],
        demo_text: s?.text ?? "",
        display: {
          text: s?.text ?? c.ref,
          translation_zh: s?.translationZh,
          level: s?.level,
        },
      };
    }
    const key = hintKeyForPhoneme(c.ref) || c.ref;
    const hint = getHint(key);
    const child = getChildHint(key);
    return {
      id: c.id,
      kind: c.kind,
      // 儿童模式不下发音素符号（置空），成人模式保留用于展示
      ref: opts.isChild ? "" : c.ref,
      due_at: c.dueAt,
      ease: c.ease,
      interval_days: c.intervalDays,
      reps: c.reps,
      lapses: c.lapses,
      last_grade: c.lastGrade,
      is_phoneme: true,
      // 成人视图：音素符号 + 口型/舌位提示；儿童视图：只有"这个音怎么说"，不含符号
      phoneme: opts.isChild ? null : c.ref,
      // hint_key 的语义是"教学提示键"，不是音素符号：
      // 未知音素（如 k/ɹ/ʊ）没有对应提示键时给 null，符号本身放在 phoneme/ref 里。
      // （这也避免把 IPA 混进 hint_key → 儿童页面/RSC 负载出现 IPA 字符）
      hint_key: hintKeyForPhoneme(c.ref) || null,
      label:
        (opts.isChild ? child.title : `${c.ref} · ${hint.title_zh}`) || "复习卡片",
      why_zh: (opts.isChild ? child.why : hint.why_zh) || "这个音上次读得不够准。",
      how_zh: (opts.isChild ? child.how : hint.how_zh) || "放慢速度，把每个音都说完整。",
      practice_words: hint.practice_words,
      // 儿童：绝不下发音素符号（没有提示键时 GENERIC.demo_text 为空，`|| c.ref` 会把符号漏出去）
      demo_text: opts.isChild ? childSafeText(hint.demo_text) : hint.demo_text || c.ref,
      display: { text: opts.isChild ? child.title : c.ref },
    };
  });

  const [countRow] = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM srs_cards WHERE user_id = ?) AS total_cards,
         (SELECT COUNT(*) FROM srs_cards WHERE user_id = ? AND due_at <= ?) AS due_cards,
         (SELECT COUNT(*) FROM phoneme_scores WHERE user_id = ?) AS phoneme_rows`,
    )
    .all(opts.userId, opts.userId, now, opts.userId) as {
    total_cards: number;
    due_cards: number;
    phoneme_rows: number;
  }[];

  const wordLevel = sqlite
    .prepare(
      `SELECT word, COUNT(*) AS n, ROUND(AVG(score), 1) AS avg_score
       FROM phoneme_scores
       WHERE user_id = ? AND phoneme = ? AND error_type IS NOT NULL AND error_type != 'None'
       GROUP BY word ORDER BY n DESC, avg_score ASC LIMIT 10`,
    )
    .all(opts.userId, WORD_LEVEL_KEY) as { word: string; n: number; avg_score: number }[];

  const payload: ReviewData = {
    now,
    stats: {
      total_cards: countRow?.total_cards ?? 0,
      due_cards: countRow?.due_cards ?? 0,
      phoneme_rows: countRow?.phoneme_rows ?? 0,
      phoneme_level: opts.phonemeLevel,
      voice_reachable: opts.voiceReachable,
    },
    due_cards,
    weak_phonemes: weak.slice(0, 10),
    word_level_errors: wordLevel.map((w) => ({
      word: w.word,
      count: w.n,
      avg_score: w.avg_score,
      coarse: true,
    })),
  };

  // 儿童：整体再兜底一遍（新增字段自动被覆盖；命中会打日志提示去修源头）
  return opts.isChild ? childSafeDeep(payload, "review") : payload;
}

function safeJson(raw: string): { t: string; s: number }[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
