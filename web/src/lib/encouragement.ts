/**
 * 读完后按表现分级播放鼓励语音（task-45）—— 纯逻辑层（无 React、无 DOM）。
 *
 * 设计要点：
 *  1. **成长型措辞，永不否定**：C 档（低分）也只说"勇敢/慢慢来"，文案池里不出现「错/差/失败/不行」。
 *  2. **6 个档**：S 突破 / A 不错 / B 认真 / C 勇敢 / 没听到 / 没读完（completeness < 60）。
 *  3. 每档 4–6 条同义文案；用 `hash(attemptId)` **确定性挑选**（禁止 Math.random / render 期随机，
 *     否则 SSR 与客户端水合不一致），并可传入最近 3 条避免连续重复。
 *  4. **具体化**：优先"比上次高 N 分"，其次最好的音素/单词；音素中文名复用 `articulation.ts`。
 *  5. 中英双语：中文（zh-CN-XiaoxiaoNeural）+ 英文（en-US-JennyNeural），由 UI 层顺序播放。
 */
import { ARTICULATIONS } from "./articulation";

export type EncouragementTier = "S" | "A" | "B" | "C" | "no_speech" | "incomplete";

export interface EncouragementVariant {
  zh: string;
  en: string;
}

/** 每档 5 条（要求 4–6） */
export const ENCOURAGEMENT_POOLS: Record<EncouragementTier, readonly EncouragementVariant[]> = {
  S: [
    { zh: "太棒了！这次特别清楚！", en: "Great job! That was so clear!" },
    { zh: "哇，这次读得特别棒！", en: "Wow, you did great!" },
    { zh: "进步好大，继续保持！", en: "Big progress! Keep going!" },
    { zh: "这次的声音又清楚又好听！", en: "That sounded clear and lovely!" },
    { zh: "太厉害了，一口气读下来了！", en: "Amazing! You read the whole thing!" },
  ],
  A: [
    { zh: "读得很好！继续这样就好。", en: "Nice reading! Keep it up." },
    { zh: "很稳！保持这个节奏。", en: "Very steady! Keep this rhythm." },
    { zh: "这次比上次更顺了。", en: "Smoother than last time!" },
    { zh: "很好，句子都读完整了。", en: "Good job finishing every sentence." },
    { zh: "听起来很棒，再来一次会更好。", en: "Sounds great! One more time will be even better." },
  ],
  B: [
    { zh: "很认真！再读一遍会更顺。", en: "Good try! Reading again will be smoother." },
    { zh: "看到你在努力，继续保持。", en: "I can see your effort. Keep going!" },
    { zh: "大部分都读到了，真棒！", en: "You got most of it. Nice work!" },
    { zh: "慢一点会更清楚，我们再试试。", en: "Slow down a little and try again." },
    { zh: "你的声音很响亮，很好！", en: "Your voice was nice and loud!" },
  ],
  C: [
    { zh: "谢谢你勇敢地读出来。我们慢慢来。", en: "Thank you for reading! Let's take our time." },
    { zh: "敢开口就很了不起，我们一起再试试。", en: "Speaking up is brave. Let's try together." },
    { zh: "今天已经在进步的路上了。", en: "You are on the way. Keep going!" },
    { zh: "我听到你的声音了，我们再练一次。", en: "I heard your voice! Let's practice again." },
    { zh: "一点点来，你已经在变好了。", en: "Little by little, you are getting better." },
  ],
  no_speech: [
    { zh: "这次好像没听到你的声音，我们再来一次好吗？", en: "Let's try again! I will listen." },
    { zh: "麦克风可能没收到，靠近一点再说一次吧。", en: "Come a little closer and say it again." },
    { zh: "没关系，我们深呼吸一下再来一次。", en: "No worries. Take a breath and try again." },
    { zh: "准备好了吗？我在这儿听着呢。", en: "Ready? I am listening." },
    { zh: "我们慢慢来，先大声说一句试试。", en: "Take your time. Say one sentence loudly." },
  ],
  incomplete: [
    { zh: "有几句话没读完，没关系，我们试试一口气读完。", en: "You can do it! Let's finish the whole page." },
    { zh: "读到一半也很好，下次把它读完吧。", en: "Halfway is good too. Let's finish next time." },
    { zh: "慢慢来，把每一句都读完就更棒了。", en: "Take your time and finish each sentence." },
    { zh: "我们已经读了一大半了，再读一点点就好。", en: "We are almost done. Just a little more." },
    { zh: "一句一句来，读完最后一句我们就成功啦。", en: "One sentence at a time. Let's finish the last one!" },
  ],
};

/** 文案池里绝不允许出现的否定词（成长型措辞的硬约束） */
export const NEGATIVE_WORDS = ["错", "差", "失败", "不行", "不好", "笨", "糟糕", "退步", "没用"];

/** 音素 → 短的、儿童可见的中文/字母名（不含 IPA；从 articulation.ts 的 childLabel 派生） */
export function shortPhonemeName(phoneme: string): string | null {
  const art = ARTICULATIONS[phoneme];
  if (!art) return null;
  const label = art.childLabel ?? "";
  // 末尾的拉丁字母（如 "舌尖伸到齿间吹气的 th" → "th"）
  const latin = /([A-Za-z]{1,4})\s*$/.exec(label)?.[1];
  const candidate = latin ?? /「([^」]+)」/.exec(label)?.[1] ?? art.examples?.[0] ?? null;
  if (!candidate) return null;
  // 保险：绝不把 IPA 字形带给儿童
  if (/[θðɹŋæʃɪʌɔɜəʊʒɑɒɛˈˌ]/.test(candidate)) return null;
  return candidate;
}

/** 确定性哈希（FNV-1a 32bit）—— 同一个 attemptId 永远选到同一条文案 */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface TierInput {
  /** 总分（scores.pron）；null = 没听到/没分数 */
  pron: number | null;
  /** 完整度（completeness），< 60 视为"没读完" */
  completeness?: number | null;
  /** 上一次的 pron（用于"比上次 +8"与具体化） */
  prevPron?: number | null;
  /** 服务端判定"没听到"（no speech） */
  noSpeech?: boolean;
}

/** 分档：no_speech > incomplete > S/A/B/C */
export function pickTier(input: TierInput): EncouragementTier {
  if (input.noSpeech) return "no_speech";
  if (input.pron === null || input.pron === undefined || !Number.isFinite(input.pron)) return "no_speech";
  if (typeof input.completeness === "number" && input.completeness < 60) return "incomplete";
  const pron = input.pron;
  const delta = typeof input.prevPron === "number" ? pron - input.prevPron : null;
  if (pron >= 85 || (delta !== null && delta >= 8)) return "S";
  if (pron >= 70) return "A";
  if (pron >= 55) return "B";
  return "C";
}

/**
 * 确定性挑选文案：`hash(attemptId + tier)` 定位，然后线性探测跳过"最近 3 条"。
 * 同一 attemptId + 同一 recent 组合结果稳定 → 不会造成 hydration mismatch。
 */
export function pickVariant(tier: EncouragementTier, attemptId: string, recentZh: readonly string[] = []): EncouragementVariant {
  const pool = ENCOURAGEMENT_POOLS[tier];
  const start = hashString(`${attemptId}:${tier}`) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(start + i) % pool.length];
    if (!recentZh.includes(candidate.zh)) return candidate;
  }
  return pool[start];
}

export interface SpecificPraiseInput {
  /** 比上一次高多少分（正数才有意义） */
  deltaPron?: number | null;
  /** 本次逐词得分（用于挑读得最好的词） */
  words?: { word: string; score: number | null }[] | null;
  /** 本次逐音素得分（可选；优先音素具体化） */
  phonemes?: { phoneme: string; score: number | null }[] | null;
  isChild?: boolean;
}

/** 具体化的一句（取不到就返回 null，绝不编造） */
export function specificPraise(input: SpecificPraiseInput): string | null {
  const delta = input.deltaPron;
  if (typeof delta === "number" && delta >= 3) {
    return input.isChild ? `比上次高了 ${Math.round(delta)} 分！` : `比上次高了 ${Math.round(delta)} 分。`;
  }
  const bestPhoneme = (input.phonemes ?? [])
    .filter((p) => typeof p.score === "number" && (p.score as number) >= 85)
    .sort((a, b) => (b.score as number) - (a.score as number))[0];
  if (bestPhoneme) {
    const name = shortPhonemeName(bestPhoneme.phoneme);
    if (name) return `你的 ${name} 音读得很清楚。`;
  }
  const bestWord = (input.words ?? [])
    .filter((w) => typeof w.score === "number" && (w.score as number) >= 85)
    .sort((a, b) => (b.score as number) - (a.score as number))[0];
  if (bestWord) return `「${bestWord.word}」这个词读得特别清楚。`;
  return null;
}

export interface Encouragement {
  tier: EncouragementTier;
  zh: string;
  en: string;
  /** 具体化补充句（可能为 null） */
  praise: string | null;
  /** 展示/朗读用：主句 + 具体化 */
  fullZh: string;
  fullEn: string;
}

/** 一站式：档位 → 文案 → 具体化（纯函数，可单测） */
export function buildEncouragement(input: TierInput & SpecificPraiseInput & { attemptId: string; recentZh?: readonly string[] }): Encouragement {
  const tier = pickTier(input);
  const variant = pickVariant(tier, input.attemptId, input.recentZh ?? []);
  const praise = specificPraise(input);
  const fullZh = praise ? `${variant.zh}${praise}` : variant.zh;
  return {
    tier,
    zh: variant.zh,
    en: variant.en,
    praise,
    fullZh,
    fullEn: variant.en,
  };
}

/** 各档中文档名（UI 上不显示"档位"，仅用于调试/日志） */
export const TIER_LABELS: Record<EncouragementTier, string> = {
  S: "突破",
  A: "不错",
  B: "认真",
  C: "勇敢",
  no_speech: "没听到",
  incomplete: "没读完",
};
