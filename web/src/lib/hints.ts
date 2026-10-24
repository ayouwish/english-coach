/**
 * hint_key → 本地化教学提示（契约 §3.1 的可用键全集）。
 * child 文案完全避开 IPA 符号（用「音」和口型描述），成人文案可带 IPA。
 */
import { childSafeText } from "./child-safe";

export interface HintText {
  title_zh: string; // 成人版（含 IPA）
  title_child: string; // 儿童版（无 IPA）
  why_zh: string;
  how_zh: string;
  /** 成人文案里出现 IPA / /x/ 记法时，必须给儿童单独写一份（否则由 childSafeText 兜底剥掉） */
  why_child_zh?: string;
  how_child_zh?: string;
  practice_words: string[];
  demo_text: string;
}

export const HINTS: Record<string, HintText> = {
  th_voiceless: {
    title_zh: "th 的 /θ/ 音（如 think）",
    title_child: "think 里开头的那个「咬舌音」",
    why_zh: "舌尖没有伸出来，气流从牙龈缝隙出去了，听起来像 /s/。",
    why_child_zh: "舌尖没有伸出来，气从牙缝里跑掉了，听起来有点像 s。",
    how_zh: "舌尖轻轻伸到上下齿之间，让气流从缝里摩擦出来，声带不要振动。",
    practice_words: ["think", "thank", "three", "thick"],
    demo_text: "think, thank, three",
  },
  th_voiced: {
    title_zh: "th 的 /ð/ 音（如 this）",
    title_child: "this 里那个「带声音的咬舌音」",
    why_zh: "舌尖位置不对，/ð/ 被读成了 /d/ 或 /z/。",
    why_child_zh: "舌尖的位置不太对，这个音听起来像 d 或者 z。",
    how_zh: "舌尖放在上下齿之间，这次要让声带振动，喉咙有嗡嗡的震感。",
    how_child_zh: "舌尖放在上下牙齿中间，这次要让嗓子嗡嗡地振动起来。",
    practice_words: ["this", "that", "mother", "weather"],
    demo_text: "this, that, mother",
  },
  r_l_v: {
    title_zh: "/r/ 与 /l/ 混淆",
    title_child: "r 和 l 两个音要分开",
    why_zh: "舌尖卷起与顶住上齿龈的动作没有区分开。",
    how_zh: "/r/ 舌尖悬空向后卷，不碰上颚；/l/ 舌尖要顶住上齿龈。",
    why_child_zh: "r 和 l 的舌头动作没有分开，听起来会混。",
    how_child_zh: "r 的舌尖要悬空向后卷、不碰上颚；l 的舌尖要顶住上齿龈。",
    practice_words: ["right", "light", "really", "little"],
    demo_text: "right, light, really",
  },
  v_w: {
    title_zh: "/v/ 与 /w/ 混淆",
    title_child: "v 要咬嘴唇，w 要圆嘴巴",
    why_zh: "/v/ 缺少上齿咬下唇的摩擦，听起来像 /w/。",
    why_child_zh: "上齿没有咬住下唇，这个音听起来像 w。",
    how_zh: "上齿轻咬下唇送气＝/v/；双唇收圆不碰牙齿＝/w/。",
    how_child_zh: "上齿轻轻咬住下唇送气就是 v；双唇收圆、不碰牙齿就是 w。",
    practice_words: ["very", "west", "voice", "water"],
    demo_text: "very, west, voice",
  },
  short_i_long_i: {
    title_zh: "短 /ɪ/ 与长 /i/（canonical-v1）",
    title_child: "短音和长音要拉长一点",
    why_zh: "长短元音没有区分，ship 听成了 sheep。",
    how_zh: "/i/ 嘴角往两边拉开并保持久一点；/ɪ/ 短促、嘴角放松。",
    why_child_zh: "长音和短音没有分开，ship 听起来像 sheep。",
    how_child_zh: "长音要把嘴角往两边拉开、保持久一点；短音要短促、嘴角放松。",
    practice_words: ["ship", "sheep", "sit", "seat"],
    demo_text: "ship, sheep, sit, seat",
  },
  ae_e: {
    title_zh: "/æ/ 与 /e/",
    title_child: "嘴巴要张大一点",
    why_zh: "/æ/ 开口不够大，听起来像 /e/。",
    why_child_zh: "嘴巴张得不够大，这个音听起来像 e。",
    how_zh: "下巴放低，嘴角略向两边，像说「啊」又像「哎」。",
    practice_words: ["cat", "bed", "apple", "pen"],
    demo_text: "cat, bed, apple",
  },
  s_sh: {
    title_zh: "/s/ 与 /ʃ/",
    title_child: "sh 要把嘴唇收圆",
    why_zh: "舌位太靠前，/ʃ/ 被读成 /s/。",
    why_child_zh: "舌头太靠前了，sh 这个音听起来像 s。",
    how_zh: "舌面抬高靠近硬腭，双唇稍微收圆前突。",
    practice_words: ["she", "sea", "shoe", "sure"],
    demo_text: "she, sea, shoe",
  },
  n_ng: {
    title_zh: "词尾 /n/ 与 /ŋ/",
    title_child: "结尾的 ng 要从鼻子里出来",
    why_zh: "词尾鼻音区分不清，sin 与 sing 一样。",
    how_zh: "/ŋ/ 舌根抬起顶住软腭，气流从鼻腔出来，舌尖不要碰齿龈。",
    why_child_zh: "结尾的鼻音区分不清，sin 和 sing 听起来一样。",
    how_child_zh: "发结尾的 ng 时，舌根抬起来顶住软腭，气从鼻子出来，舌尖不要碰上齿龈。",
    practice_words: ["sing", "sin", "thing", "thin"],
    demo_text: "sing, thing, long",
  },
  l_dark: {
    title_zh: "词尾暗 /l/",
    title_child: "结尾的 l 舌头要抬起来",
    why_zh: "词尾 /l/ 被吞掉或读成元音。",
    why_child_zh: "结尾的 l 被吞掉了。",
    how_zh: "舌尖顶住上齿龈并保持住，再收尾。",
    practice_words: ["milk", "school", "little", "apple"],
    demo_text: "milk, school, little",
  },
  schwa: {
    title_zh: "非重读弱元音 /ə/",
    title_child: "不重要的音节要读得又轻又短",
    why_zh: "每个音节都读得太重，节奏听起来很硬。",
    how_zh: "非重读音节放松成轻轻的「呃」，重音只放在一个音节上。",
    practice_words: ["banana", "about", "teacher", "today"],
    demo_text: "banana, about, teacher",
  },
  final_consonant: {
    title_zh: "词尾辅音丢失",
    title_child: "最后一个音也要说完整",
    why_zh: "词尾辅音没有发出来，look 听成了 loo。",
    how_zh: "句子结束时也要把最后的辅音轻轻收住，不要吞掉。",
    practice_words: ["book", "good", "cat", "stop"],
    demo_text: "book, good, cat",
  },
  consonant_cluster: {
    title_zh: "辅音连缀",
    title_child: "两个辅音要连在一起说",
    why_zh: "连缀中间被插入了元音，strike 读成 sutrike。",
    how_zh: "把两个辅音紧挨着快速说出，中间不要加「呃」。",
    practice_words: ["street", "spring", "desk", "asked"],
    demo_text: "street, spring, desk",
  },
  stress_wrong: {
    title_zh: "单词重音位置",
    title_child: "有一个音节要读得更响",
    why_zh: "重音位置不对，单词听起来不自然。",
    how_zh: "重读音节读得更长、更响、更高，其余音节弱化。",
    practice_words: ["record", "present", "banana", "photograph"],
    demo_text: "banana, present, photograph",
  },
  monotone: {
    title_zh: "语调太平",
    title_child: "声音要有高有低才像在说话",
    why_zh: "整句音高几乎没有起伏。",
    how_zh: "陈述句结尾轻轻下降，疑问句结尾明显上扬。",
    practice_words: ["Really?", "Is it?", "Nice to meet you."],
    demo_text: "Is it? Yes, it is.",
  },
  pause_wrong: {
    title_zh: "停顿位置不当",
    title_child: "在词组之间换气，不要在词中间停",
    why_zh: "在意群中间断开，影响理解。",
    how_zh: "按意群（短语）停顿，一次说完一个词组。",
    practice_words: ["in the morning", "at school", "with my friend"],
    demo_text: "in the morning, at school",
  },
  omission: {
    title_zh: "漏词",
    title_child: "有个词忘记说了",
    why_zh: "参考句里的单词没有读出来。",
    how_zh: "放慢速度，一个词一个词看清楚再连起来读。",
    practice_words: [],
    demo_text: "",
  },
  insertion: {
    title_zh: "多词",
    title_child: "多说了词",
    why_zh: "读出了参考句以外的内容。",
    how_zh: "先默读一遍参考句，再开口录音。",
    practice_words: [],
    demo_text: "",
  },
};

export interface ChildHint {
  title: string;
  why: string;
  how: string;
  practice_words: string[];
  demo_text: string;
}

/** 儿童版提示：优先用 why_child_zh/how_child_zh，缺失时剥掉 IPA 与 /x/ 记法。 */
export function getChildHint(key: string | null | undefined): ChildHint {
  const hint = getHint(key);
  return {
    title: hint.title_child,
    why: hint.why_child_zh ?? childSafeText(hint.why_zh),
    how: hint.how_child_zh ?? childSafeText(hint.how_zh),
    practice_words: hint.practice_words,
    demo_text: hint.demo_text,
  };
}

const GENERIC: HintText = {
  title_zh: "这个词可以再清楚一点",
  title_child: "这个词再说清楚一点点",
  why_zh: "发音清晰度还可以提高。",
  how_zh: "放慢速度，把每个音都说完整，再录一遍试试。",
  practice_words: [],
  demo_text: "",
};

export function getHint(key: string | null | undefined): HintText {
  if (!key) return GENERIC;
  return HINTS[key] ?? GENERIC;
}

/** 儿童完全看不到 IPA：优先用 title_child。 */
export function hintTitle(key: string | null | undefined, isChild: boolean): string {
  const hint = getHint(key);
  return isChild ? hint.title_child : hint.title_zh;
}
