import { F0Chart } from "@/components/F0Chart";
import { IssueList } from "@/components/IssueList";
import { ScoreRadar } from "@/components/ScoreRadar";
import { WordBars } from "@/components/WordBars";
import { NO_SPEECH_HINT, NO_SPEECH_TITLE } from "@/lib/speech-detection";
import type { FeedbackResult, PronounceResult } from "@/lib/types";

/**
 * 跟读结果的展示区块（server / client 共用，都是无状态纯展示组件）。
 * 放在这里是为了让"刚录完的结果"和"页面刷新后看到的上一次结果"长得完全一样。
 */

export interface ResultSnapshot {
  scores: PronounceResult["scores"] | null;
  words: PronounceResult["words"];
  issues: PronounceResult["issues"];
  intonation: PronounceResult["intonation"] | null;
  recognized_text: string | null;
  provider: string | null;
  granularity: string | null;
  duration_ms: number | null;
  warnings: string[];
  created_at?: string;
  attempt_id: string;
}

/** task-14 D：整句没听到时的提示（不展示 0 分热力图） */
export function NoSpeechNotice({
  isChild,
  recognizedText,
  children,
}: {
  isChild: boolean;
  recognizedText?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <section
      className="ec-card border-2 border-[#f5c26b]"
      data-testid="no-speech-notice"
    >
      <h3 className="text-lg font-extrabold">
        🎤 {NO_SPEECH_TITLE}
        {isChild ? "，我们再来一次好吗？" : ""}
      </h3>
      <p className="mt-1 text-sm font-semibold">{NO_SPEECH_HINT}</p>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        这次录音几乎没有识别到内容（识别结果：{recognizedText && recognizedText.trim() ? `“${recognizedText}”` : "空"}
        ），所以没有给分 —— 不是读错了，重录一次就好。
      </p>
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}

export function PhonemeChips({
  words,
  phonemeLevel,
  isChild,
}: {
  words: PronounceResult["words"];
  phonemeLevel: boolean;
  isChild: boolean;
}) {
  // 儿童不展示音素（IPA）——硬约束
  if (isChild || !phonemeLevel) return null;
  const phonemes = (words ?? []).flatMap((w) => w.phonemes ?? []);
  if (phonemes.length === 0) return null;
  return (
    <div className="mt-4">
      <h4 className="text-sm font-bold text-[var(--ec-muted)]">音素明细</h4>
      <div className="mt-2 flex flex-wrap gap-2" data-testid="phoneme-chips">
        {phonemes.map((p, i) => (
          <span
            key={`${p.phoneme}-${i}`}
            className="rounded-lg border border-[#e6e8f5] px-2 py-1 text-sm"
            style={{
              background:
                p.score === null
                  ? "#eef0f8"
                  : p.score >= 80
                    ? "rgba(22,163,74,0.16)"
                    : p.score >= 60
                      ? "rgba(245,158,11,0.18)"
                      : "rgba(239,68,68,0.18)",
            }}
          >
            <strong>{p.phoneme}</strong>
            {p.score === null ? " —" : ` ${Math.round(p.score)}`}
            {p.nbest && p.nbest.length > 1 ? (
              <span className="ml-1 text-xs text-[var(--ec-muted)]">≈{p.nbest[1].phoneme}</span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

export function IntonationSection({
  intonation,
  isChild,
}: {
  intonation: PronounceResult["intonation"] | null;
  isChild: boolean;
}) {
  if (!intonation || (!intonation.available && (intonation.user_f0?.length ?? 0) === 0)) return null;
  return (
    <section className="ec-card" data-testid="intonation-card">
      <h3 className="text-lg font-bold">{isChild ? "🎵 声音的高低对比" : "语调对比（F0 双曲线）"}</h3>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        蓝线是你的音高，虚线是示范音；红色区间是差异最大的片段（已做 DTW 对齐）。
      </p>
      <div className="mt-3">
        <F0Chart
          userF0={intonation.user_f0 ?? []}
          referenceF0={intonation.reference_f0 ?? []}
          worstRegions={intonation.worst_regions ?? []}
          dtwDistance={intonation.dtw_distance}
          isChild={isChild}
        />
      </div>
      {intonation.worst_regions?.length ? (
        <ul className="mt-2 list-disc pl-5 text-sm text-[var(--ec-muted)]">
          {intonation.worst_regions.slice(0, 2).map((r, i) => (
            <li key={i}>
              「{r.text}」{regionLabel(r.issue)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function regionLabel(issue: string): string {
  const map: Record<string, string> = {
    expected_rise_but_flat: "示范音这里应该上扬，你读得比较平。",
    expected_fall_but_flat: "示范音这里应该下降，你读得比较平。",
    wrong_direction: "这里的升降方向反了。",
    stress_misplaced: "重音位置不太一样。",
    monotone_overall: "整句音调起伏偏小。",
    unexpected_pause: "这里多了一次停顿。",
  };
  return map[issue] ?? "这里的语调可以再调整。";
}

export function IssuesSection({
  issues,
  isChild,
  phonemeLevel,
}: {
  issues: PronounceResult["issues"];
  isChild: boolean;
  phonemeLevel: boolean;
}) {
  return (
    <section className="ec-card">
      <h3 className="text-lg font-bold">{isChild ? "🌱 一起改进一下" : "需要纠正的地方"}</h3>
      <div className="mt-3">
        <IssueList issues={issues ?? []} isChild={isChild} phonemeLevel={phonemeLevel} />
      </div>
    </section>
  );
}

export function FeedbackCard({
  feedback,
  isChild,
}: {
  feedback: FeedbackResult | null;
  isChild: boolean;
}) {
  if (!feedback) return null;
  return (
    <div className="ec-pop mt-4 rounded-xl bg-[var(--ec-primary-soft)] p-3">
      <p className="font-bold">
        {isChild ? "🌟 " : "🗣️ "}
        {feedback.summary}
      </p>
      {feedback.praise ? <p className="mt-1 text-sm">{feedback.praise}</p> : null}
      {feedback.points?.map((p, i) => (
        <div key={i} className="mt-2 rounded-lg bg-white/70 p-2 text-sm">
          <p className="font-semibold">{p.title}</p>
          <p className="text-[var(--ec-muted)]">{p.why}</p>
          <p>{p.how}</p>
          {p.practice_words?.length ? (
            <p className="text-[var(--ec-muted)]">练习词：{p.practice_words.join(" · ")}</p>
          ) : null}
        </div>
      ))}
      <p className="mt-2 text-sm">{feedback.closing}</p>
    </div>
  );
}

/** 只读的"上一次结果"（服务端渲染 /practice 时用） */
export function ReadonlyResultSections({
  snapshot,
  isChild,
  phonemeLevel,
}: {
  snapshot: ResultSnapshot;
  isChild: boolean;
  phonemeLevel: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="ec-card">
        <h3 className="text-lg font-bold">{isChild ? "📊 这一次的表现" : "能力多边形"}</h3>
        <div className="mt-3">
          <ScoreRadar scores={snapshot.scores ?? EMPTY_SCORES} isChild={isChild} />
        </div>
      </div>

      <div className="ec-card">
        <h3 className="text-lg font-bold">{isChild ? "🔤 每个词读得怎么样" : "逐词得分"}</h3>
        <div className="mt-3">
          <WordBars words={snapshot.words ?? []} isChild={isChild} />
        </div>
        <PhonemeChips words={snapshot.words ?? []} phonemeLevel={phonemeLevel} isChild={isChild} />
      </div>

      <IntonationSection intonation={snapshot.intonation} isChild={isChild} />
      <IssuesSection issues={snapshot.issues ?? []} isChild={isChild} phonemeLevel={phonemeLevel} />
    </div>
  );
}

export const EMPTY_SCORES: PronounceResult["scores"] = {
  pron: null,
  accuracy: null,
  fluency: null,
  completeness: null,
  prosody: null,
};
