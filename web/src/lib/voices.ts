/**
 * 可选音色（task-76 ③）：Azure 英文 5 + 中文 4。
 *
 * 存在账号偏好 `user_prefs.tts_voice`（已有列）；`/api/tts` 在未显式传 voice 时
 * 会回落到该偏好，所以设置一次后练习示范音/对话朗读/鼓励音都会用它。
 * 未知音色由 voice 侧回落默认音色（本列表只做 UI 采集与校验提示）。
 */
export interface VoiceOption {
  id: string;
  label_zh: string;
  lang: "en" | "zh";
  /** 试听用的示例文本 */
  sample: string;
}

export const VOICE_OPTIONS: VoiceOption[] = [
  { id: "en-US-JennyNeural", label_zh: "Jenny · 英语女声（默认）", lang: "en", sample: "Hello! Let's practice English together." },
  { id: "en-US-AriaNeural", label_zh: "Aria · 英语女声（活泼）", lang: "en", sample: "Hi there! Ready for a story?" },
  { id: "en-US-AnaNeural", label_zh: "Ana · 英语童声", lang: "en", sample: "I like playing with my friends!" },
  { id: "en-US-GuyNeural", label_zh: "Guy · 英语男声", lang: "en", sample: "Good job! Let's try the next sentence." },
  { id: "en-US-MichelleNeural", label_zh: "Michelle · 英语女声（温柔）", lang: "en", sample: "Take your time. You are doing great." },
  { id: "zh-CN-XiaoxiaoNeural", label_zh: "晓晓 · 中文女声（默认）", lang: "zh", sample: "你好呀，我们一起来练习吧。" },
  { id: "zh-CN-XiaoyiNeural", label_zh: "晓伊 · 中文女声（温柔）", lang: "zh", sample: "慢慢来，不着急。" },
  { id: "zh-CN-YunxiNeural", label_zh: "云希 · 中文男声", lang: "zh", sample: "太棒了，继续加油！" },
  { id: "zh-CN-YunjianNeural", label_zh: "云健 · 中文男声（沉稳）", lang: "zh", sample: "今天我们一起读一个小故事。" },
];

export const VOICE_IDS = VOICE_OPTIONS.map((v) => v.id);

export function isKnownVoice(id: string | null | undefined): boolean {
  return Boolean(id && VOICE_IDS.includes(id));
}

export function voiceOption(id: string | null | undefined): VoiceOption | null {
  return VOICE_OPTIONS.find((v) => v.id === id) ?? null;
}
