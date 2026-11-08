/**
 * 场景开场白的中文翻译（2026-11 修复：按「开场白文本」精确匹配）。
 *
 * 背景：开场白来自 `scenarios.json`（19 场景 × (1 基础 + 3 变体) = 76 条），
 * 在会话创建时作为第一条 assistant 消息入库；历史实现只按 scenario id 覆盖了 11 条固定开场白，
 * 用到变体/新场景时第一条消息就没有翻译（或翻译与文本对不上）。
 *
 * 约定：
 * - `OPENING_ZH_BY_TEXT`：**文本 → 中文**（精确匹配，覆盖全部内置场景与变体）
 * - `OPENING_ZH`：旧的 scenario id → 中文，仅用于**历史会话兜底**
 * - 新增场景/变体时必须同步补这里，否则 `check:openings` 守卫会失败
 */
export const OPENING_ZH_BY_TEXT: Record<string, string> = {
  "Hi! I'm Sam. What's your name?": "嗨！我是Sam。你叫什么名字？",
  "Hi! I'm Sam. Is that a new kite? It looks so cool!": "嗨！我是Sam。那是新风筝吗？看起来好酷！",
  "Um, hi… I'm Lily. Do you want to play tag with me?": "嗯，嗨……我是Lily。你想和我一起玩抓人吗？",
  "Hey! I'm Max. I just had my first swim class — do you swim too?": "嘿！我是Max。我刚上完第一堂游泳课——你也游泳吗？",
  "Welcome! What would you like to eat today?": "欢迎！你今天想吃什么？",
  "Hello! Today's special is tomato pasta. What would you like?": "你好！今天的特价是番茄意面。你想来点什么？",
  "Welcome in! Our beef noodles are the most popular — want to try?": "欢迎光临！我们的牛肉面最受欢迎——要不要试试？",
  "Come in! I'm making dumplings right now. Do you want to watch and try some?": "进来吧！我正在包饺子。想看着学、再尝尝吗？",
  "Hi! What class do you have today?": "嗨！你今天上什么课？",
  "Morning! Did you see the new science project? I'm so excited.": "早上好！你看到新的科学项目了吗？我好兴奋。",
  "Hello! It's reading time — which book would you like to borrow today?": "你好！现在是阅读时间——你今天想借哪本书？",
  "Hey, wait! I can't find my pencil case. Have you seen it anywhere?": "嘿，等一下！我找不到我的笔袋了。你在哪儿见过吗？",
  "Look! Do you see the big elephant?": "快看！你看到那头大象了吗？",
  "Look over there — we just had a baby monkey! Do you want to see it closer?": "你看那边——我们刚有一只猴宝宝！想靠近看看吗？",
  "Come quick! The elephants are having a bath. Have you ever seen that?": "快过来！大象在洗澡。你见过吗？",
  "I can't decide between the panda and the tiger. Which animal do you like best?": "我在熊猫和老虎之间选不出来。你最喜欢哪种动物？",
  "My birthday is on Saturday! Do you like cake?": "我的生日在星期六！你喜欢蛋糕吗？",
  "You came! The cake is almost ready — wait until you see it!": "你来啦！蛋糕快好了——等你看到一定喜欢！",
  "Psst! There's a treasure hunt behind the tree. Want to join my team?": "嘘！树后面有寻宝游戏。想加入我的队伍吗？",
  "Hi! It's so loud in here — I'm Mia, what's your name?": "嗨！这里好吵——我是Mia，你叫什么名字？",
  "Hi there! What can I get for you today?": "你好！今天想喝点什么？",
  "Hi there! We've got a new iced matcha today — what can I get you?": "你好！我们今天新出了冰抹茶——想喝点什么？",
  "Morning! Just so you know, the croissants are gone — what else can I get you?": "早上好！跟你说一声，可颂卖完了——还想来点什么？",
  "Sorry about the noise! The machine is a bit loud today. Coffee to go?": "抱歉有点吵！今天机器声音大。咖啡带走吗？",
  "Hello! Can I help you find something?": "你好！需要我帮你找点什么吗？",
  "Welcome! That blue jacket is half price today — want to try it on?": "欢迎！那件蓝色外套今天半价——想试穿吗？",
  "Hi! Our new running shoes just arrived — are you looking for something light?": "你好！我们的新款跑鞋刚到——你在找轻便的鞋吗？",
  "What do you think of this red dress? Be honest — should I get it?": "你觉得这条红裙子怎么样？说实话——我该买吗？",
  "What a lovely day! Do you like sunny weather?": "天气真好啊！你喜欢晴天吗？",
  "Oh dear, it's pouring! I forgot my umbrella — do you have one?": "哎呀，下大雨了！我忘带伞了——你有伞吗？",
  "Whoa! My hat! The wind is crazy today — can you help me catch it?": "哇！我的帽子！今天风好大——能帮我抓住它吗？",
  "It's so hot today and the bus is late again. Do you take this bus often?": "今天好热，公交车又晚了。你常坐这趟车吗？",
  "Hello! How are you feeling today?": "你好！你今天感觉怎么样？",
  "Hello, come in. What seems to be the problem today?": "你好，请进。今天哪里不舒服？",
  "Hi! You're next for your check-up — are you feeling nervous?": "嗨！轮到你体检了——你紧张吗？",
  "Let's see how tall you are now! Have you been eating your vegetables?": "看看你现在多高了！你平时有好好吃蔬菜吗？",
  "I love drawing. What do you like to do for fun?": "我很喜欢画画。你平时喜欢做什么？",
  "Look at this dragon I'm painting! What do you like to do after school?": "看我正在画的龙！你放学后喜欢做什么？",
  "I'm learning the piano! Do you want to try playing a few notes?": "我在学钢琴！你想试试弹几个音吗？",
  "Hey! I'm practising free throws — want to try one?": "嘿！我在练罚球——想试一个吗？",
  "Good morning! May I see your ticket, please?": "早上好！可以给我看一下你的机票吗？",
  "Good morning! Your flight is delayed by an hour. Do you need help with the gate?": "早上好！你的航班延误一小时。需要我帮你看登机口吗？",
  "Please take out your laptop — anything else in your bag?": "请把笔记本电脑拿出来——包里还有别的东西吗？",
  "Gate 12, right? I'm flying to see my grandma. Where are you going?": "12号登机口，对吧？我要飞去看奶奶。你去哪里？",
  "Good morning! What can I get for you today?": "早上好！今天想喝点什么？",
  "Morning! Our honey oat latte is new — can I get you one?": "早上好！我们的蜂蜜燕麦拿铁是新品——要来一杯吗？",
  "Heads up — the machine is being repaired. Filter coffee only today, is that OK?": "提醒一下——机器在维修。今天只有手冲咖啡，可以吗？",
  "Two-for-one until noon! Getting something for your colleagues too?": "中午前买一送一！也要给同事带点什么吗？",
  "Good afternoon, how can I help you with your reservation?": "下午好，关于您的预订需要我帮什么忙？",
  "Good evening — checking in for business? We still have late check-out available.": "晚上好——是来出差办入住吗？我们还提供延迟退房。",
  "Welcome! Our airport shuttle is free for guests. How many nights?": "欢迎！机场班车对住客免费。您住几晚？",
  "Hello! Breakfast is on the rooftop — would you like a quiet room?": "你好！早餐在楼顶——您想要安静一点的房间吗？",
  "Thanks for joining. Could you give me a quick update on this week?": "谢谢加入。能简单说一下这周的进展吗？",
  "Thanks for joining. The project is a bit behind — can you walk me through where we are?": "谢谢加入。项目有点落后——能带我过一遍目前到哪了吗？",
  "Quick one-on-one: the client asked for a change. How should we handle it?": "快速一对一：客户要求改需求。我们该怎么处理？",
  "Heads up, everyone: the deadline moved to Friday. Could you summarise your plan?": "提醒大家：截止日期改到周五。能概括一下你的计划吗？",
  "Any plans for the weekend?": "周末有什么计划吗？",
  "Finally Friday! I'm thinking of hiking this weekend — any plans?": "终于周五了！我打算周末去徒步——你有什么计划？",
  "I'm trying that new noodle place on Saturday. Want to come along?": "我星期六想去试试那家新面馆。要一起来吗？",
  "My friend gave me concert tickets for Sunday — do you like live music?": "我朋友给了我周日的音乐会票——你喜欢现场音乐吗？",
  "Hi, you look a bit lost — need a hand?": "嗨，你看起来有点迷路——需要帮忙吗？",
  "You look lost — looking for the metro? It's just behind the bank.": "你好像迷路了——在找地铁吗？就在银行后面。",
  "The museum? Two blocks down, then turn left — you can't miss it.": "博物馆？往前两个街区，然后左转——不会错过的。",
  "Station? There's a shortcut through the park — want me to point it out?": "车站？穿过公园有条近路——要我指给你看吗？",
  "Hello, what seems to be the problem today?": "你好，今天哪里不舒服？",
  "Hello, take a seat. How long have you had these headaches?": "你好，请坐。这些头痛有多久了？",
  "Your blood test results came in — would you like to go through them now?": "你的验血结果出来了——想现在一起看看吗？",
  "You're here for a refill? Which medication are you currently taking?": "你是来续方的吗？目前在吃什么药？",
  "Hi there, are you looking for something in particular?": "你好，在找什么特别的东西吗？",
  "Hi! Apples are on special today — are you looking for anything else?": "你好！苹果今天特价——还要找点别的吗？",
  "Sorry for the wait, the card reader is slow today. Do you have another payment method?": "抱歉久等，今天刷卡机有点慢。您还有别的支付方式吗？",
  "Looking for milk? The delivery is late today — have you tried the second shelf?": "在找牛奶？今天送货晚了——您看过第二层货架了吗？",
  "Welcome! Today we're making a simple pasta. Ready to start?": "欢迎！今天我们做简单的意面。准备好了吗？",
  "Welcome! Today it's mushroom risotto. Ready to start with the onions?": "欢迎！今天做蘑菇烩饭。准备好从洋葱开始了吗？",
  "We're making dumplings today! Would you like to try folding one?": "今天我们包饺子！想试试包一个吗？",
  "The dough needs an hour to rest — shall we prepare the topping while we wait?": "面团要醒一小时——我们要不要先准备配料？",
};

/** 旧的按 scenario id 覆盖（历史兜底；新代码优先用 OPENING_ZH_BY_TEXT） */
export const OPENING_ZH: Record<string, string> = {
  "self_intro": "嗨！我是 Sam。你叫什么名字？",
  "ordering_food": "欢迎！你今天想吃点什么？",
  "school_day": "嗨！你今天上什么课？",
  "animals_zoo": "快看！你看到那头大象了吗？",
  "birthday_party": "我的生日在星期六！你喜欢蛋糕吗？",
  "ordering_coffee": "你好！今天想喝点什么？",
  "shopping_clothes": "你好！需要我帮你找点什么吗？",
  "weather_smalltalk": "天气真好啊！你喜欢晴天吗？",
  "doctor_visit": "你好！你今天感觉怎么样？",
  "hobbies_chat": "我很喜欢画画。你平时喜欢做什么？",
  "airport_travel": "早上好！可以给我看一下你的机票吗？",
};

/** 按开场白文本取中文；取不到再用 scenario id（兼容历史数据） */
export function openingZhFor(text: string | null | undefined, scenarioId?: string | null): string | null {
  const t = (text ?? "").trim();
  if (t && OPENING_ZH_BY_TEXT[t]) return OPENING_ZH_BY_TEXT[t];
  if (scenarioId && OPENING_ZH[scenarioId]) return OPENING_ZH[scenarioId];
  return null;
}

/** @deprecated 新代码用 openingZhFor(text, scenarioId) */
export function openingZh(scenarioId: string | null | undefined): string | null {
  if (!scenarioId) return null;
  return OPENING_ZH[scenarioId] ?? null;
}
