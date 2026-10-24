import { asc } from "drizzle-orm";
import { getDb, getSqlite } from "@/db";
import { users } from "@/db/schema";
import { WORD_LEVEL_KEY } from "@/lib/attempt-service";
import { listBlindTests } from "@/lib/blind-test";
import { hintKeyForPhoneme } from "@/lib/phoneme-hints";
import { getHint } from "@/lib/hints";
import { startOfToday } from "@/lib/usage";

export interface ParentSummary {
  generated_at: string;
  family: {
    members: number;
    minutes_today: number;
    minutes_7d: number;
    sentence_count: number;
    scenario_count: number;
    children: {
      id: string;
      display_name: string;
      remaining_minutes: number | null;
      limit_minutes: number;
    }[];
  };
  members: MemberSummary[];
}

export interface MemberSummary {
  id: string;
  display_name: string;
  avatar: string | null;
  role: string;
  age_band: string;
  cefr_level: string;
  birth_year: number | null;
  daily_limit_minutes: number;
  today: {
    /** 日常练习时长（不含盲测） */
    minutes: number;
    /** 盲测时长（单独呈现，但计入每日上限） */
    blind_minutes: number;
    /** minutes + blind_minutes，用于每日上限判断 */
    total_minutes: number;
    attempt_count: number;
    chat_turns: number;
    remaining_minutes: number | null;
    exceeded: boolean;
  };
  week: { minutes: number; attempts: number; avg_pron: number | null };
  totals: {
    attempts: number;
    chat_sessions: number;
    phoneme_rows: number;
    avg_pron: number | null;
  };
  trend: { date: string; attempts: number; avg_pron: number }[];
  /** 盲测周报：家长判断"到底有没有变好"的唯一依据（is_blind=1 的独立指标） */
  blind: {
    weeks: number;
    current: {
      blind_test_id: string;
      ended_at: string | null;
      avg_pron: number | null;
      avg_accuracy: number | null;
      avg_fluency: number | null;
      avg_intonation_distance: number | null;
    } | null;
    previous: {
      blind_test_id: string;
      ended_at: string | null;
      avg_pron: number | null;
    } | null;
    delta_pron: number | null;
    series: {
      blind_test_id: string;
      ended_at: string | null;
      avg_pron: number | null;
      avg_accuracy: number | null;
      avg_fluency: number | null;
      item_count: number;
    }[];
    in_progress_id: string | null;
  };
  top_phonemes: {
    phoneme: string;
    count: number;
    avg_score: number;
    hard_hits: number;
    title_zh: string;
  }[];
  top_words: { word: string; count: number; avg_score: number; coarse: boolean }[];
}

/** 家长面板数据源（route 与页面共用，避免重复实现）。仅由 requireParent 之后调用。 */
export async function buildParentSummary(): Promise<ParentSummary> {
  const db = getDb();
  const sqlite = getSqlite();
  const today = startOfToday().toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const fortnightAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

  const allUsers = await db.select().from(users).orderBy(asc(users.createdAt));

  const members: MemberSummary[] = await Promise.all(
    allUsers.map(async (u) => {
    const todayStats = sqlite
      .prepare(
        `SELECT
           COALESCE((SELECT SUM(minutes) FROM practice_sessions WHERE user_id = ? AND started_at >= ?), 0) AS minutes,
           (SELECT COUNT(*) FROM attempts WHERE user_id = ? AND created_at >= ? AND is_blind = 0) AS attempt_count,
           (SELECT COUNT(*) FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id
              WHERE cs.user_id = ? AND cm.role = 'user' AND cm.created_at >= ?) AS chat_turns,
           COALESCE((SELECT SUM(minutes) FROM practice_sessions WHERE user_id = ? AND started_at >= ? AND kind = 'blindtest'), 0) AS blind_minutes`,
      )
      .get(u.id, today, u.id, today, u.id, today, u.id, today) as {
      minutes: number;
      attempt_count: number;
      chat_turns: number;
      blind_minutes: number;
    };

    const week = sqlite
      .prepare(
        `SELECT
           COALESCE((SELECT SUM(minutes) FROM practice_sessions WHERE user_id = ? AND started_at >= ?), 0) AS minutes,
           (SELECT COUNT(*) FROM attempts WHERE user_id = ? AND created_at >= ? AND is_blind = 0) AS attempts,
           (SELECT ROUND(AVG(CAST(json_extract(scores_json, '$.pron') AS REAL)), 1) FROM attempts
              WHERE user_id = ? AND created_at >= ? AND scores_json IS NOT NULL AND is_blind = 0) AS avg_pron`,
      )
      .get(u.id, weekAgo, u.id, weekAgo, u.id, weekAgo) as {
      minutes: number;
      attempts: number;
      avg_pron: number | null;
    };

    const totals = sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM attempts WHERE user_id = ? AND is_blind = 0) AS attempts_total,
           (SELECT COUNT(*) FROM chat_sessions WHERE user_id = ?) AS chat_sessions_total,
           (SELECT COUNT(*) FROM phoneme_scores WHERE user_id = ?) AS phoneme_rows,
           (SELECT ROUND(AVG(CAST(json_extract(scores_json, '$.pron') AS REAL)), 1) FROM attempts
              WHERE user_id = ? AND scores_json IS NOT NULL AND is_blind = 0) AS avg_pron_all`,
      )
      .get(u.id, u.id, u.id, u.id) as {
      attempts_total: number;
      chat_sessions_total: number;
      phoneme_rows: number;
      avg_pron_all: number | null;
    };

    const trend = sqlite
      .prepare(
        `SELECT substr(created_at, 1, 10) AS date,
                COUNT(*) AS attempts,
                ROUND(AVG(CAST(json_extract(scores_json, '$.pron') AS REAL)), 1) AS avg_pron
         FROM attempts
         WHERE user_id = ? AND created_at >= ? AND scores_json IS NOT NULL AND is_blind = 0
         GROUP BY date ORDER BY date ASC`,
      )
      .all(u.id, fortnightAgo) as { date: string; attempts: number; avg_pron: number }[];

    const topPhonemes = sqlite
      .prepare(
        `SELECT phoneme, COUNT(*) AS n, ROUND(AVG(score), 1) AS avg_score,
                SUM(CASE WHEN score < 60 THEN 1 ELSE 0 END) AS hard_hits
         FROM phoneme_scores
         WHERE user_id = ? AND phoneme != ? AND error_type IS NOT NULL AND error_type != 'None'
         GROUP BY phoneme ORDER BY hard_hits DESC, avg_score ASC, n DESC LIMIT 10`,
      )
      .all(u.id, WORD_LEVEL_KEY) as {
      phoneme: string;
      n: number;
      avg_score: number;
      hard_hits: number;
    }[];

    const topWords = sqlite
      .prepare(
        `SELECT word, COUNT(*) AS n, ROUND(AVG(score), 1) AS avg_score
         FROM phoneme_scores
         WHERE user_id = ? AND phoneme = ? AND error_type IS NOT NULL AND error_type != 'None'
         GROUP BY word ORDER BY n DESC LIMIT 5`,
      )
      .all(u.id, WORD_LEVEL_KEY) as { word: string; n: number; avg_score: number }[];

    const blindMinutesToday = Math.round(Number(todayStats.blind_minutes) * 10) / 10;
    const minutesToday = Math.round((Number(todayStats.minutes) - blindMinutesToday) * 10) / 10;
    const totalMinutesToday = Math.round((minutesToday + blindMinutesToday) * 10) / 10;
    const remaining =
      u.role === "child"
        ? Math.max(0, Math.round((u.dailyLimitMinutes - totalMinutesToday) * 10) / 10)
        : null;
    const blindData = await listBlindTests(u.id);

    return {
      id: u.id,
      display_name: u.displayName,
      avatar: u.avatar,
      role: u.role,
      age_band: u.ageBand,
      cefr_level: u.cefrLevel,
      birth_year: u.birthYear,
      daily_limit_minutes: u.dailyLimitMinutes,
      today: {
        minutes: minutesToday,
        blind_minutes: blindMinutesToday,
        total_minutes: totalMinutesToday,
        attempt_count: Number(todayStats.attempt_count),
        chat_turns: Number(todayStats.chat_turns),
        remaining_minutes: remaining,
        exceeded: u.role === "child" ? totalMinutesToday >= u.dailyLimitMinutes : false,
      },
      week: {
        minutes: Math.round(Number(week.minutes) * 10) / 10,
        attempts: Number(week.attempts),
        avg_pron: week.avg_pron,
      },
      totals: {
        attempts: Number(totals.attempts_total),
        chat_sessions: Number(totals.chat_sessions_total),
        phoneme_rows: Number(totals.phoneme_rows),
        avg_pron: totals.avg_pron_all,
      },
      trend,
      blind: {
        weeks: blindData.trend.weeks,
        current: blindData.trend.current,
        previous: blindData.trend.previous
          ? {
              blind_test_id: blindData.trend.previous.blind_test_id,
              ended_at: blindData.trend.previous.ended_at,
              avg_pron: blindData.trend.previous.avg_pron,
            }
          : null,
        delta_pron: blindData.trend.delta_pron,
        series: blindData.series.map((x) => ({
          blind_test_id: x.blind_test_id,
          ended_at: x.ended_at,
          avg_pron: x.avg_pron,
          avg_accuracy: x.avg_accuracy,
          avg_fluency: x.avg_fluency,
          item_count: x.item_count,
        })),
        in_progress_id: blindData.in_progress?.id ?? null,
      },
      top_phonemes: topPhonemes.map((p) => ({
        phoneme: p.phoneme,
        count: Number(p.n),
        avg_score: p.avg_score,
        hard_hits: Number(p.hard_hits),
        title_zh: getHint(hintKeyForPhoneme(p.phoneme)).title_zh,
      })),
      top_words: topWords.map((w) => ({
        word: w.word,
        count: Number(w.n),
        avg_score: w.avg_score,
        coarse: true,
      })),
      };
    }),
  );

  const familyMinutesToday = members.reduce((a, m) => a + m.today.minutes, 0);
  const familyMinutesWeek = members.reduce((a, m) => a + m.week.minutes, 0);
  const [sentenceCount] = sqlite.prepare("SELECT COUNT(*) AS c FROM sentences").all() as { c: number }[];
  const [scenarioCount] = sqlite
    .prepare("SELECT COUNT(*) AS c FROM chat_scenarios WHERE enabled = 1")
    .all() as { c: number }[];

  return {
    generated_at: new Date().toISOString(),
    family: {
      members: members.length,
      minutes_today: Math.round(familyMinutesToday * 10) / 10,
      minutes_7d: Math.round(familyMinutesWeek * 10) / 10,
      sentence_count: sentenceCount?.c ?? 0,
      scenario_count: scenarioCount?.c ?? 0,
      children: members
        .filter((m) => m.role === "child")
        .map((m) => ({
          id: m.id,
          display_name: m.display_name,
          remaining_minutes: m.today.remaining_minutes,
          limit_minutes: m.daily_limit_minutes,
        })),
    },
    members,
  };
}

/**
 * 音素 → hint_key：实现在 `src/lib/phoneme-hints.ts`（数据在 phoneme-hints.json），
 * 这里只做再导出，保持既有 import 路径可用。
 * 仅用于面板/错音本文案（严重度映射由 voice 决定，web 不重算）。
 */
export { hintKeyForPhoneme } from "./phoneme-hints";
