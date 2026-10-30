/**
 * 连读模式的**异步评分**（task-24）。
 *
 * 形态 A（用户已确认）：录完一句立刻返回、**不等待评分**；评分在后台排队算，
 * 结果陆续出现在前端列表里。
 *
 * 关键约束：
 *   - `POST /api/attempts/async` 只做「校验 + 存音频 + 写 pending 行」，必须快速返回；
 *   - 后台并发**最多 2**（避免一次打满云 TTS/评测并发）；
 *   - 服务重启时把遗留 `pending/scoring` 标成 `failed`（见 ensureBootstrap），否则永远卡"评分中"；
 *   - 自由文本用 `sentence_id = custom:<sha1前12位>`：为了满足 attempts.sentence_id 的外键，
 *     会在 sentences 里插一条 `source='flow-custom'` 的行（**不会**出现在语料/练习列表里）。
 *
 * SRS/掌握度的取舍（任务要求说明）：
 *   - **音素掌握度 / 逐音素明细 / 错音卡片：照常更新**。它们记录的是"这个音发得怎么样"，
 *     与句子是否来自官方语料无关；不更新会让连读模式练到的弱音白白丢掉。
 *   - **句子级 SRS 卡片：不创建**（本项目的错音本本来就只有 phoneme/word 卡片，
 *     custom 句子也无法在 /api/sentences?focus= 里被检索到）。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, getSqlite } from "@/db";
import { attempts, sentences } from "@/db/schema";
import { persistEvaluationDetails } from "./attempt-service";
import { resolveAudioPath, saveAudio } from "./audio";
import { getSessionUserById, type SessionUser } from "./auth";
import { buildLocalFeedback } from "./fallback";
import type { FeedbackResult, PronounceResult } from "./types";
import { recordPracticeTime } from "./usage";
import { callFeedback, callPronounce, getCapabilities } from "./voice";

export const MAX_CONCURRENT_SCORING = 2;
export const FLOW_CUSTOM_SOURCE = "flow-custom";
const RESTART_ERROR = "服务重启，未完成评分";

// ── 后台评分并发控制（最多 2 个）──────────────────────────────────────────────
const running = new Set<string>();
const waiting: string[] = [];

function drain() {
  while (running.size < MAX_CONCURRENT_SCORING && waiting.length > 0) {
    const id = waiting.shift() as string;
    running.add(id);
    void scoreAttempt(id)
      .catch((err) => console.error("[flow] 后台评分异常", id, err))
      .finally(() => {
        running.delete(id);
        drain();
      });
  }
}

export function enqueueScoring(attemptId: string): void {
  waiting.push(attemptId);
  drain();
}

/** 自测/调试用：当前排队与在跑的数量 */
export function scoringStats(): { running: number; waiting: number } {
  return { running: running.size, waiting: waiting.length };
}

/** 自由文本句子：写一条 flow-custom 的 sentences 行（满足外键），id 形如 custom:<sha1-12> */
export async function ensureCustomSentence(user: SessionUser, text: string): Promise<string> {
  const hash = createHash("sha1").update(`${user.id}\u001f${text}`).digest("hex").slice(0, 12);
  const id = `custom:${hash}`;
  const db = getDb();
  const existing = await db.select({ id: sentences.id }).from(sentences).where(eq(sentences.id, id)).limit(1);
  if (existing.length === 0) {
    await db
      .insert(sentences)
      .values({
        id,
        text,
        translationZh: "",
        level: user.cefrLevel || "A1",
        tags: "[]",
        focusPhonemes: "[]",
        source: FLOW_CUSTOM_SOURCE,
        ownerUserId: user.id,
        sortOrder: 999_999,
      })
      .onConflictDoNothing();
  }
  return id;
}

export interface PendingAttemptInput {
  user: SessionUser;
  referenceText: string;
  sentenceId: string | null;
  mode: "scripted" | "unscripted";
  audio: { data: Uint8Array; mime: string };
  durationMs: number | null;
  source: "corpus" | "custom";
  /** 盲测批次（task-33）：有值时 is_blind=1、盲测进行中不生成反馈、不写掌握度/SRS */
  blindTestId?: string | null;
  /** 读的是哪个故事/材料（task-50 P1）：用于"听我上次读的"与故事详情趋势 */
  materialId?: string | null;
}

/** 只做"存音频 + 写 pending 行"，不做任何评测（保证接口快速返回） */
export async function createPendingAttempt(input: PendingAttemptInput): Promise<string> {
  const { user } = input;
  const ext = input.audio.mime.includes("wav")
    ? "wav"
    : input.audio.mime.includes("mp4")
      ? "m4a"
      : input.audio.mime.includes("ogg")
        ? "ogg"
        : "webm";
  const saved = saveAudio(user.id, input.audio.data, ext);

  const sentenceId =
    input.source === "custom" || (input.sentenceId ?? "").startsWith("custom:")
      ? await ensureCustomSentence(user, input.referenceText)
      : input.sentenceId;

  const db = getDb();
  const id = `att_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const createdAt = new Date().toISOString();
  await db.insert(attempts).values({
    id,
    userId: user.id,
    sentenceId: sentenceId ?? null,
    mode: input.mode,
    referenceText: input.referenceText,
    recognizedText: null,
    scoresJson: null,
    issuesJson: null,
    intonationJson: null,
    feedbackJson: null,
    audioPath: saved.relativePath,
    refAudioUrl: null,
    durationMs: input.durationMs,
    warningsJson: "[]",
    materialId: input.materialId ?? null,
    isBlind: input.blindTestId ? 1 : 0,
    blindTestId: input.blindTestId ?? null,
    status: "pending",
    scoredAt: null,
    error: null,
    createdAt,
  });
  return id;
}

/** 后台评分：pending → scoring → done/failed，并把逐音素明细/掌握度写进库 */
export async function scoreAttempt(attemptId: string): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(attempts).where(eq(attempts.id, attemptId)).limit(1);
  if (!row) return;
  if (row.status === "done" || row.status === "failed") return;

  await db.update(attempts).set({ status: "scoring" }).where(eq(attempts.id, attemptId));

  try {
    const user = await getSessionUserById(row.userId);
    if (!user) throw new Error("提交人不存在");
    const abs = row.audioPath ? resolveAudioPath(row.audioPath) : null;
    if (!abs || !fs.existsSync(abs)) throw new Error("录音文件不存在");
    const data = new Uint8Array(fs.readFileSync(abs));

    const blind = row.isBlind === 1;
    const caps = await getCapabilities();
    // 按落盘扩展名还原真实 MIME（不能一律写成 webm：voice 会按声明格式选解码器）
    const ext = (row.audioPath ?? "").split(".").pop()?.toLowerCase() ?? "webm";
    const mime =
      ext === "wav" ? "audio/wav" : ext === "mp3" ? "audio/mpeg" : ext === "m4a" || ext === "mp4" ? "audio/mp4" : ext === "ogg" ? "audio/ogg" : "audio/webm";
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(data)], { type: mime }), `audio.${ext}`);
    form.append("reference_text", row.referenceText);
    form.append("mode", row.mode);
    form.append("granularity", caps.capabilities.phoneme_level ? "phoneme" : "word");
    form.append("with_intonation", String(caps.reachable ? caps.capabilities.intonation_curve : true));
    form.append("learner_age_band", user.ageBand);
    if (row.durationMs) form.append("duration_ms", String(row.durationMs));

    const result: PronounceResult = await callPronounce(form);

    let feedback: FeedbackResult | null = null;
    if (!blind)
    try {
      feedback = await callFeedback({
        reference_text: result.reference_text,
        scores: result.scores,
        issues: (result.issues ?? []).map((i) => ({
          type: i.type,
          word: i.word,
          phoneme: i.phoneme ?? null,
          actual: i.actual ?? null,
          score: i.score ?? null,
        })),
        intonation: {
          dtw_distance: result.intonation?.dtw_distance ?? null,
          worst_regions: (result.intonation?.worst_regions ?? []).map((r) => ({ text: r.text, issue: r.issue })),
        },
        learner: { age_band: user.ageBand, level: user.cefrLevel, native_language: user.nativeLanguage },
      });
    } catch {
      feedback = buildLocalFeedback(result, { isChild: user.isChild });
    }

    const scoredAt = new Date().toISOString();
    await db
      .update(attempts)
      .set({
        status: "done",
        scoredAt,
        recognizedText: result.recognized_text,
        scoresJson: JSON.stringify(result.scores),
        issuesJson: JSON.stringify(result.issues ?? []),
        intonationJson: JSON.stringify(result.intonation ?? null),
        feedbackJson: blind ? null : JSON.stringify(feedback),
        refAudioUrl: result.intonation?.reference_audio_url ?? null,
        durationMs: result.duration_ms,
        warningsJson: JSON.stringify(result.warnings ?? []),
        error: null,
      })
      .where(eq(attempts.id, attemptId));

    // 逐音素明细 + 掌握度 + 错音卡片（见文件头"SRS/掌握度的取舍"）
    // 盲测：**不写**（契约 §13.3 第 2 条：is_blind 不参与 phoneme_mastery / 趋势 / SRS）
    if (!blind) {
      await persistEvaluationDetails({ user, attemptId, result, createdAt: row.createdAt });
    }

    await recordPracticeTime({
      userId: user.id,
      kind: blind ? "blindtest" : "pronounce",
      id: attemptId,
      minutes: result.duration_ms / 60_000,
      itemCount: 1,
      startedAt: row.createdAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[flow] 评分失败 ${attemptId}: ${message}`);
    await db
      .update(attempts)
      .set({ status: "failed", scoredAt: new Date().toISOString(), error: message.slice(0, 500) })
      .where(eq(attempts.id, attemptId));
  }
}

/** 查询一批 attempt 的评分状态（前端轮询用） */
export async function getAttemptStatuses(
  userId: string,
  ids: string[],
): Promise<
  {
    id: string;
    status: string;
    error: string | null;
    scored_at: string | null;
    scores: PronounceResult["scores"] | null;
    recognized_text: string | null;
    issues: PronounceResult["issues"] | null;
    intonation: PronounceResult["intonation"] | null;
    feedback: FeedbackResult | null;
  }[]
> {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(attempts)
    .where(inArray(attempts.id, ids));
  return rows
    .filter((r) => r.userId === userId)
    .map((r) => ({
      id: r.id,
      status: r.status,
      error: r.error,
      scored_at: r.scoredAt,
      scores: safeParse(r.scoresJson),
      recognized_text: r.recognizedText,
      issues: safeParse(r.issuesJson),
      intonation: safeParse(r.intonationJson),
      feedback: safeParse(r.feedbackJson),
    }));
}

/** 重启恢复：把遗留的 pending/scoring 标记为 failed（避免永远卡"评分中"） */
export function recoverStuckAttempts(): number {
  const sqlite = getSqlite();
  const info = sqlite
    .prepare(
      "UPDATE attempts SET status = 'failed', error = ?, scored_at = ? WHERE status IN ('pending','scoring')",
    )
    .run(RESTART_ERROR, new Date().toISOString());
  return Number(info.changes ?? 0);
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
