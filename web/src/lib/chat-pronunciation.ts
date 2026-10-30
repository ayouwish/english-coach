/**
 * 对话轮次的发音评估（task-57）。
 *
 * 对话是 **unscripted**（没有参考文本）→ 用 voice `/v1/pronounce` 的 unscripted 模式：
 * `reference_text=""`、`mode=unscripted`、音素粒度。
 *
 * 设计：
 *  - **不阻塞对话**：LLM 回复先给用户，评分在 `after()` 里后台跑，结果写 `chat_messages.pron_json`；
 *  - 只存精简结果（分数 + 最弱 1–2 个音 + 逐词），不存整份庞大数据；
 *  - **儿童**：入库前就把 IPA 符号剥掉（只留非 IPA 的名字），页面也只显示正向提示、不显示分数；
 *  - 失败：保持 NULL（页面显示「—」），不崩、不静默（服务端有 warning 日志）。
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages } from "@/db/schema";
import type { SessionUser } from "./auth";
import { shortPhonemeName } from "./encouragement";
import type { PronounceResult } from "./types";
import { callPronounce, getCapabilities, VoiceError } from "./voice";

export interface ChatPronWeak {
  /** 音素符号（**儿童为 null**，不把 IPA 写进儿童可见数据） */
  ipa: string | null;
  /** 非 IPA 的短名字（th / s / 衣 …） */
  label: string;
  score: number | null;
}

export interface ChatPron {
  pron: number | null;
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  weak_phonemes: ChatPronWeak[];
  words: { word: string; score: number | null }[];
}

/** 把 voice 的评测结果压成精简版；儿童版不含任何 IPA 字形 */
export function compactPronunciation(result: PronounceResult, isChild: boolean): ChatPron {
  const issues = (result.issues ?? [])
    .filter((i) => typeof i.score === "number" && i.phoneme)
    .sort((a, b) => (a.score as number) - (b.score as number));
  const seen = new Set<string>();
  const weak: ChatPronWeak[] = [];
  for (const issue of issues) {
    const phoneme = issue.phoneme as string;
    if (seen.has(phoneme)) continue;
    seen.add(phoneme);
    const label = shortPhonemeName(phoneme) ?? (isChild ? "这个音" : phoneme);
    weak.push({
      ipa: isChild ? null : phoneme,
      label,
      score: typeof issue.score === "number" ? Math.round(issue.score * 10) / 10 : null,
    });
    if (weak.length >= 2) break;
  }
  return {
    pron: typeof result.scores?.pron === "number" ? Math.round(result.scores.pron * 10) / 10 : null,
    accuracy: typeof result.scores?.accuracy === "number" ? Math.round(result.scores.accuracy * 10) / 10 : null,
    fluency: typeof result.scores?.fluency === "number" ? Math.round(result.scores.fluency * 10) / 10 : null,
    completeness:
      typeof result.scores?.completeness === "number" ? Math.round(result.scores.completeness * 10) / 10 : null,
    weak_phonemes: weak,
    words: (result.words ?? []).slice(0, 40).map((w) => ({
      word: w.word,
      score: typeof w.score === "number" ? Math.round(w.score * 10) / 10 : null,
    })),
  };
}

/** 后台给某条用户对话消息评分（失败保持 NULL，不抛出到调用方） */
export async function scoreChatTurn(input: {
  user: SessionUser;
  messageId: string;
  audio: { data: Uint8Array; mime: string; ext: string };
  durationMs?: number | null;
}): Promise<ChatPron | null> {
  try {
    const caps = await getCapabilities();
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(input.audio.data)], { type: input.audio.mime }), `audio.${input.audio.ext}`);
    form.append("reference_text", ""); // unscripted：没有参考文本
    form.append("mode", "unscripted");
    form.append("granularity", caps.capabilities.phoneme_level ? "phoneme" : "word");
    form.append("with_intonation", String(caps.reachable ? caps.capabilities.intonation_curve : true));
    form.append("learner_age_band", input.user.ageBand);
    if (input.durationMs) form.append("duration_ms", String(input.durationMs));

    const result = await callPronounce(form);
    const pron = compactPronunciation(result, input.user.isChild);
    await getDb()
      .update(chatMessages)
      .set({ pronJson: JSON.stringify(pron) })
      .where(eq(chatMessages.id, input.messageId));
    return pron;
  } catch (err) {
    const msg = err instanceof VoiceError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    // 不静默：服务端留日志；前端对 NULL 显示「—」
    console.warn(`[chat-pron] 评分失败（不影响对话）：${msg}`);
    return null;
  }
}

/** 读取一条消息的发音数据（解析失败按 NULL 处理） */
export function parsePron(raw: string | null): ChatPron | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ChatPron;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
