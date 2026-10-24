import { and, eq, inArray } from "drizzle-orm";
import { getDb, getSqlite } from "@/db";
import { attempts, auditLog, phonemeMastery, srsCards } from "@/db/schema";
import type { SessionUser } from "./auth";
import { getHint } from "./hints";
import type { PronounceResult, Severity } from "./types";
import { recordPracticeTime } from "./usage";

/** 单词级降级结果在 phoneme_scores 里的占位键（绝不冒充音素）。 */
export const WORD_LEVEL_KEY = "@word";

export const WEB_WARNING_VOICE_UNREACHABLE = "web_voice_unreachable";
export const WEB_WARNING_PENDING_RETRY = "web_pending_retry";

export interface AttemptPersistInput {
  user: SessionUser;
  sentenceId: string | null;
  mode: "scripted" | "unscripted";
  referenceText: string;
  audioRelativePath: string | null;
  durationMs: number | null;
  result: PronounceResult | null;
  extraWarnings?: string[];
  /** 盲测：is_blind=1，且**不写** phoneme_scores / phoneme_mastery / srs_cards（契约 §13.3 第 2 条） */
  isBlind?: boolean;
  blindTestId?: string | null;
}

export interface AttemptPersistOutput {
  attemptId: string;
  degraded: boolean;
  warnings: string[];
  phonemeRows: number;
  newCards: number;
  isBlind: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function baseId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * 落库一次跟读：attempts + phoneme_scores + phoneme_mastery + srs_cards + practice_sessions。
 * **voice 失败时 result=null，但录音与参考文本依然入库**（契约 §9：绝不丢数据）。
 */
export async function persistAttempt(input: AttemptPersistInput): Promise<AttemptPersistOutput> {
  const db = getDb();
  const attemptId = baseId("att");
  const createdAt = nowIso();
  const warnings = [...(input.result?.warnings ?? []), ...(input.extraWarnings ?? [])];
  const degraded = input.result === null;

  if (degraded) warnings.push(WEB_WARNING_VOICE_UNREACHABLE, WEB_WARNING_PENDING_RETRY);

  await db.insert(attempts).values({
    id: attemptId,
    userId: input.user.id,
    sentenceId: input.sentenceId,
    mode: input.mode,
    referenceText: input.referenceText,
    recognizedText: input.result?.recognized_text ?? null,
    scoresJson: input.result ? JSON.stringify(input.result.scores) : null,
    issuesJson: input.result ? JSON.stringify(input.result.issues) : null,
    intonationJson: input.result ? JSON.stringify(input.result.intonation) : null,
    feedbackJson: null,
    audioPath: input.audioRelativePath,
    refAudioUrl: input.result?.intonation?.reference_audio_url ?? null,
    durationMs: input.result?.duration_ms ?? input.durationMs ?? null,
    warningsJson: JSON.stringify(warnings),
    isBlind: input.isBlind ? 1 : 0,
    blindTestId: input.blindTestId ?? null,
    createdAt,
  });

  let phonemeRows = 0;
  let newCards = 0;

  // 盲测：绝不写逐音素明细 / 掌握度 / SRS —— 两套指标必须严格分开
  if (input.result && !input.isBlind) {
    const rows = collectPhonemeRows(input.result);
    const sqlite = getSqlite();
    sqlite.transaction(() => {
      const stmt = sqlite.prepare(
        `INSERT INTO phoneme_scores (id, attempt_id, user_id, word, phoneme, score, actual, error_type, hint_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        stmt.run(
          baseId("psc"),
          attemptId,
          input.user.id,
          r.word,
          r.phoneme,
          r.score,
          r.actual,
          r.errorType,
          r.hintKey,
          createdAt,
        );
        phonemeRows += 1;
      }
    })();
    newCards = await updateMasteryAndCards(input.user.id, rows, createdAt);
  }

  await recordPracticeTime({
    userId: input.user.id,
    // 盲测的时长单独归类（时间要计入每日上限，但分数不进日常统计）
    kind: input.isBlind ? "blindtest" : "pronounce",
    id: attemptId,
    minutes: (input.result?.duration_ms ?? input.durationMs ?? 0) / 60_000,
    itemCount: 1,
    startedAt: createdAt,
  });

  await db.insert(auditLog).values({
    id: baseId("aud"),
    ts: createdAt,
    actorUserId: input.user.id,
    action: input.isBlind ? "attempt.blind" : degraded ? "attempt.degraded" : "attempt.created",
    detailJson: JSON.stringify({
      attemptId,
      sentenceId: input.sentenceId,
      mode: input.mode,
      warnings,
      hasAudio: Boolean(input.audioRelativePath),
      isBlind: Boolean(input.isBlind),
      blindTestId: input.blindTestId ?? null,
    }),
  });

  return { attemptId, degraded, warnings, phonemeRows, newCards, isBlind: Boolean(input.isBlind) };
}

interface PhonemeRow {
  word: string;
  phoneme: string;
  score: number | null;
  actual: string | null;
  errorType: string | null;
  hintKey: string | null;
}

function collectPhonemeRows(result: PronounceResult): PhonemeRow[] {
  const rows: PhonemeRow[] = [];
  const issuesByWord = new Map<string, { phoneme?: string | null; actual?: string | null; hint_key?: string | null; type: string }>();
  for (const issue of result.issues ?? []) {
    if (!issuesByWord.has(issue.word)) {
      issuesByWord.set(issue.word, {
        phoneme: issue.phoneme,
        actual: issue.actual,
        hint_key: issue.hint_key,
        type: issue.type,
      });
    }
  }

  for (const word of result.words ?? []) {
    const wordKey = word.word.toLowerCase();
    const issue = issuesByWord.get(word.word) ?? issuesByWord.get(wordKey);
    const phonemes = word.phonemes ?? [];
    if (result.granularity === "phoneme" && phonemes.length > 0) {
      for (const p of phonemes) {
        rows.push({
          word: word.word,
          phoneme: p.phoneme,
          score: p.score,
          actual: issue?.phoneme === p.phoneme ? (issue?.actual ?? null) : null,
          errorType: p.score !== null && p.score < 60 ? (issue?.type ?? "Mispronunciation") : "None",
          hintKey: issue?.phoneme === p.phoneme ? (issue?.hint_key ?? null) : null,
        });
      }
    } else {
      // 单词级（粗评）降级：显式标记，不冒充音素级
      const bad = word.score !== null && word.score < 75;
      rows.push({
        word: word.word,
        phoneme: WORD_LEVEL_KEY,
        score: word.score,
        actual: issue?.actual ?? null,
        errorType: bad ? (word.error_type || issue?.type || "Mispronunciation") : "None",
        hintKey: bad ? (issue?.hint_key ?? null) : null,
      });
    }
  }

  // issues 里出现但 words 里没有的音素，也补一条（保证错音本不丢）
  for (const issue of result.issues ?? []) {
    const key = issue.phoneme ?? WORD_LEVEL_KEY;
    const exists = rows.some(
      (r) => r.word === issue.word && (r.phoneme === key || r.phoneme === WORD_LEVEL_KEY),
    );
    if (!exists) {
      rows.push({
        word: issue.word,
        phoneme: key,
        score: issue.score ?? null,
        actual: issue.actual ?? null,
        errorType: issue.type,
        hintKey: issue.hint_key ?? null,
      });
    }
  }

  return rows;
}

async function updateMasteryAndCards(
  userId: string,
  rows: PhonemeRow[],
  createdAt: string,
): Promise<number> {
  const db = getDb();
  const byPhoneme = new Map<string, number[]>();
  const weakWords = new Set<string>();
  for (const r of rows) {
    if (r.score === null) continue;
    if (r.phoneme === WORD_LEVEL_KEY) {
      // 单词级粗评：不做音素聚合，但同样要进错音本（srs_cards.kind='word'）
      if (r.score < 70 && r.errorType && r.errorType !== "None") weakWords.add(r.word);
      continue;
    }
    const list = byPhoneme.get(r.phoneme) ?? [];
    list.push(r.score);
    byPhoneme.set(r.phoneme, list);
  }

  let newCards = 0;
  for (const word of weakWords) {
    const created = await ensureCard(userId, "word", word, createdAt);
    if (created) newCards += 1;
  }
  if (byPhoneme.size === 0) return newCards;

  const phonemes = [...byPhoneme.keys()];
  const existing = await db
    .select()
    .from(phonemeMastery)
    .where(inArray(phonemeMastery.phoneme, phonemes));
  const existingMap = new Map(existing.filter((e) => e.userId === userId).map((e) => [e.phoneme, e]));

  for (const [phoneme, scores] of byPhoneme) {
    const sessionAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sessionBest = Math.max(...scores);
    const prev = existingMap.get(phoneme);
    const attemptsCount = (prev?.attempts ?? 0) + 1;
    const avg = prev?.avgScore != null
      ? (prev.avgScore * (attemptsCount - 1) + sessionAvg) / attemptsCount
      : sessionAvg;
    const best = Math.max(prev?.bestScore ?? 0, sessionBest);
    const trend = [...(safeArray(prev?.trendJson) as { t: string; s: number }[]), { t: createdAt, s: Math.round(sessionAvg * 10) / 10 }].slice(-10);

    await db
      .insert(phonemeMastery)
      .values({
        userId,
        phoneme,
        attempts: attemptsCount,
        avgScore: round1(avg),
        bestScore: round1(best),
        lastScore: round1(sessionAvg),
        trendJson: JSON.stringify(trend),
        updatedAt: createdAt,
      })
      .onConflictDoUpdate({
        target: [phonemeMastery.userId, phonemeMastery.phoneme],
        set: {
          attempts: attemptsCount,
          avgScore: round1(avg),
          bestScore: round1(best),
          lastScore: round1(sessionAvg),
          trendJson: JSON.stringify(trend),
          updatedAt: createdAt,
        },
      });

    // 弱音素自动进错音本
    if (avg < 75 || sessionAvg < 60) {
      const created = await ensureCard(userId, "phoneme", phoneme, createdAt);
      if (created) newCards += 1;
    }
  }
  return newCards;
}

export async function ensureCard(
  userId: string,
  kind: "phoneme" | "word" | "sentence",
  ref: string,
  createdAt = nowIso(),
): Promise<boolean> {
  const db = getDb();
  const dup = await db
    .select({ id: srsCards.id })
    .from(srsCards)
    .where(and(eq(srsCards.userId, userId), eq(srsCards.kind, kind), eq(srsCards.ref, ref)))
    .limit(1);
  if (dup.length > 0) return false;
  await db
    .insert(srsCards)
    .values({
      // 不透明 id：避免把音素符号（IPA）写进 id 从而泄漏到儿童页面的 RSC 负载里
      id: baseId("srs"),
      userId,
      kind,
      ref,
      ease: 2.5,
      intervalDays: 0,
      dueAt: createdAt,
      reps: 0,
      lapses: 0,
      lastGrade: null,
      createdAt,
    })
    .onConflictDoNothing();
  return true;
}

export function severityRank(s: Severity): number {
  return s === "high" ? 0 : s === "medium" ? 1 : 2;
}

export function issueHintTitle(hintKey: string | null | undefined): string {
  return getHint(hintKey).title_zh;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function safeArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
