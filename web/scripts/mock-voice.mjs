#!/usr/bin/env node
/**
 * english-coach 离线 mock voice service（开发/CI 用，实现 docs/api-contract.md v1）。
 *
 * ⚠️ 这不是 voice 模块的交付物 —— voice 由同事在 voice/ 下用 FastAPI 实现。
 * 这里只是 web 侧为了「无密钥、无 GPU、可复现」地跑通 E2E 而写的最小桩：
 * 确定性假数据、无外部依赖（只用 node 内置模块）。
 *
 * 环境变量：
 *   PORT=8100                监听端口
 *   PROVIDER_MODE=mock       /v1/health 的 mode
 *   MOCK_PHONEME_LEVEL=0     模拟「音素级不可用」，强制返回单词级粗评 + warning
 *   MOCK_FORCE_500=pronounce,dialogue   让指定端点返回 502，用于验证 web 的降级与"不丢数据"
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? 8100);
const MODE = process.env.PROVIDER_MODE ?? "mock";
const PHONEME_LEVEL = process.env.MOCK_PHONEME_LEVEL !== "0";
const FORCE_500 = new Set(
  (process.env.MOCK_FORCE_500 ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const CAPS = {
  phoneme_level: PHONEME_LEVEL,
  prosody: true,
  intonation_curve: true,
  nbest_phonemes: PHONEME_LEVEL,
  ssml: false,
  gpu: false,
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function err(res, status, code, message, detail = {}) {
  json(res, status, { error: { code, message, detail } });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** 极简 multipart 文本字段提取（不依赖任何库；mock 只需要几个文本字段）。 */
function multipartFields(buf, contentType) {
  const m = /boundary=(.+)$/.exec(contentType ?? "");
  if (!m) return {};
  const boundary = `--${m[1].trim().replace(/^"|"$/g, "")}`;
  const text = buf.toString("latin1");
  const fields = {};
  for (const part of text.split(boundary)) {
    const idx = part.indexOf("\r\n\r\n");
    if (idx < 0) continue;
    const headers = part.slice(0, idx);
    const nameMatch = /name="([^"]+)"/.exec(headers);
    if (!nameMatch) continue;
    let value = part.slice(idx + 4);
    value = value.replace(/\r\n$/, "");
    fields[nameMatch[1]] = Buffer.from(value, "latin1").toString("utf8");
  }
  return fields;
}

/** 确定性伪随机（同一输入永远同一结果，便于断言）。 */
function rng(seed) {
  let h = crypto.createHash("sha256").update(String(seed)).digest().readUInt32BE(0);
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 0x100000000;
  };
}

const PHONEME_RULES = [
  [/^th/, "θ"],
  [/sh/, "ʃ"],
  [/ch/, "tʃ"],
  [/ng/, "ŋ"],
  [/r/, "r"],
  [/l/, "l"],
  [/v/, "v"],
  [/w/, "w"],
  [/ee/, "iː"],
  [/oo/, "uː"],
  [/a/, "æ"],
  [/e/, "e"],
  [/i/, "ɪ"],
  [/o/, "ɒ"],
  [/u/, "ʌ"],
  [/s/, "s"],
  [/n/, "n"],
  [/k/, "k"],
];

const HINT_BY_PHONEME = {
  "θ": "th_voiceless",
  "ð": "th_voiced",
  r: "r_l_v",
  l: "r_l_v",
  v: "v_w",
  w: "v_w",
  "ɪ": "short_i_long_i",
  "iː": "short_i_long_i",
  "æ": "ae_e",
  e: "ae_e",
  s: "s_sh",
  "ʃ": "s_sh",
  n: "n_ng",
  "ŋ": "n_ng",
  "ə": "schwa",
};

function phonemesFor(word) {
  const lower = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!lower) return [{ phoneme: "ə", weight: 1 }];
  const out = [];
  let i = 0;
  while (i < lower.length) {
    const slice = lower.slice(i);
    let matched = null;
    for (const [re, ph] of PHONEME_RULES) {
      if (re.test(slice)) {
        matched = ph;
        break;
      }
    }
    if (matched) {
      // 避免同一音素连续重复堆积
      if (out[out.length - 1]?.phoneme !== matched || matched.length > 1) {
        out.push({ phoneme: matched, weight: 1 });
      }
      i += Math.max(1, matched.length > 1 ? 2 : 1);
    } else {
      i += 1;
    }
    if (out.length >= 5) break;
  }
  return out.length > 0 ? out : [{ phoneme: "ə", weight: 1 }];
}

function mockPronounce(fields) {
  const reference = (fields.reference_text ?? "").trim();
  const granularity = PHONEME_LEVEL ? (fields.granularity === "word" ? "word" : "phoneme") : "word";
  const words = reference.split(/\s+/).filter(Boolean);
  const rand = rng(reference + granularity);

  const issues = [];
  let t = 0;
  const wordResults = words.map((raw) => {
    const word = raw.replace(/[^A-Za-z']/g, "") || raw;
    const start = t;
    const dur = 260 + Math.floor(rand() * 260);
    const end = start + dur;
    t = end + 40;
    // 让"th/r/l/v/w"这类词有更大概率出问题，方便演示热力图
    const tricky = /th|r|l|v|w/i.test(word);
    const baseScore = tricky ? 44 + rand() * 32 : 72 + rand() * 28;
    const wordScore = Math.round(Math.max(20, Math.min(99, baseScore)) * 10) / 10;

    let phonemes = [];
    if (granularity === "phoneme") {
      const list = phonemesFor(word);
      const span = Math.max(1, Math.round((end - start) / list.length));
      let ps = start;
      phonemes = list.map((p) => {
        const pScore = Math.round(
          Math.max(15, Math.min(99, wordScore + (rand() * 30 - 15))) * 10,
        ) / 10;
        const item = {
          phoneme: p.phoneme,
          score: pScore,
          start_ms: ps,
          end_ms: Math.min(end, ps + span),
          nbest: [
            { phoneme: p.phoneme, score: 100 },
            { phoneme: pScore < 60 ? (p.phoneme === "θ" ? "s" : "ə") : "ə", score: 62 },
          ],
        };
        ps += span;
        if (pScore < 60) {
          issues.push({
            type: "Mispronunciation",
            severity: pScore < 40 ? "high" : "medium",
            word,
            phoneme: p.phoneme,
            expected: p.phoneme,
            actual: p.phoneme === "θ" ? "s" : p.phoneme === "v" ? "w" : "ə",
            score: pScore,
            start_ms: item.start_ms,
            end_ms: item.end_ms,
            hint_key: HINT_BY_PHONEME[p.phoneme] ?? "schwa",
          });
        }
        return item;
      });
    } else {
      if (wordScore < 70) {
        issues.push({
          type: "Mispronunciation",
          severity: wordScore < 55 ? "high" : "medium",
          word,
          phoneme: null,
          expected: null,
          actual: null,
          score: wordScore,
          start_ms: start,
          end_ms: end,
          hint_key: "final_consonant",
        });
      }
    }

    return {
      word,
      start_ms: start,
      end_ms: end,
      score: wordScore,
      error_type: wordScore < 60 ? "Mispronunciation" : "None",
      phonemes: granularity === "phoneme" ? phonemes : undefined,
    };
  });

  const scores = wordResults.map((w) => w.score);
  const worst = [...scores].sort((a, b) => a - b);
  const pron = worst.length
    ? Math.round(
        (0.4 * worst[0] +
          0.2 * (worst[1] ?? worst[0]) +
          0.2 * (worst[2] ?? worst[0]) +
          0.2 * worst[worst.length - 1]) *
          10,
      ) / 10
    : null;

  issues.sort((a, b) => a.score - b.score);
  const topIssues = issues.slice(0, 5);

  const duration = t;
  const step = 20;
  const points = Math.min(600, Math.max(20, Math.floor(duration / step)));
  const userF0 = [];
  const refF0 = [];
  const r2 = rng("f0" + reference);
  for (let i = 0; i < points; i++) {
    const timeMs = i * step;
    const voiced = i % 17 !== 0;
    userF0.push([
      timeMs,
      voiced ? Math.round((175 + 22 * Math.sin(i / 7) + r2() * 8) * 10) / 10 : null,
    ]);
    refF0.push([
      timeMs,
      voiced ? Math.round((192 + 26 * Math.sin(i / 7 + 0.35) + r2() * 4) * 10) / 10 : null,
    ]);
  }

  const warnings = [];
  if (!PHONEME_LEVEL) warnings.push("phoneme_level_unavailable");

  return {
    provider: "mock",
    granularity,
    mode: fields.mode === "unscripted" ? "unscripted" : "scripted",
    reference_text: reference,
    recognized_text: words.join(" "),
    duration_ms: duration,
    scores: {
      pron,
      accuracy: pron === null ? null : Math.round(Math.min(99, pron + 6) * 10) / 10,
      fluency: Math.round(Math.min(99, (pron ?? 70) + 12) * 10) / 10,
      completeness: 100.0,
      prosody: Math.round(Math.min(99, (pron ?? 70) + 2) * 10) / 10,
    },
    words: wordResults,
    issues: topIssues,
    intonation: {
      available: true,
      dtw_distance: Math.round((0.2 + r2() * 0.5) * 100) / 100,
      user_f0: userF0,
      reference_f0: refF0,
      worst_regions: [
        {
          start_ms: Math.floor(duration * 0.4),
          end_ms: Math.floor(duration * 0.65),
          text: words.slice(1, 3).join(" ") || reference,
          issue: "expected_rise_but_flat",
          user_slope: -0.2,
          ref_slope: 3.1,
        },
      ],
      reference_audio_url: `/voice/v1/audio/ref_${crypto
        .createHash("sha1")
        .update(reference)
        .digest("hex")
        .slice(0, 12)}.wav`,
    },
    warnings,
    provider_meta: { mock: true, phoneme_level_forced_off: !PHONEME_LEVEL },
  };
}

const HINT_TEXT = {
  th_voiceless: {
    title_zh: "think 里的 /θ/ 读成了 /s/",
    title_child: "think 开头要轻轻咬一下舌尖",
    why: "舌尖没有伸出来，气流从牙龈缝隙出去了。",
    how: "舌尖轻轻伸到上下齿之间，让气流从缝里摩擦出来，声带不振动。",
    words: ["think", "thank", "three", "thick"],
  },
  r_l_v: {
    title_zh: "/r/ 与 /l/ 混淆",
    title_child: "r 和 l 要分开说",
    why: "舌尖卷起与顶住上齿龈的动作没有分开。",
    how: "/r/ 舌尖悬空后卷，/l/ 舌尖顶住上齿龈。",
    words: ["right", "light", "really", "little"],
  },
  v_w: {
    title_zh: "/v/ 与 /w/ 混淆",
    title_child: "v 要咬嘴唇，w 要圆嘴巴",
    why: "上齿没有咬下唇。",
    how: "上齿轻咬下唇送气＝/v/；双唇收圆＝/w/。",
    words: ["very", "west", "voice", "water"],
  },
  final_consonant: {
    title_zh: "词尾辅音丢失",
    title_child: "最后一个音也要说完整",
    why: "词尾辅音没有发出来。",
    how: "句子结束时也把最后的辅音轻轻收住。",
    words: ["book", "good", "cat"],
  },
  schwa: {
    title_zh: "非重读弱元音",
    title_child: "不重要的音节读轻一点",
    why: "每个音节都读得太重。",
    how: "非重读音节放松成轻轻的「呃」。",
    words: ["banana", "about", "teacher"],
  },
};

function mockFeedback(body) {
  const isChild = body?.learner?.age_band === "child";
  const pron = body?.scores?.pron ?? null;
  const issues = Array.isArray(body?.issues) ? body.issues.slice(0, 2) : [];
  const points = issues.map((i) => {
    const h = HINT_TEXT[i.hint_key] ?? HINT_TEXT.final_consonant;
    return {
      title: isChild ? h.title_child : h.title_zh,
      why: h.why,
      how: h.how,
      practice_words: isChild ? h.words.slice(0, 3) : h.words,
      demo_text: h.words.slice(0, 3).join(", "),
      severity: i.score !== null && i.score !== undefined && i.score < 45 ? "high" : "medium",
    };
  });
  return {
    provider: "template",
    summary:
      pron === null
        ? "这次没有拿到分数，不过你已经开口啦 👍"
        : isChild
          ? `这次 ${Math.round(pron)} 分，${pron >= 80 ? "真棒！🌟" : "再读一次会更好哦 💪"}`
          : `整句完成度不错，综合 ${Math.round(pron)} 分。`,
    praise: isChild ? "你完整地把这句话说完了，很棒！" : "句子读完了，节奏保持得不错。",
    points,
    closing: isChild ? "我们再读一次好不好？我读一句你跟一句 🔊" : "再录一遍试试？先听示范音 🔊",
  };
}

const SCENARIO_LINES = {
  self_intro: ["Nice to meet you, {name}!", "I am seven. How old are you?", "I like drawing. And you?"],
  ordering_food: ["Sure! Would you like rice or noodles?", "Anything to drink?", "Great choice! Here you are."],
  school_day: ["We have English first. Do you like English?", "My favourite is music class.", "See you at lunch!"],
  animals_zoo: ["Yes! It has a long nose.", "Look at the monkeys! They are funny.", "The lions are sleeping now."],
  birthday_party: ["Yes, I love cake!", "We will play games too.", "Come at three o'clock!"],
  ordering_coffee: ["Sure! Hot or iced?", "Would you like milk with that?", "That will be three dollars."],
  shopping_clothes: ["Of course! What size do you need?", "We have it in blue and red.", "The fitting room is over there."],
  weather_smalltalk: ["Me too! It is warm today.", "I hope it stays sunny tomorrow.", "Have a nice day!"],
  doctor_visit: ["I see. Does your throat hurt?", "Drink warm water and rest.", "You will feel better soon."],
  hobbies_chat: ["That sounds fun! How often do you draw?", "I like reading comics too.", "Maybe we can draw together!"],
  airport_travel: ["Thank you. Any bags to check in?", "Here is your boarding pass.", "Your gate is B12. Have a good flight!"],
};

function mockDialogue(body) {
  const scenario = body?.scenario ?? {};
  const history = Array.isArray(body?.history) ? body.history : [];
  const turnIndex = Number(body?.turn_index ?? 0);
  const isChild = body?.learner?.age_band === "child" || body?.learner?.child_safe === true;
  const lines = SCENARIO_LINES[scenario.id] ?? ["That sounds good!", "Tell me more about it.", "Nice talking to you!"];
  const reply = lines[Math.min(turnIndex, lines.length - 1)];
  const lastUser = [...history].reverse().find((h) => h.role === "user");
  const userText = lastUser?.text ?? "";

  let correction = {
    has_error: false,
    type: null,
    original: null,
    better: null,
    explain_zh: null,
    severity: null,
  };
  if (body?.correction_level !== "none" && /^i want\b/i.test(userText.trim())) {
    correction = {
      has_error: true,
      type: "politeness",
      original: userText,
      better: userText.replace(/^i want\b/i, "I'd like"),
      explain_zh: "点单时用 I'd like 比 I want 更礼貌。",
      severity: "low",
    };
  }

  const done = turnIndex >= 5;
  return {
    provider: "template",
    reply: done ? "Great job today! See you next time!" : reply,
    reply_zh: done ? "今天就到这里，下次见！" : null,
    correction,
    suggested_replies: isChild
      ? ["Yes, please!", "No, thank you.", "I like it!"]
      : ["Yes, please.", "That sounds good.", "Could you say that again?"],
    target_words: ["please", "would"],
    flag: "ok",
    done,
  };
}

/** 生成一段 0.6s 的静音 WAV，保证 <audio> 能播、Content-Type 正确。 */
function tinyWav() {
  const sampleRate = 16000;
  const seconds = 0.6;
  const samples = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    // 一个很轻的 440Hz 正弦，便于人工确认音量条有波动
    buf.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 1200), 44 + i * 2);
  }
  return buf;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const key = path.replace(/^\/v1\//, "").split("/")[0];

  // 测试控制端点（仅 mock 有）：POST /__mock/force500 {"endpoints":["pronounce"]}
  if (path === "/__mock/force500" && req.method === "POST") {
    const buf = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(buf.toString("utf8") || "{}");
    } catch {
      return err(res, 400, "bad_request", "非法 JSON");
    }
    FORCE_500.clear();
    for (const e of body.endpoints ?? []) FORCE_500.add(String(e));
    return json(res, 200, { forced: [...FORCE_500] });
  }

  if (path === "/v1/health" && req.method === "GET") {
    return json(res, 200, {
      status: "ok",
      version: "0.1.0-mock",
      mode: MODE,
      providers: { asr: "mock", pa: "mock", tts: "mock", llm: "mock" },
      capabilities: CAPS,
    });
  }

  if (FORCE_500.has(key)) {
    return err(res, 502, "provider_error", `mock 强制失败：${key}`, { forced: true });
  }

  if (path === "/v1/asr" && req.method === "POST") {
    const buf = await readBody(req);
    const fields = multipartFields(buf, req.headers["content-type"]);
    void fields;
    return json(res, 200, {
      text: "I want a coffee.",
      language: "en",
      duration_ms: 1800,
      words: [
        { word: "I", start_ms: 0, end_ms: 120, probability: 0.98 },
        { word: "want", start_ms: 140, end_ms: 420, probability: 0.93 },
        { word: "a", start_ms: 440, end_ms: 520, probability: 0.9 },
        { word: "coffee", start_ms: 540, end_ms: 1200, probability: 0.88 },
      ],
      provider: "mock",
    });
  }

  if (path === "/v1/pronounce" && req.method === "POST") {
    const buf = await readBody(req);
    if (buf.length === 0) return err(res, 400, "bad_request", "audio 为空");
    const fields = multipartFields(buf, req.headers["content-type"]);
    if (!fields.reference_text) {
      return err(res, 400, "bad_request", "reference_text 必填");
    }
    return json(res, 200, mockPronounce(fields));
  }

  if (path === "/v1/feedback" && req.method === "POST") {
    const buf = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(buf.toString("utf8") || "{}");
    } catch {
      return err(res, 400, "bad_request", "非法 JSON");
    }
    return json(res, 200, mockFeedback(body));
  }

  if (path === "/v1/dialogue" && req.method === "POST") {
    const buf = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(buf.toString("utf8") || "{}");
    } catch {
      return err(res, 400, "bad_request", "非法 JSON");
    }
    return json(res, 200, mockDialogue(body));
  }

  if (path === "/v1/tts" && req.method === "POST") {
    const buf = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(buf.toString("utf8") || "{}");
    } catch {
      return err(res, 400, "bad_request", "非法 JSON");
    }
    const text = body.text ?? "";
    if (text.length > 2000) return err(res, 413, "payload_too_large", "文本超过 2000 字符");
    const wav = tinyWav();
    res.writeHead(200, {
      "content-type": "audio/wav",
      "content-length": wav.length,
      "x-tts-provider": "mock",
      "x-audio-duration-ms": "600",
    });
    return res.end(wav);
  }

  if (path.startsWith("/v1/audio/") && req.method === "GET") {
    const id = path.slice("/v1/audio/".length);
    if (!/^ref_[0-9a-f]{12}\.(wav|mp3)$/.test(id)) {
      return err(res, 404, "audio_not_found", "示范音不存在");
    }
    const wav = tinyWav();
    res.writeHead(200, {
      "content-type": "audio/wav",
      "content-length": wav.length,
      "cache-control": "public, max-age=604800",
    });
    return res.end(wav);
  }

  return err(res, 404, "bad_request", `mock voice 不认识这个路径：${path}`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[mock-voice] listening http://127.0.0.1:${PORT} mode=${MODE} phoneme_level=${PHONEME_LEVEL}` +
      (FORCE_500.size ? ` force500=${[...FORCE_500].join(",")}` : ""),
  );
});
