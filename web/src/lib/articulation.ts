/**
 * 发音参数表 —— 驱动"程序生成的口型动画微课"。
 *
 * 为什么要参数化：43 个音素如果逐个手绘 SVG，既不可维护也无法自动生成。
 * 把它们抽象成一组可比较的维度（舌位高低/前后、唇开合/圆展、气流强弱、受阻位置、
 * 声带是否振动、是否鼻音、时长），就能用同一个渲染器为任意音素自动画出侧面剖面动画，
 * 并且能自动对比两个音（例如 /θ/ 与 /s/ 的差别只在"舌尖是否伸出齿间"）。
 *
 * 坐标约定（0..1，渲染器按这个解释）：
 *   tongueHigh  0 = 舌位最低（张大的 /ɑ/），1 = 舌位最高（/i/ /j/）
 *   tongueBack  0 = 舌位最前（/i/），        1 = 舌位最后（/u/ /k/ /ŋ/）
 *   lipOpen     0 = 双唇闭合（/p/ /m/），    1 = 张到最大（/ɑ/）
 *   lipRound    0 = 展唇（/i/），            1 = 圆唇（/u/ /w/）
 *   airflow     0 = 无气流（塞音闭锁段 / 鼻音），1 = 强摩擦（/θ/ /s/ /ʃ/）
 *   constriction 气流最受阻的位置（决定动画把"阻碍点"画在哪）
 *
 * ⚠️ 儿童模式不得出现 IPA 符号（硬约束）：给孩子看时只用 `childLabel` + `tipChildZh` + `examples`。
 *    `ipa` 仅成人与家长可见。
 */

export type Manner =
  | "vowel"
  | "diphthong"
  | "stop"
  | "fricative"
  | "affricate"
  | "nasal"
  | "liquid"
  | "glide";

export type Constriction =
  | "none" // 元音：无阻碍
  | "lips" // 双唇（p b m w）
  | "teeth" // 唇齿（f v）
  | "dental" // 齿间（θ ð）
  | "alveolar" // 齿龈（t d n l s z）
  | "postalveolar" // 齿龈后（ʃ ʒ tʃ dʒ r）
  | "palatal" // 硬腭（j）
  | "velar" // 软腭（k ɡ ŋ）
  | "glottal"; // 声门（h）

export interface ArticulationArt {
  manner: Manner;
  voiced: boolean;
  nasal: boolean;
  tongueHigh: number;
  tongueBack: number;
  lipOpen: number;
  lipRound: number;
  airflow: number;
  constriction: Constriction;
  /** 时长提示：教学上用来区分短元音/长元音/双元音 */
  durationHint: "short" | "long" | "diphthong";
}

export interface Articulation {
  ipa: string;
  /** 儿童可见的名字（不含 IPA 符号） */
  childLabel: string;
  /** 发音要点：必须是"可执行的动作" */
  tipZh: string;
  tipChildZh: string;
  /** 中国学习者最常见的错误 */
  commonErrorsZh: string[];
  /** 例词（尽量覆盖词首/词中/词尾） */
  examples: string[];
  /** 与哪个音最容易混、以及一对对比词 */
  contrasts: { phoneme: string; pair: [string, string]; noteZh: string }[];
  art: ArticulationArt;
}

const V = (o: Partial<ArticulationArt> = {}): ArticulationArt => ({
  manner: "vowel",
  voiced: true,
  nasal: false,
  tongueHigh: 0.5,
  tongueBack: 0.5,
  lipOpen: 0.5,
  lipRound: 0,
  airflow: 0,
  constriction: "none",
  durationHint: "short",
  ...o,
});

const C = (o: Partial<ArticulationArt> = {}): ArticulationArt => ({
  manner: "fricative",
  voiced: false,
  nasal: false,
  tongueHigh: 0.6,
  tongueBack: 0.3,
  lipOpen: 0.5,
  lipRound: 0,
  airflow: 1,
  constriction: "alveolar",
  durationHint: "short",
  ...o,
});

/** 43 个规范音素（与 voice/app/phonemes.py 的 CANONICAL_PHONEMES 一一对应） */
export const ARTICULATIONS: Record<string, Articulation> = {
  // ───────────────────────── 单元音 ─────────────────────────
  i: {
    ipa: "i",
    childLabel: "嘴角向两边拉开的长「衣」",
    tipZh: "嘴角向两边拉开像微笑，舌前部抬高靠近硬腭，声音拉长。",
    tipChildZh: "笑一笑，嘴角往两边拉，说一个长长的「衣」。",
    commonErrorsZh: ["容易读得太短，和 /ɪ/ 混", "舌位不够高，听起来像 /e/"],
    examples: ["see", "tree", "eat", "green"],
    contrasts: [{ phoneme: "ɪ", pair: ["seat", "sit"], noteZh: "/i/ 长而紧，/ɪ/ 短而松" }],
    art: V({ tongueHigh: 1, tongueBack: 0.05, lipOpen: 0.35, lipRound: 0.05, durationHint: "long" }),
  },
  ɪ: {
    ipa: "ɪ",
    childLabel: "短短的「衣」",
    tipZh: "比 /i/ 更短更松，舌位略低略后，别把嘴角拉得太开。",
    tipChildZh: "轻轻说一个短短的「衣」，别拖长。",
    commonErrorsZh: ["全都读成长音 /i/，导致 sit/seat 不分"],
    examples: ["sit", "ship", "big", "this"],
    contrasts: [{ phoneme: "i", pair: ["sit", "seat"], noteZh: "短/长对立" }],
    art: V({ tongueHigh: 0.85, tongueBack: 0.2, lipOpen: 0.45, durationHint: "short" }),
  },
  e: {
    ipa: "e",
    childLabel: "「诶」的短音",
    tipZh: "口型中等张开，嘴角略向两边，舌前中部抬起。",
    tipChildZh: "嘴巴半开，说一个短短的「诶」。",
    commonErrorsZh: ["口型张太大变成 /æ/", "读成双元音 /eɪ/"],
    examples: ["bed", "red", "pen", "desk"],
    contrasts: [{ phoneme: "æ", pair: ["bed", "bad"], noteZh: "/æ/ 口型张得更大、舌位更低" }],
    art: V({ tongueHigh: 0.6, tongueBack: 0.25, lipOpen: 0.6 }),
  },
  æ: {
    ipa: "æ",
    childLabel: "嘴巴张大的「啊—诶」",
    tipZh: "口型张大（能放进一根手指），舌位低而靠前，嘴角略拉。",
    tipChildZh: "嘴巴张得大大的，像要咬一口苹果，说「啊诶」。",
    commonErrorsZh: ["张不够开，读成 /e/（bad→bed）", "读成中文「爱」"],
    examples: ["cat", "bad", "apple", "black"],
    contrasts: [{ phoneme: "e", pair: ["bad", "bed"], noteZh: "口型大小是唯一区别" }],
    art: V({ tongueHigh: 0.25, tongueBack: 0.15, lipOpen: 0.85 }),
  },
  ɑ: {
    ipa: "ɑ",
    childLabel: "张大嘴的「啊」",
    tipZh: "嘴巴张到最大，舌位低且靠后，喉咙打开。",
    tipChildZh: "张大嘴巴说「啊」，像看医生那样。",
    commonErrorsZh: ["读得太短", "口型不够开，接近 /ʌ/"],
    examples: ["car", "father", "park", "hot"],
    contrasts: [{ phoneme: "ʌ", pair: ["cart", "cut"], noteZh: "/ɑ/ 张口更大、更靠后" }],
    art: V({ tongueHigh: 0.1, tongueBack: 0.75, lipOpen: 0.95, lipRound: 0.25, durationHint: "long" }),
  },
  ɔ: {
    ipa: "ɔ",
    childLabel: "圆嘴的「哦」",
    tipZh: "双唇收圆并略向前，舌位中低靠后。",
    tipChildZh: "嘴巴收圆像个小圆圈，说「哦」。",
    commonErrorsZh: ["不够圆，接近 /ɑ/", "读成双元音 /əʊ/"],
    examples: ["dog", "door", "four", "ball"],
    contrasts: [{ phoneme: "əʊ", pair: ["law", "low"], noteZh: "/ɔ/ 是单元音，/əʊ/ 有滑动" }],
    art: V({ tongueHigh: 0.35, tongueBack: 0.8, lipOpen: 0.7, lipRound: 0.8, durationHint: "long" }),
  },
  ʊ: {
    ipa: "ʊ",
    childLabel: "短短的圆「乌」",
    tipZh: "双唇略圆但不紧张，舌位高靠后，音短。",
    tipChildZh: "嘴巴圆圆的，短短地说「乌」。",
    commonErrorsZh: ["读成长音 /u/", "唇太紧"],
    examples: ["book", "good", "put", "look"],
    contrasts: [{ phoneme: "u", pair: ["full", "fool"], noteZh: "/ʊ/ 短而松，/u/ 长而紧" }],
    art: V({ tongueHigh: 0.75, tongueBack: 0.8, lipOpen: 0.45, lipRound: 0.6 }),
  },
  u: {
    ipa: "u",
    childLabel: "圆嘴的长「乌」",
    tipZh: "双唇收得很圆并向前突出，舌后部抬高，声音拉长。",
    tipChildZh: "嘴巴圆圆地往前嘟，说一个长长的「乌」。",
    commonErrorsZh: ["唇不够圆", "读得太短"],
    examples: ["food", "blue", "school", "zoo"],
    contrasts: [{ phoneme: "ʊ", pair: ["fool", "full"], noteZh: "长/短 + 唇紧张度" }],
    art: V({ tongueHigh: 0.9, tongueBack: 0.9, lipOpen: 0.3, lipRound: 1, durationHint: "long" }),
  },
  ʌ: {
    ipa: "ʌ",
    childLabel: "短促的「啊」",
    tipZh: "口型半开，舌位中央偏后、略低，声音短而放松。",
    tipChildZh: "嘴巴半开，短短地说一个「啊」。",
    commonErrorsZh: ["读成 /ɑ/（口型太大）", "读成中文「阿」"],
    examples: ["cup", "bus", "love", "but"],
    contrasts: [{ phoneme: "ɑ", pair: ["cut", "cart"], noteZh: "/ʌ/ 更短更松" }],
    art: V({ tongueHigh: 0.4, tongueBack: 0.6, lipOpen: 0.65 }),
  },
  ɜ: {
    ipa: "ɜ",
    childLabel: "卷舌的「呃」",
    tipZh: "口型放松半开，舌中部抬起，舌尖略卷（美音带 r 色彩）。",
    tipChildZh: "嘴巴放松，舌头中间抬起来，说「呃」。",
    commonErrorsZh: ["卷舌不够，听起来平淡", "和 /ə/ 混（重读 vs 轻读）"],
    examples: ["bird", "girl", "work", "first"],
    contrasts: [{ phoneme: "ə", pair: ["her", "sofa"], noteZh: "/ɜ/ 重读带卷舌，/ə/ 轻读" }],
    art: V({ tongueHigh: 0.5, tongueBack: 0.55, lipOpen: 0.55, lipRound: 0.1, durationHint: "long" }),
  },
  ə: {
    ipa: "ə",
    childLabel: "最轻的「呃」",
    tipZh: "全身放松，口型自然半开，舌位中央，声音又轻又短。",
    tipChildZh: "嘴巴放松不用力，轻轻说「呃」。",
    commonErrorsZh: ["读得太重，抢了重音", "读成 /ʌ/"],
    examples: ["about", "sofa", "banana", "today"],
    contrasts: [{ phoneme: "ʌ", pair: ["above", "cup"], noteZh: "/ə/ 永远轻读" }],
    art: V({ tongueHigh: 0.5, tongueBack: 0.55, lipOpen: 0.5 }),
  },

  // ───────────────────────── 双元音 ─────────────────────────
  eɪ: {
    ipa: "eɪ",
    childLabel: "「诶—衣」滑一下",
    tipZh: "从 /e/ 开始，向 /i/ 滑动，前半段重、后半段轻。",
    tipChildZh: "先说「诶」，再滑向「衣」，中间不要断开。",
    commonErrorsZh: ["只读前半段，滑不动", "读成单元音 /e/"],
    examples: ["day", "name", "play", "today"],
    contrasts: [{ phoneme: "e", pair: ["late", "let"], noteZh: "/eɪ/ 有滑动过程" }],
    art: V({ tongueHigh: 0.6, tongueBack: 0.25, lipOpen: 0.6, durationHint: "diphthong", manner: "diphthong" }),
  },
  aɪ: {
    ipa: "aɪ",
    childLabel: "「啊—衣」滑一下",
    tipZh: "从张口 /a/ 滑向 /i/，口型由大变窄。",
    tipChildZh: "先张大嘴说「啊」，再滑向「衣」。",
    commonErrorsZh: ["滑不到位", "读成中文「爱」太重"],
    examples: ["my", "time", "like", "five"],
    contrasts: [{ phoneme: "æ", pair: ["my", "map"], noteZh: "/aɪ/ 有明显滑动" }],
    art: V({ tongueHigh: 0.3, tongueBack: 0.35, lipOpen: 0.85, durationHint: "diphthong", manner: "diphthong" }),
  },
  ɔɪ: {
    ipa: "ɔɪ",
    childLabel: "「哦—衣」滑一下",
    tipZh: "圆唇 /ɔ/ 滑向 /ɪ/，唇由圆变展。",
    tipChildZh: "嘴巴圆圆地说「哦」，再滑向「衣」。",
    commonErrorsZh: ["后半段不到位", "与 /aɪ/ 混"],
    examples: ["boy", "toy", "oil", "enjoy"],
    contrasts: [{ phoneme: "aɪ", pair: ["boil", "bile"], noteZh: "起点唇形圆/不圆" }],
    art: V({ tongueHigh: 0.4, tongueBack: 0.7, lipOpen: 0.7, lipRound: 0.7, durationHint: "diphthong", manner: "diphthong" }),
  },
  əʊ: {
    ipa: "əʊ",
    childLabel: "「呃—乌」滑一下",
    tipZh: "从放松的 /ə/ 滑向圆唇 /ʊ/，唇逐渐收圆。",
    tipChildZh: "先说「呃」，再滑向圆圆的「乌」。",
    commonErrorsZh: ["读成中文「欧」", "唇不到位"],
    examples: ["go", "home", "know", "open"],
    contrasts: [{ phoneme: "ɔ", pair: ["low", "law"], noteZh: "/əʊ/ 有滑动" }],
    art: V({ tongueHigh: 0.5, tongueBack: 0.6, lipOpen: 0.55, lipRound: 0.4, durationHint: "diphthong", manner: "diphthong" }),
  },
  aʊ: {
    ipa: "aʊ",
    childLabel: "「啊—乌」滑一下",
    tipZh: "张大嘴 /a/ 滑向圆唇 /ʊ/，口型由大变圆。",
    tipChildZh: "张大嘴说「啊」，再滑向圆圆的「乌」。",
    commonErrorsZh: ["读成中文「奥」", "唇不圆"],
    examples: ["now", "house", "out", "brown"],
    contrasts: [{ phoneme: "əʊ", pair: ["now", "know"], noteZh: "起点张口大小不同" }],
    art: V({ tongueHigh: 0.25, tongueBack: 0.6, lipOpen: 0.9, lipRound: 0.2, durationHint: "diphthong", manner: "diphthong" }),
  },
  ɪə: {
    ipa: "ɪə",
    childLabel: "「衣—呃」滑一下",
    tipZh: "短 /ɪ/ 滑向中央 /ə/，后段更轻。",
    tipChildZh: "先说短短的「衣」，再轻轻滑向「呃」。",
    commonErrorsZh: ["后半段丢掉", "与 /i/ 混"],
    examples: ["near", "hear", "idea", "here"],
    contrasts: [{ phoneme: "i", pair: ["near", "knee"], noteZh: "/ɪə/ 有第二个元音" }],
    art: V({ tongueHigh: 0.8, tongueBack: 0.25, lipOpen: 0.45, durationHint: "diphthong", manner: "diphthong" }),
  },
  eə: {
    ipa: "eə",
    childLabel: "「诶—呃」滑一下",
    tipZh: "从 /e/ 滑向 /ə/，后段放松变轻。",
    tipChildZh: "说「诶」，再轻轻滑向「呃」。",
    commonErrorsZh: ["后半段丢掉", "与 /e/ 混"],
    examples: ["bear", "hair", "chair", "where"],
    contrasts: [{ phoneme: "e", pair: ["bear", "bed"], noteZh: "/eə/ 有两个元音" }],
    art: V({ tongueHigh: 0.6, tongueBack: 0.3, lipOpen: 0.6, durationHint: "diphthong", manner: "diphthong" }),
  },
  ʊə: {
    ipa: "ʊə",
    childLabel: "「乌—呃」滑一下",
    tipZh: "圆唇 /ʊ/ 滑向中央 /ə/，唇逐渐放松。",
    tipChildZh: "圆圆地说「乌」，再滑向「呃」。",
    commonErrorsZh: ["前段唇不圆", "与 /u/ 混"],
    examples: ["tour", "sure", "tourist", "rural"],
    contrasts: [{ phoneme: "u", pair: ["tour", "two"], noteZh: "/ʊə/ 有第二个元音" }],
    art: V({ tongueHigh: 0.75, tongueBack: 0.75, lipOpen: 0.4, lipRound: 0.6, durationHint: "diphthong", manner: "diphthong" }),
  },

  // ───────────────────────── 塞音 ─────────────────────────
  p: {
    ipa: "p",
    childLabel: "闭紧双唇再放开的「扑」",
    tipZh: "双唇闭紧憋住气，然后突然放开送气，声带不振动。",
    tipChildZh: "把嘴巴闭紧紧，然后一下吹开，像吹蜡烛「扑」。",
    commonErrorsZh: ["不送气，像中文「b」", "词尾吞掉不发音"],
    examples: ["pen", "happy", "stop", "apple"],
    contrasts: [{ phoneme: "b", pair: ["pat", "bat"], noteZh: "清/浊对立，可用手背感受气流" }],
    art: C({ manner: "stop", voiced: false, tongueHigh: 0.4, tongueBack: 0.4, lipOpen: 0, airflow: 0, constriction: "lips" }),
  },
  b: {
    ipa: "b",
    childLabel: "闭紧双唇再放开的「波」",
    tipZh: "双唇闭紧再放开，声带要振动（手放喉咙能感觉到）。",
    tipChildZh: "闭紧嘴巴再放开，摸摸喉咙会感觉在抖「波」。",
    commonErrorsZh: ["词尾读成清音 /p/", "送气过强"],
    examples: ["bed", "rabbit", "rub", "boy"],
    contrasts: [{ phoneme: "p", pair: ["bat", "pat"], noteZh: "浊音声带振动" }],
    art: C({ manner: "stop", voiced: true, tongueHigh: 0.4, tongueBack: 0.4, lipOpen: 0, airflow: 0, constriction: "lips" }),
  },
  t: {
    ipa: "t",
    childLabel: "舌尖顶上牙床再放开的「特」",
    tipZh: "舌尖抵住上齿龈，突然离开送气，声带不振动。",
    tipChildZh: "舌尖顶住上牙床，然后弹开「特」。",
    commonErrorsZh: ["不送气像中文「d」", "词尾吞掉"],
    examples: ["tea", "water", "cat", "time"],
    contrasts: [{ phoneme: "d", pair: ["ten", "den"], noteZh: "清/浊" }],
    art: C({ manner: "stop", voiced: false, tongueHigh: 0.8, tongueBack: 0.15, lipOpen: 0.5, airflow: 0, constriction: "alveolar" }),
  },
  d: {
    ipa: "d",
    childLabel: "舌尖顶上牙床的「得」",
    tipZh: "舌尖抵上齿龈后放开，声带振动。",
    tipChildZh: "舌尖顶住上牙床再放开，喉咙要抖「得」。",
    commonErrorsZh: ["词尾清化成 /t/", "卷舌"],
    examples: ["dog", "ladder", "bed", "day"],
    contrasts: [{ phoneme: "t", pair: ["den", "ten"], noteZh: "浊音声带振动" }],
    art: C({ manner: "stop", voiced: true, tongueHigh: 0.8, tongueBack: 0.15, lipOpen: 0.5, airflow: 0, constriction: "alveolar" }),
  },
  k: {
    ipa: "k",
    childLabel: "舌根顶软腭再放开的「克」",
    tipZh: "舌后部抬到软腭堵住气流，然后放开送气。",
    tipChildZh: "舌头后面顶住上颚靠后的地方，再弹开「克」。",
    commonErrorsZh: ["不送气像中文「g」", "位置太前"],
    examples: ["key", "school", "book", "cat"],
    contrasts: [{ phoneme: "ɡ", pair: ["coat", "goat"], noteZh: "清/浊" }],
    art: C({ manner: "stop", voiced: false, tongueHigh: 0.85, tongueBack: 0.9, lipOpen: 0.5, airflow: 0, constriction: "velar" }),
  },
  ɡ: {
    ipa: "ɡ",
    childLabel: "舌根顶软腭的「格」",
    tipZh: "舌后部抵软腭后放开，声带振动。",
    tipChildZh: "舌头后面顶住上颚后面再放开，喉咙要抖「格」。",
    commonErrorsZh: ["词尾清化", "与 /d/ 混"],
    examples: ["go", "bag", "bigger", "green"],
    contrasts: [{ phoneme: "k", pair: ["goat", "coat"], noteZh: "浊音声带振动" }],
    art: C({ manner: "stop", voiced: true, tongueHigh: 0.85, tongueBack: 0.9, lipOpen: 0.5, airflow: 0, constriction: "velar" }),
  },

  // ───────────────────────── 擦音 ─────────────────────────
  f: {
    ipa: "f",
    childLabel: "上牙咬下唇吹气的「夫」",
    tipZh: "上齿轻触下唇，气流从缝隙摩擦出来，声带不振动。",
    tipChildZh: "上牙轻轻咬住下嘴唇，往外吹气「夫」。",
    commonErrorsZh: ["读成 /h/（用喉咙吹）", "下唇没碰牙齿"],
    examples: ["fish", "coffee", "leaf", "four"],
    contrasts: [{ phoneme: "v", pair: ["fan", "van"], noteZh: "清/浊" }],
    art: C({ manner: "fricative", voiced: false, tongueHigh: 0.4, tongueBack: 0.4, lipOpen: 0.35, airflow: 1, constriction: "teeth" }),
  },
  v: {
    ipa: "v",
    childLabel: "上牙咬下唇的「微」",
    tipZh: "上齿轻触下唇，同时声带振动，气流摩擦而出。",
    tipChildZh: "上牙咬住下嘴唇，喉咙抖着吹气「微」。",
    commonErrorsZh: ["读成 /w/（不碰牙齿）", "读成 /f/ 忘了振动"],
    examples: ["very", "seven", "love", "voice"],
    contrasts: [{ phoneme: "w", pair: ["vest", "west"], noteZh: "牙齿碰不碰下唇是唯一区别" }],
    art: C({ manner: "fricative", voiced: true, tongueHigh: 0.4, tongueBack: 0.4, lipOpen: 0.35, airflow: 0.7, constriction: "teeth" }),
  },
  θ: {
    ipa: "θ",
    childLabel: "舌尖伸到齿间吹气的 th",
    tipZh: "舌尖轻轻伸到上下齿之间，气流从舌尖和牙齿的缝隙吹出，声带不振动。",
    tipChildZh: "把舌尖轻轻伸到上下牙齿中间，吹气，像说悄悄话「th」。",
    commonErrorsZh: ["读成 /s/（舌尖没伸出来）", "读成 /f/", "读成 /t/"],
    examples: ["think", "three", "thank", "math"],
    contrasts: [{ phoneme: "s", pair: ["think", "sink"], noteZh: "舌尖伸出 vs 藏在齿后" }],
    art: C({ manner: "fricative", voiced: false, tongueHigh: 0.75, tongueBack: 0.05, lipOpen: 0.4, airflow: 1, constriction: "dental" }),
  },
  ð: {
    ipa: "ð",
    childLabel: "舌尖伸到齿间的「这」",
    tipZh: "舌尖伸到齿间，声带振动，气流从缝隙摩擦出来。",
    tipChildZh: "舌尖伸到牙齿中间，喉咙抖着说「这」。",
    commonErrorsZh: ["读成 /z/ 或 /d/（舌尖没伸出来）", "读成 /θ/ 忘了振动"],
    examples: ["this", "mother", "weather", "brother"],
    contrasts: [{ phoneme: "z", pair: ["they", "zoo"], noteZh: "舌尖伸出 vs 齿龈摩擦" }],
    art: C({ manner: "fricative", voiced: true, tongueHigh: 0.75, tongueBack: 0.05, lipOpen: 0.4, airflow: 0.6, constriction: "dental" }),
  },
  s: {
    ipa: "s",
    childLabel: "平舌吹气的「丝」",
    tipZh: "舌尖靠近上齿龈但不贴住，气流从窄缝摩擦出来，嘴角略展。",
    tipChildZh: "牙关轻轻咬住，向外吹细细的气「丝」。",
    commonErrorsZh: ["读成 /θ/（舌尖伸出来）", "读成 /ʃ/（唇太圆）"],
    examples: ["sun", "bus", "see", "school"],
    contrasts: [{ phoneme: "θ", pair: ["sink", "think"], noteZh: "舌尖不能伸出齿间" }],
    art: C({ manner: "fricative", voiced: false, tongueHigh: 0.8, tongueBack: 0.1, lipOpen: 0.5, airflow: 1, constriction: "alveolar" }),
  },
  z: {
    ipa: "z",
    childLabel: "蜜蜂嗡嗡的「兹」",
    tipZh: "舌尖靠近上齿龈，声带振动，像蜜蜂嗡嗡。",
    tipChildZh: "牙齿轻轻咬住，喉咙抖着吹气，像小蜜蜂「兹—」。",
    commonErrorsZh: ["读成 /s/（忘了声带振动）", "读成 /ð/", "读成中文「z」"],
    examples: ["zoo", "is", "easy", "boys"],
    contrasts: [{ phoneme: "s", pair: ["zoo", "sue"], noteZh: "浊音声带振动（手摸喉咙）" }],
    art: C({ manner: "fricative", voiced: true, tongueHigh: 0.8, tongueBack: 0.1, lipOpen: 0.5, airflow: 0.7, constriction: "alveolar" }),
  },
  ʃ: {
    ipa: "ʃ",
    childLabel: "「嘘」让别说话的 sh",
    tipZh: "舌尖抬向齿龈后部，双唇略圆略前，气流摩擦而出，声带不振动。",
    tipChildZh: "把手指放嘴边说「嘘」，嘴唇圆圆地往前送气。",
    commonErrorsZh: ["读成 /s/（唇不圆）", "读成中文「西」"],
    examples: ["she", "ship", "fish", "station"],
    contrasts: [{ phoneme: "s", pair: ["she", "sea"], noteZh: "圆唇 vs 展唇" }],
    art: C({ manner: "fricative", voiced: false, tongueHigh: 0.75, tongueBack: 0.3, lipOpen: 0.45, lipRound: 0.5, airflow: 1, constriction: "postalveolar" }),
  },
  ʒ: {
    ipa: "ʒ",
    childLabel: "带声的「嘘」",
    tipZh: "位置同 /ʃ/，但声带振动。",
    tipChildZh: "像说「嘘」一样，但是喉咙要抖。",
    commonErrorsZh: ["读成 /ʃ/（不振动）", "读成 /dʒ/"],
    examples: ["measure", "vision", "usual", "garage"],
    contrasts: [{ phoneme: "ʃ", pair: ["vision", "mission"], noteZh: "浊音声带振动" }],
    art: C({ manner: "fricative", voiced: true, tongueHigh: 0.75, tongueBack: 0.3, lipOpen: 0.45, lipRound: 0.5, airflow: 0.7, constriction: "postalveolar" }),
  },
  h: {
    ipa: "h",
    childLabel: "呵气的「哈」",
    tipZh: "口型放松张开，声门打开，像对着玻璃呵气。",
    tipChildZh: "嘴巴自然张开，像对玻璃呵气「哈」。",
    commonErrorsZh: ["摩擦太重像中文「h」", "词首吞掉"],
    examples: ["hat", "hello", "behind", "who"],
    contrasts: [{ phoneme: "w", pair: ["hat", "what"], noteZh: "/h/ 无唇动作" }],
    art: C({ manner: "fricative", voiced: false, tongueHigh: 0.5, tongueBack: 0.5, lipOpen: 0.6, airflow: 0.7, constriction: "glottal" }),
  },

  // ───────────────────────── 塞擦音 ─────────────────────────
  tʃ: {
    ipa: "tʃ",
    childLabel: "「吃」的 ch",
    tipZh: "先像 /t/ 堵住，再迅速放成 /ʃ/ 的摩擦，双唇略圆。",
    tipChildZh: "先顶住再放开，说「吃」，嘴唇圆圆地往前。",
    commonErrorsZh: ["拆成 /t/+/ʃ/ 两段", "读成中文「ch」卷舌"],
    examples: ["chair", "watch", "teacher", "children"],
    contrasts: [{ phoneme: "ʃ", pair: ["chair", "share"], noteZh: "/tʃ/ 开头有爆破" }],
    art: C({ manner: "affricate", voiced: false, tongueHigh: 0.8, tongueBack: 0.3, lipOpen: 0.45, lipRound: 0.4, airflow: 1, constriction: "postalveolar" }),
  },
  dʒ: {
    ipa: "dʒ",
    childLabel: "「之」的 j",
    tipZh: "先堵住再摩擦，全程声带振动。",
    tipChildZh: "说「之」的时候喉咙要抖。",
    commonErrorsZh: ["读成 /ʒ/ 少了爆破", "读成中文卷舌「zh」"],
    examples: ["job", "bridge", "age", "juice"],
    contrasts: [{ phoneme: "tʃ", pair: ["joke", "choke"], noteZh: "清/浊" }],
    art: C({ manner: "affricate", voiced: true, tongueHigh: 0.8, tongueBack: 0.3, lipOpen: 0.45, lipRound: 0.4, airflow: 0.8, constriction: "postalveolar" }),
  },

  // ───────────────────────── 鼻音 ─────────────────────────
  m: {
    ipa: "m",
    childLabel: "闭嘴哼的「嗯」",
    tipZh: "双唇闭合，声音从鼻子出来，声带振动。",
    tipChildZh: "把嘴巴闭紧，用鼻子哼「嗯」。",
    commonErrorsZh: ["鼻腔共鸣不足", "词尾吞掉"],
    examples: ["man", "some", "mother", "time"],
    contrasts: [{ phoneme: "n", pair: ["some", "sun"], noteZh: "双唇闭合 vs 舌尖抬起" }],
    art: C({ manner: "nasal", voiced: true, nasal: true, tongueHigh: 0.4, tongueBack: 0.4, lipOpen: 0, airflow: 0, constriction: "lips" }),
  },
  n: {
    ipa: "n",
    childLabel: "舌尖顶上牙床的「嗯」",
    tipZh: "舌尖抵上齿龈，声音从鼻子出来。",
    tipChildZh: "舌尖顶住上牙床，用鼻子哼「嗯」。",
    commonErrorsZh: ["与 /ŋ/ 混（词尾 -ing）", "读成 /l/"],
    examples: ["no", "sun", "name", "run"],
    contrasts: [{ phoneme: "ŋ", pair: ["sun", "sung"], noteZh: "舌尖位置 vs 舌根位置" }],
    art: C({ manner: "nasal", voiced: true, nasal: true, tongueHigh: 0.8, tongueBack: 0.15, lipOpen: 0.4, airflow: 0, constriction: "alveolar" }),
  },
  ŋ: {
    ipa: "ŋ",
    childLabel: "舌根顶软腭的「嗯」",
    tipZh: "舌后部抵软腭，声音从鼻子出来，舌尖不要抬起。",
    tipChildZh: "舌头后面顶住上颚后面，哼一个「嗯」。",
    commonErrorsZh: ["读成 /n/（sing→sin）", "多加一个 /ɡ/ 音"],
    examples: ["sing", "long", "thing", "morning"],
    contrasts: [{ phoneme: "n", pair: ["sung", "sun"], noteZh: "词尾 -ing 一定是 /ŋ/" }],
    art: C({ manner: "nasal", voiced: true, nasal: true, tongueHigh: 0.85, tongueBack: 0.9, lipOpen: 0.5, airflow: 0, constriction: "velar" }),
  },

  // ───────────────────────── 流音 / 滑音 ─────────────────────────
  l: {
    ipa: "l",
    childLabel: "舌尖顶上牙床的「勒」",
    tipZh: "舌尖抵上齿龈，气流从舌头两侧出来；词尾的 /l/ 舌后部要抬（暗 l）。",
    tipChildZh: "舌尖顶住上牙床，声音从舌头两边出来「勒」。",
    commonErrorsZh: ["与 /r/ 混", "词尾 /l/ 读成 /o/ 或省略"],
    examples: ["like", "light", "ball", "little"],
    contrasts: [{ phoneme: "r", pair: ["light", "right"], noteZh: "舌尖顶上牙床 vs 舌尖不碰" }],
    art: C({ manner: "liquid", voiced: true, tongueHigh: 0.8, tongueBack: 0.15, lipOpen: 0.5, airflow: 0.3, constriction: "alveolar" }),
  },
  r: {
    ipa: "r",
    childLabel: "舌尖不碰任何地方的「若」",
    tipZh: "舌尖抬向齿龈后但不接触，舌尖略卷，双唇略圆。",
    tipChildZh: "舌尖往上卷一点，但不要碰到牙床，嘴唇圆一点说「若」。",
    commonErrorsZh: ["读成中文「r」卷舌太重", "舌尖顶到了牙床变成 /l/", "读成 /w/"],
    examples: ["red", "right", "very", "green"],
    contrasts: [{ phoneme: "l", pair: ["right", "light"], noteZh: "舌尖不接触 vs 接触" }],
    art: C({ manner: "liquid", voiced: true, tongueHigh: 0.6, tongueBack: 0.45, lipOpen: 0.45, lipRound: 0.35, airflow: 0.2, constriction: "postalveolar" }),
  },
  j: {
    ipa: "j",
    childLabel: "「耶」的 y",
    tipZh: "舌前部抬到硬腭但不摩擦，很快滑向后面的元音。",
    tipChildZh: "舌头前部往上抬，很快滑到下一个音，说「耶」。",
    commonErrorsZh: ["摩擦太重变成 /dʒ/", "与 /i/ 混"],
    examples: ["yes", "you", "year", "yellow"],
    contrasts: [{ phoneme: "dʒ", pair: ["yes", "jess"], noteZh: "/j/ 不摩擦" }],
    art: C({ manner: "glide", voiced: true, tongueHigh: 0.95, tongueBack: 0.05, lipOpen: 0.45, airflow: 0.1, constriction: "palatal" }),
  },
  w: {
    ipa: "w",
    childLabel: "圆唇的「哇」",
    tipZh: "双唇收圆并向前，很快滑向后面的元音；牙齿不碰下唇。",
    tipChildZh: "嘴巴圆圆地往前嘟，很快变成下一个音「哇」。",
    commonErrorsZh: ["读成 /v/（牙齿碰了下唇）", "唇不够圆"],
    examples: ["we", "water", "what", "window"],
    contrasts: [{ phoneme: "v", pair: ["west", "vest"], noteZh: "牙齿不碰下唇" }],
    art: C({ manner: "glide", voiced: true, tongueHigh: 0.8, tongueBack: 0.85, lipOpen: 0.2, lipRound: 1, airflow: 0.1, constriction: "lips" }),
  },
};

export function getArticulation(ipa: string): Articulation | null {
  return ARTICULATIONS[ipa] ?? null;
}

/** 儿童模式可用的发音要点（无 IPA） */
export function childTip(ipa: string): string | null {
  return ARTICULATIONS[ipa]?.tipChildZh ?? null;
}
