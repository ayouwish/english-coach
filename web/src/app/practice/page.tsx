import { redirect } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb, getSqlite } from "@/db";
import { attempts, sentences } from "@/db/schema";
import { NoSpeechNotice, ReadonlyResultSections, type ResultSnapshot } from "@/components/ResultSections";
import { getCurrentUser } from "@/lib/auth";
import { childSafeDeep } from "@/lib/child-safe";
import { parseJsonArray, parseJsonObject } from "@/lib/http";
import { isSpeechMissing } from "@/lib/speech-detection";
import { getCapabilities } from "@/lib/voice";
import { getDailyUsage } from "@/lib/usage";
import type { Intonation, PronounceIssue, PronounceResult, SentenceItem } from "@/lib/types";
import { PracticeClient } from "./PracticeClient";

export const dynamic = "force-dynamic";

/**
 * attempts 表没有 words_json 列（契约 §10 未含），但 phoneme_scores 里有逐音素/逐词明细。
 * 这里按插入顺序还原"逐词得分"，用于渲染"上一次的结果"（同名单词会合并，只读展示足够）。
 */
function wordsFromPhonemeScores(attemptId: string): PronounceResult["words"] {
  const rows = getSqlite()
    .prepare("SELECT word, score FROM phoneme_scores WHERE attempt_id = ? ORDER BY rowid")
    .all(attemptId) as { word: string; score: number | null }[];
  const order: string[] = [];
  const acc = new Map<string, number[]>();
  for (const r of rows) {
    if (!acc.has(r.word)) {
      acc.set(r.word, []);
      order.push(r.word);
    }
    if (typeof r.score === "number") acc.get(r.word)?.push(r.score);
  }
  return order.map((word) => {
    const list = acc.get(word) ?? [];
    const avg = list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
    return {
      word,
      score: avg === null ? null : Math.round(avg * 10) / 10,
      start_ms: null,
      end_ms: null,
      error_type: null,
    };
  });
}

export default async function PracticePage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const db = getDb();
  const rows = await db.select().from(sentences).orderBy(asc(sentences.sortOrder));
  const caps = await getCapabilities();
  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);

  // 上一次（非盲测）结果：页面加载即可见 + 整句没听到时直接给提示。
  // 盲测记录一律排除（契约 §13.3：进行中的盲测不能出现任何分数）。
  const [lastRow] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.userId, user.id), eq(attempts.isBlind, 0)))
    .orderBy(desc(attempts.createdAt))
    .limit(1);

  const rawSnapshot: ResultSnapshot | null = lastRow
    ? {
        attempt_id: lastRow.id,
        created_at: lastRow.createdAt,
        recognized_text: lastRow.recognizedText,
        provider: null,
        granularity: null,
        duration_ms: lastRow.durationMs,
        scores: parseJsonObject<PronounceResult["scores"]>(lastRow.scoresJson),
        words: wordsFromPhonemeScores(lastRow.id),
        issues: (parseJsonObject<PronounceIssue[]>(lastRow.issuesJson) ?? []) as PronounceIssue[],
        intonation: parseJsonObject<Intonation>(lastRow.intonationJson),
        warnings: parseJsonArray(lastRow.warningsJson) as string[],
      }
    : null;

  // 儿童：整个快照兜底剥离 IPA。它会作为 props 传给 client 组件（F0Chart / IssueList），
  // 从而被序列化进 RSC 负载 —— 所以必须在服务端就清干净。
  const snapshot =
    rawSnapshot && user.isChild ? childSafeDeep(rawSnapshot, "practice.lastResult") : rawSnapshot;

  const lastNoSpeech =
    snapshot !== null &&
    isSpeechMissing({ recognized_text: snapshot.recognized_text, warnings: snapshot.warnings });

  const items: SentenceItem[] = rows.map((r) => ({
    id: r.id,
    text: r.text,
    translation_zh: r.translationZh,
    level: r.level,
    tags: JSON.parse(r.tags) as string[],
    // 儿童模式：focus_phonemes 一律不下发到 HTML（IPA 不能出现在儿童的页面里）
    focus_phonemes: user.isChild ? [] : (JSON.parse(r.focusPhonemes) as string[]),
  }));

  return (
    <div className="flex flex-col gap-5">
      <PracticeClient
        sentences={items}
        isChild={user.isChild}
        userLevel={user.cefrLevel}
        capabilities={caps.capabilities}
        voiceReachable={caps.reachable}
        voiceMode={caps.mode}
        initialUsage={usage}
      />

      {snapshot && lastNoSpeech ? (
        <NoSpeechNotice isChild={user.isChild} recognizedText={snapshot.recognized_text} />
      ) : null}

      {snapshot && !lastNoSpeech ? (
        <details className="ec-card" data-testid="last-result">
          <summary className="cursor-pointer font-bold">
            上一次的结果（{new Date(snapshot.created_at ?? Date.now()).toLocaleString("zh-CN")}）· 只读
          </summary>
          <p className="mt-2 text-xs text-[var(--ec-muted)]">重新录音后，这里会换成新的结果。</p>
          <div className="mt-3">
            <ReadonlyResultSections
              snapshot={snapshot}
              isChild={user.isChild}
              phonemeLevel={caps.capabilities.phoneme_level}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
