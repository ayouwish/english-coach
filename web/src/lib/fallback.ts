/**
 * web 侧最后一道离线兜底：voice 完全不可用时也能给出可用反馈/对话（契约 §5、§6 的降级语义）。
 * 注意：child 文案一律不含 IPA 符号。
 */
import { getChildHint, getHint } from "./hints";
import type { DialogueResult, FeedbackPoint, FeedbackResult, PronounceResult } from "./types";

export function scoreBandZh(score: number | null): { label: string; emoji: string } {
  if (score === null) return { label: "待重试", emoji: "⏳" };
  if (score >= 90) return { label: "非常棒", emoji: "🌟" };
  if (score >= 80) return { label: "很好", emoji: "🎉" };
  if (score >= 70) return { label: "不错", emoji: "👍" };
  if (score >= 60) return { label: "继续加油", emoji: "💪" };
  return { label: "再来一次会更好", emoji: "🌱" };
}

export function buildLocalFeedback(
  result: PronounceResult,
  opts: { isChild: boolean },
): FeedbackResult {
  const pron = result.scores?.pron ?? null;
  const band = scoreBandZh(pron);
  const goodWords = (result.words ?? [])
    .filter((w) => (w.score ?? 0) >= 80)
    .slice(0, 3)
    .map((w) => w.word);
  const issues = (result.issues ?? []).slice(0, 2);

  const points: FeedbackPoint[] = issues.map((issue) => {
    const hint = getHint(issue.hint_key);
    const child = getChildHint(issue.hint_key);
    return {
      title: opts.isChild ? child.title : hint.title_zh,
      why: opts.isChild ? child.why : hint.why_zh,
      how: opts.isChild ? child.how : hint.how_zh,
      practice_words: hint.practice_words,
      demo_text: hint.demo_text || issue.word,
      severity: issue.severity,
    };
  });

  const praise = opts.isChild
    ? goodWords.length > 0
      ? `${goodWords.join("、")} 这些词说得特别清楚！`
      : "你完整地把这句话说完了，很棒！"
    : goodWords.length > 0
      ? `${goodWords.join(" / ")} 读得很清楚。`
      : "整句都读完啦，节奏保持得不错。";

  return {
    provider: "template-web",
    summary: `${band.emoji} 这次得分 ${pron === null ? "—" : Math.round(pron)} 分，${band.label}。`,
    praise,
    points,
    closing: opts.isChild ? "我们再读一次好不好？我读一句你跟一句 🔊" : "再录一遍试试？先听示范音 🔊",
  };
}

export function isChildUnsafeSpeech(text: string): boolean {
  const bad = ["stupid", "idiot", "dumb", "hate you", "shut up", "kill", "ugly", "fat"];
  const lower = text.toLowerCase();
  return bad.some((w) => lower.includes(w));
}

const DEFAULT_FALLBACK_REPLIES_ZH = [
  "很好！可以再多说一点吗？",
  "明白了，那你最喜欢哪一个？",
  "不错！我们再聊一句就结束啦。",
];

export function buildLocalDialogue(opts: {
  openingLine: string;
  history: { role: "user" | "assistant"; text: string }[];
  isChild: boolean;
  level: string;
  scenarioId: string;
}): DialogueResult {
  const assistantTurns = opts.history.filter((h) => h.role === "assistant").length;
  const done = assistantTurns >= 3;
  const reply = done
    ? opts.isChild
      ? "Great job today! See you next time! 👋"
      : "Thanks for practising with me. See you next time!"
    : opts.isChild
      ? "Nice! Can you tell me more?"
      : "That sounds interesting. Could you say a little more about that?";

  return {
    provider: "fallback-web",
    reply,
    reply_zh: done ? "今天就到这里，下次见！" : "不错！能再多说一点吗？",
    correction: {
      has_error: false,
      type: null,
      original: null,
      better: null,
      explain_zh: null,
      severity: null,
    },
    suggested_replies: opts.isChild
      ? ["Yes, I do.", "It is fun!", "Thank you!"]
      : ["Sure, I can do that.", "That sounds good.", "I think so too."],
    target_words: [],
    flag: "ok",
    done,
  };
}

export const FALLBACK_REPLIES_ZH = DEFAULT_FALLBACK_REPLIES_ZH;
