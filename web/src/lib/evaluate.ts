import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { attempts } from "@/db/schema";
import { saveAudio } from "./audio";
import { HttpError, type SessionUser } from "./auth";
import { persistAttempt, WEB_WARNING_PENDING_RETRY } from "./attempt-service";
import { buildLocalFeedback } from "./fallback";
import { getCapabilities, callFeedback, callPronounce, VoiceError } from "./voice";
import type { FeedbackResult, PronounceResult } from "./types";
import { getDailyUsage, type DailyUsage } from "./usage";
import { blindProgress, requireOpenBlindTest } from "./blind-test";

export interface EvaluateInput {
  user: SessionUser;
  sentenceId: string | null;
  referenceText: string;
  mode: "scripted" | "unscripted";
  audio?: { data: Uint8Array; mime: string } | null;
  existingAudioPath?: string | null;
  durationMs?: number | null;
  /** 盲测批次 id：走 §13.3 的"进行中不返分"路径 */
  blindTestId?: string | null;
}

export interface EvaluateOutput {
  attemptId: string;
  blind: boolean;
  result: PronounceResult | null;
  /** 盲测时恒为 null：进行中不给任何反馈（§13.3 第 1 条） */
  feedback: FeedbackResult | null;
  degraded: boolean;
  retryable: boolean;
  message: string;
  detail: PronounceResult["intonation"] | null;
  usage: DailyUsage;
  progress?: { done: number; total: number };
}

/**
 * 盲测进行中的响应体 —— **白名单构造**，绝不 spread 任何含分数的对象。
 * 契约 §13.3 第 1 条：只返回 { attempt_id, blind, progress }。
 */
export function blindAttemptResponse(out: EvaluateOutput) {
  return {
    attempt_id: out.attemptId,
    blind: true as const,
    progress: out.progress ?? { done: 0, total: 0 },
  };
}

/**
 * 跟读评测主流程（POST /api/attempts 与 retry 共用）。
 * 契约 §9：pronounce 失败时保存音频与参考文本，返回"稍后可重试"的降级结果，绝不丢数据。
 */
export async function evaluateAttempt(input: EvaluateInput): Promise<EvaluateOutput> {
  const { user } = input;
  const caps = await getCapabilities();

  // 盲测入口校验：批次属于本人、仍在进行中、句子属于该批次（防止把盲测分数混进日常记录）
  let blind = false;
  let blindTotal = 0;
  if (input.blindTestId) {
    const test = await requireOpenBlindTest(user, input.blindTestId);
    blind = true;
    blindTotal = test.sentence_ids.length;
    if (input.sentenceId && !test.sentence_ids.includes(input.sentenceId)) {
      throw new HttpError(400, "bad_request", "这句话不属于本次盲测");
    }
  }

  let audioRelativePath = input.existingAudioPath ?? null;
  if (input.audio) {
    const ext = input.audio.mime.includes("wav")
      ? "wav"
      : input.audio.mime.includes("mp4")
        ? "m4a"
        : input.audio.mime.includes("ogg")
          ? "ogg"
          : "webm";
    audioRelativePath = saveAudio(user.id, input.audio.data, ext).relativePath;
  }

  let result: PronounceResult | null = null;
  const warnings: string[] = [];
  let failureMessage = "";

  if (input.audio) {
    const form = new FormData();
    form.append(
      "audio",
      new Blob([new Uint8Array(input.audio.data)], { type: input.audio.mime || "audio/webm" }),
      `audio.${audioRelativePath?.split(".").pop() ?? "webm"}`,
    );
    form.append("reference_text", input.referenceText);
    form.append("mode", input.mode);
    // 能力自适应：只有 health 明确说 phoneme_level=false 才降级要 word 级；
    // 探测不到（voice 未就绪）时按契约默认 phoneme，由 provider 自己降级并在 warnings 里说明，
    // 否则会给一个本来支持音素级的 provider 发出"降级"请求。
    const phonemeLevel = caps.reachable ? caps.capabilities.phoneme_level : true;
    form.append("granularity", phonemeLevel ? "phoneme" : "word");
    // 语调曲线不依赖云 API（契约 §3.1），可用时必须请求
    const withIntonation = caps.reachable ? caps.capabilities.intonation_curve : true;
    form.append("with_intonation", String(withIntonation));
    form.append("learner_age_band", user.ageBand);
    if (input.durationMs) form.append("duration_ms", String(input.durationMs));

    try {
      result = await callPronounce(form);
    } catch (err) {
      const ve = err instanceof VoiceError ? err : null;
      warnings.push("provider_fallback");
      failureMessage = ve ? `${ve.code}: ${ve.message}` : String(err);
      console.warn("[pronounce] 降级：", failureMessage);
    }
  } else {
    warnings.push("provider_fallback");
    failureMessage = "没有可用的音频数据";
  }

  let feedback: FeedbackResult | null = null;
  if (blind) {
    // 盲测进行中：不生成也不返回任何反馈/分数
    feedback = null;
  } else if (result) {
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
          worst_regions: (result.intonation?.worst_regions ?? []).map((r) => ({
            text: r.text,
            issue: r.issue,
          })),
        },
        learner: {
          age_band: user.ageBand,
          level: user.cefrLevel,
          native_language: user.nativeLanguage,
        },
      });
    } catch {
      // 契约 §5：LLM 不可用时也必须给出可用反馈
      feedback = buildLocalFeedback(result, { isChild: user.isChild });
    }
  } else {
    feedback = {
      provider: "template-web",
      summary: user.isChild ? "录音已经保存好了 ⏳" : "录音与文本已保存。",
      praise: user.isChild ? "你刚才读的那句话我记下来了。" : "本次录音与参考文本已入库。",
      points: [],
      closing: "稍后可以点「重试评测」，不用重新录音。",
    };
  }

  const persisted = await persistAttempt({
    user,
    sentenceId: input.sentenceId,
    mode: input.mode,
    referenceText: input.referenceText,
    audioRelativePath,
    durationMs: input.durationMs ?? null,
    result,
    extraWarnings: warnings,
    isBlind: blind,
    blindTestId: blind ? (input.blindTestId ?? null) : null,
  });

  if (feedback) {
    await getDb()
      .update(attempts)
      .set({ feedbackJson: JSON.stringify(feedback) })
      .where(eq(attempts.id, persisted.attemptId));
  }

  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);
  const degraded = persisted.degraded;

  return {
    attemptId: persisted.attemptId,
    blind,
    result,
    feedback,
    degraded,
    retryable: degraded || persisted.warnings.includes(WEB_WARNING_PENDING_RETRY),
    message: blind
      ? "已记录，继续下一句"
      : degraded
        ? `评测服务暂时不可用，录音和文本已经保存，稍后可重试${failureMessage ? `（${failureMessage}）` : ""}`
        : "评测完成",
    detail: result?.intonation ?? null,
    usage,
    progress: blind ? await blindProgress(input.blindTestId as string, blindTotal) : undefined,
  };
}
