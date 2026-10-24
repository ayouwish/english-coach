/**
 * 场景开场白的中文翻译。
 *
 * 为什么需要：开场白来自 `scenarios.json`，在会话创建时就作为第一条 assistant 消息入库，
 * 但历史上传的是 `textZh: null` —— 于是孩子看到的第一句只有英文（而后面的对话都有翻译）。
 * 这里按 scenario id 补上翻译，避免为了一个字段加数据库迁移。
 *
 * 约定：新增场景时必须在这里补一条；缺失时页面只是不显示翻译，不会报错。
 */
export const OPENING_ZH: Record<string, string> = {
  self_intro: "嗨！我是 Sam。你叫什么名字？",
  ordering_food: "欢迎！你今天想吃点什么？",
  school_day: "嗨！你今天上什么课？",
  animals_zoo: "快看！你看到那头大象了吗？",
  birthday_party: "我的生日在星期六！你喜欢蛋糕吗？",
  ordering_coffee: "你好！今天想喝点什么？",
  shopping_clothes: "你好！需要我帮你找点什么吗？",
  weather_smalltalk: "天气真好啊！你喜欢晴天吗？",
  doctor_visit: "你好！你今天感觉怎么样？",
  hobbies_chat: "我很喜欢画画。你平时喜欢做什么？",
  airport_travel: "早上好！可以给我看一下你的机票吗？",
};

export function openingZh(scenarioId: string | null | undefined): string | null {
  if (!scenarioId) return null;
  return OPENING_ZH[scenarioId] ?? null;
}
