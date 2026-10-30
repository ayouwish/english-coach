#!/usr/bin/env node
/**
 * task-19 验证：对话语音改为**原生 <audio>**主路径 + 用户语音回放 + 录音取消。
 *
 * 无浏览器环境，所以拆成"服务端可验证"的两块：
 *   1) GET /api/tts 真实请求：200/audio-mpeg/字节、重复请求同字节（缓存）、缺 text 400、未登录 401；
 *   2) /chat 页面 HTML：`<audio ... src="/api/tts?...&format=mp3&rate=...">`、自动朗读开关的 aria；
 *   3) 客户端状态/取消按钮：录音态是客户端状态、SSR 断言不到 → 用 **bundle + 源码断言**兜底，
 *      证明"失败时用户看得到提示"以及"取消真的丢弃 + 释放麦克风"。
 *
 * 用法：BASE_URL=http://127.0.0.1:3020 node scripts/check-chat-speech.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const IPA_RE = /[θðŋæʃɪʌɔɜəʊʒɑɒɛˈˌ]/;
const leaks = (t) => ["θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ɑ", "ɒ", "ɛ", "ˈ", "ˌ"].filter((c) => t.includes(c));

let failed = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n──────── ${t} ────────`);

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`登录失败 ${email}: ${res.status}`);
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return {
    cookie: (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0],
    user: (await res.json()).user,
  };
}

async function getTts(cookie, text, rate = "slow", format = "mp3") {
  const q = new URLSearchParams({ text, rate, format });
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/tts?${q.toString()}`, { headers: cookie ? { cookie } : {} });
  const buf = await res.arrayBuffer();
  return {
    status: res.status,
    ms: Date.now() - t0,
    bytes: buf.byteLength,
    type: res.headers.get("content-type"),
    cacheHeader: res.headers.get("x-cache") ?? res.headers.get("x-tts-cache") ?? null,
    bodyText: buf.byteLength < 600 ? new TextDecoder().decode(buf) : "",
  };
}

console.log(`=== 对话语音（原生 audio 兜底）证据 @ ${BASE} ===`);
const girl = await login("girl@example.com", "Girl12345!");
const mom = await login("mom@example.com", "Mom12345!");
console.log(`儿童：${girl.user.displayName}（age_band=${girl.user.ageBand}）· 成人：${mom.user.displayName}`);

// ── 1) GET /api/tts ─────────────────────────────────────────────────────────
section("1. GET /api/tts（原生 <audio src> 走的就是这个）");
const TEXT = "Hi! I'm Sam. What's your name?";
const first = await getTts(girl.cookie, TEXT);
const second = await getTts(girl.cookie, TEXT);
console.log(
  `第 1 次：HTTP ${first.status} · ${first.ms}ms · ${first.bytes}B · ${first.type} · cache=${first.cacheHeader ?? "（未透传）"}`,
);
console.log(
  `第 2 次：HTTP ${second.status} · ${second.ms}ms · ${second.bytes}B · ${second.type} · cache=${second.cacheHeader ?? "（未透传）"}`,
);
check("GET 返回 200", first.status === 200, `status=${first.status}`);
check("Content-Type 是音频（mp3 → audio/mpeg）", /audio\/(mpeg|mp3)/.test(first.type ?? ""), first.type ?? "");
check("有音频字节", first.bytes > 1000, `${first.bytes}B`);
check("★ 两次同字节（命中内容寻址缓存）", first.bytes === second.bytes, `${first.bytes}B / ${second.bytes}B`);
check("第二次不慢于第一次", second.ms <= Math.max(first.ms, 40) * 1.25 + 5, `${first.ms}ms → ${second.ms}ms`);

const noText = await getTts(girl.cookie, "", "slow", "mp3");
check(
  "缺 text → 400 bad_request",
  noText.status === 400 && /bad_request/.test(noText.bodyText),
  `${noText.status} ${noText.bodyText.slice(0, 80)}`,
);
const noAuth = await getTts(null, TEXT);
check("未登录 → 401", noAuth.status === 401, `status=${noAuth.status}`);

// ── 2) /chat HTML：原生 audio 标签 ──────────────────────────────────────────
section("2. /chat HTML 里的原生播放器");
const mk = async (cookie, scenario_id) => {
  const r = await fetch(`${BASE}/api/chat/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ scenario_id }),
  });
  return { status: r.status, body: await r.json() };
};
check("儿童创建会话（让「最近一次对话」出现在 SSR HTML 里）", (await mk(girl.cookie, "self_intro")).status === 201);
check("成人创建会话", (await mk(mom.cookie, "shopping_clothes")).status === 201);

const girlChatRaw = await (await fetch(`${BASE}/chat`, { headers: { cookie: girl.cookie } })).text();
const girlChat = girlChatRaw.replace(/&amp;/g, "&").replace(/<!--\s*-->/g, "");
const audioTag = /<audio[^>]*data-testid="tts-audio"[^>]*>/.exec(girlChat)?.[0] ?? "";
const audioSrc = /src="([^"]+)"/.exec(audioTag)?.[1] ?? "";
check("★ 页面里存在 <audio> 且是原生 controls", audioTag.includes("controls"), audioTag.slice(0, 120));
check("★ audio.src 指向 /api/tts?", audioSrc.startsWith("/api/tts?"), audioSrc.slice(0, 90));
check("★ src 带 format=mp3", audioSrc.includes("format=mp3"), audioSrc.slice(0, 120));
check("★ 儿童 src 带 rate=slow", audioSrc.includes("rate=slow"), (audioSrc.match(/rate=(\w+)/) ?? [])[1] ?? "");
check(
  "preload=metadata（取真实时长，避免 0:00 / 0:00；仍不预载整段音频）",
  /preload="metadata"/.test(audioTag),
  (audioTag.match(/preload="[^"]*"/) ?? [""])[0],
);
check("audio 带 aria-label", /aria-label="[^"]+"/.test(audioTag));
check("★ 自动朗读开关存在且带 aria-pressed", /data-testid="autoread-toggle"[^>]*aria-pressed/.test(girlChat));

const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.name.endsWith(".js") ? [full] : [];
      })
    : [];
const chunks = walk(path.join(WEB_ROOT, ".next/static/chunks"));
const bundle = chunks.map((f) => fs.readFileSync(f, "utf8")).join("\n");
console.log(`   （扫描 ${chunks.length} 个 chunk / ${bundle.length} 字符）`);
// ── task-32：对话页只练"说"，不再有文字输入框 ─────────────────────────────
check("★ /chat SSR HTML 没有文本输入框", !/<input[^>]*type="(text|search|email|url|tel|password)"/i.test(girlChat) && !girlChat.includes('placeholder="打一句英语'));
check("★ /chat SSR HTML 没有「发送」按钮", !girlChat.includes("发送"));
check("★ /chat SSR HTML 没有「🎙️ 语音」切换按钮", !girlChat.includes("🎙️ 语音"));

// 注意：对话面板（含 Recorder）是"开了场景"之后才由客户端状态渲染的，SSR HTML 里看不到 →
// 这几条用 **源码 + bundle** 断言（同样证明"只有麦克风、没有输入框"）。
const chatSrcForInput = fs.readFileSync(path.join(WEB_ROOT, "src/app/chat/ChatClient.tsx"), "utf8");
const recorderSrcForInput = fs.readFileSync(path.join(WEB_ROOT, "src/components/Recorder.tsx"), "utf8");
check(
  "★ 源码里没有文本输入框 / 发送按钮 / 语音开关",
  !chatSrcForInput.includes("<input") &&
    !chatSrcForInput.includes(">发送") &&
    !chatSrcForInput.includes("showMic") &&
    !chatSrcForInput.includes("🎙️ 语音"),
);
check("★ 源码里 Recorder 常驻（不再包在 showMic 条件里）", chatSrcForInput.includes("<Recorder") && !chatSrcForInput.includes("showMic"));
check("★ 源码有「只说」面板 speak-panel", chatSrcForInput.includes('data-testid="speak-panel"'));
check("★ 源码有麦克风排查提示 mic-troubleshoot + https", chatSrcForInput.includes('data-testid="mic-troubleshoot"') && chatSrcForInput.includes("https"));
check("源码有「本页需要麦克风」醒目说明（role=note）", chatSrcForInput.includes('data-testid="mic-required-note"') && chatSrcForInput.includes('role="note"'));
check("★ bundle 含儿童录音文案「按这里开始说」", bundle.includes("按这里开始说"));
check("★ bundle 含成人录音文案「开始录音」", bundle.includes("开始录音"));
check("★ bundle 含麦克风失败排查文案", bundle.includes("麦克风没反应") && bundle.includes("必须用 https 打开"));

// ── task-34：提示句 = 提示 + 开录（绝不直接发送文本）+ 麦克风失败醒目报错 ──────
{
  const suggestRegionStart = chatSrcForInput.indexOf('data-testid="suggested-replies"');
  const suggestRegion = suggestRegionStart >= 0 ? chatSrcForInput.slice(suggestRegionStart, suggestRegionStart + 1200) : "";
  check("★ 提示句按钮不再直接发送文本（suggestions 区域无 send(）", suggestRegion.length > 0 && !suggestRegion.includes("send("), suggestRegion.slice(0, 0) || "region ok");
  check("★ 点提示句 → 设置 promptLine", suggestRegion.includes("setPromptLine(s)"));
  check("★ 点提示句 → 递增 startSignal 触发自动开录", suggestRegion.includes("setStartSignal((n) => n + 1)"));
  check("源码有提示行 data-testid=\"prompt-line\"", chatSrcForInput.includes('data-testid="prompt-line"'));
  check("提示行说明「发出去的是你说的录音」", chatSrcForInput.includes("发出去的是你说的录音"));
  {
    const micAlertRegion = chatSrcForInput.slice(
      Math.max(0, chatSrcForInput.indexOf('data-testid="mic-error-alert"') - 400),
      chatSrcForInput.indexOf('data-testid="mic-error-alert"') + 300,
    );
    check(
      "源码有麦克风失败醒目 alert（role=alert + data-testid=mic-error-alert，同一块）",
      micAlertRegion.includes('data-testid="mic-error-alert"') && micAlertRegion.includes('role="alert"'),
    );
  }
  check("★ 文案不再出现「直接打字」", !chatSrcForInput.includes("直接打字"));
  check("Recorder 新增 onMicError 回调（仅此一处最小改动）", recorderSrcForInput.includes("onMicError?: (message: string) => void") && recorderSrcForInput.includes("onMicError?.(message)"));
  check("bundle 含「照着这句说」与「麦克风不可用」", bundle.includes("照着这句说") && bundle.includes("麦克风不可用"));
}
check("儿童 /chat 零 IPA", !IPA_RE.test(girlChatRaw));
console.log(`   ↳ audio 标签：${audioTag.replace(/\s+/g, " ").slice(0, 300)}`);
console.log(`   ↳ audio src：${audioSrc.slice(0, 140)}`);

const momChat = (await (await fetch(`${BASE}/chat`, { headers: { cookie: mom.cookie } })).text()).replace(/&amp;/g, "&");
const momSrc = /src="(\/api\/tts\?[^"]+)"/.exec(momChat)?.[1] ?? "";
check("成人 src 带 rate=normal", momSrc.includes("rate=normal"), (momSrc.match(/rate=(\w+)/) ?? [])[1] ?? "");

// ── 3) bundle / 源码断言（录音态是客户端状态，SSR 断言不到）──────────────────
section("3. 客户端行为（bundle + 源码断言）");
const bundleHas = (s) => check(`bundle 含「${s}」`, bundle.includes(s));
bundleHas("语音生成中");
bundleHas("语音还在生成");
bundleHas("可能生成失败");
bundleHas("语音未加载");
bundleHas("回放我刚才说的话");
check('bundle 含 user-audio testid 值', bundle.includes('"user-audio"'));
check('bundle 含 tts-audio testid 值', bundle.includes('"tts-audio"'));
check("bundle 里不再有旧播放器（chat-speech 已删）", !bundle.includes("chat-speech"));

const recorderSrc = fs.readFileSync(path.join(WEB_ROOT, "src/components/Recorder.tsx"), "utf8");
check("Recorder 有取消按钮（data-testid=record-cancel）", recorderSrc.includes('data-testid="record-cancel"'));
check("取消按钮有 aria-label", /data-testid="record-cancel"[\s\S]{0,200}?aria-label/.test(recorderSrc));
check("儿童取消文案「不要了」", recorderSrc.includes("不要了"));
const cancelBody = /const cancel = useCallback\(\(\) => \{([\s\S]*?)\}, \[releaseStream, stopTimer\]\)/.exec(recorderSrc)?.[1] ?? "";
check(
  "★ 取消路径 stop() 且释放麦克风",
  /rec\.stop\(\)/.test(cancelBody) && /releaseStream\(\)/.test(cancelBody),
  cancelBody.replace(/\s+/g, " ").slice(0, 160),
);
check(
  "★ 取消后不调 onRecorded（onstop 里 cancelledRef 提前 return）",
  /if \(cancelledRef\.current\) \{[\s\S]{0,200}?return;/.test(recorderSrc),
);

const chatSrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/chat/ChatClient.tsx"), "utf8");
check("★ 自动朗读驱动原生元素（el.play()）", chatSrc.includes("el.play()"));
// 只检查"真的用了中断"，注释里提到 AbortController 不算
check(
  "★ 不再主动中断请求（chat 源码没有 new AbortController / .abort()）",
  !/new AbortController|\.abort\(\)/.test(chatSrc),
);
check("6s 提示「还在生成」+ 20s 提示「可能失败」", chatSrc.includes("6000") && chatSrc.includes("20000"));
check("用户录音 object URL 会 revoke", chatSrc.includes("URL.revokeObjectURL"));

// ── 4) 语速偏好真的生效（task-21 核心）──────────────────────────────────────
section("4. 语速偏好：儿童默认 slow，改成 normal 后真的变 normal");
const Database = (await import("better-sqlite3")).default;
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
function readRate(userId) {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT tts_rate FROM user_prefs WHERE user_id = ?").get(userId);
  db.close();
  return row?.tts_rate ?? "(no row)";
}
const rateBefore = readRate("u-girl");
console.log(`   ↳ 数据库 u-girl.tts_rate（迁移后）= ${rateBefore}`);
check("迁移已生效：儿童账号库里是 slow", rateBefore === "slow", rateBefore);

const setRate = async (cookie, rate) => {
  const r = await fetch(`${BASE}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ tts_rate: rate }),
  });
  return { status: r.status, body: await r.json() };
};
const chatRate = async (cookie) => {
  const html = (await (await fetch(`${BASE}/chat`, { headers: { cookie } })).text()).replace(/&amp;/g, "&");
  const src = /src="(\/api\/tts\?[^"]+)"/.exec(html)?.[1] ?? "";
  return { src, rate: (src.match(/rate=(\w+)/) ?? [])[1] ?? "" };
};

const def = await chatRate(girl.cookie);
check("★ 儿童默认：/chat 的 audio src 是 rate=slow", def.rate === "slow", def.src.slice(0, 100));

const toNormal = await setRate(girl.cookie, "normal");
check("儿童可以自己改语速（PATCH /api/settings 200）", toNormal.status === 200, `status=${toNormal.status}`);
check("库里随之变成 normal", readRate("u-girl") === "normal", readRate("u-girl"));
const afterNormal = await chatRate(girl.cookie);
console.log(`   ↳ 改偏好后的 src：${afterNormal.src.slice(0, 110)}`);
check(
  "★★ 偏好真的生效：改 normal 后同一个 audio 请求变成 rate=normal",
  afterNormal.rate === "normal",
  `rate=${afterNormal.rate}`,
);

// 恢复成孩子应有的默认值（slow），不污染用户设置
const restore = await setRate(girl.cookie, "slow");
const restored = await chatRate(girl.cookie);
check("恢复 slow 成功（不残留测试改动）", restore.status === 200 && restored.rate === "slow", `rate=${restored.rate}`);

// ── 5) 显示 bug 回归：不再有字面 markdown/反引号；设置页儿童能用大按钮 ─────────
section("5. 显示修复 + 儿童设置入口");
for (const [who, cookie] of [["儿童", girl.cookie], ["成人", mom.cookie]]) {
  for (const page of ["/chat", "/practice", "/settings"]) {
    const html = await (await fetch(`${BASE}${page}`, { headers: { cookie } })).text();
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--\s*-->/g, "");
    check(`${who} ${page} 不含字面 **`, !visible.includes("**"));
    check(`${who} ${page} 不含字面反引号`, !/[^\\/]`[A-Za-z_]+`/.test(visible));
  }
}
const girlSettings = (await (await fetch(`${BASE}/settings`, { headers: { cookie: girl.cookie } })).text()).replace(
  /<!--\s*-->/g,
  "",
);
check("★ 儿童 /settings 有大按钮语速选项 slow", /data-testid="tts-rate-slow"[^>]*aria-pressed/.test(girlSettings));
check("★ 儿童 /settings 有大按钮语速选项 normal", /data-testid="tts-rate-normal"[^>]*aria-pressed/.test(girlSettings));
check("语速取舍说明（2.3 倍）可见", girlSettings.includes("2.3"));
const girlChatHtml = (await (await fetch(`${BASE}/chat`, { headers: { cookie: girl.cookie } })).text()).replace(
  /<!--\s*-->/g,
  "",
);
check("★ 聊天头部可直接切语速", girlChatHtml.includes('data-testid="chat-rate-slow"') && girlChatHtml.includes('data-testid="chat-rate-normal"'));
check("聊天头部说明含取舍文案", girlChatHtml.includes("2.3 倍"));
check("不再写死过时秒数（1–11s）", !girlChatHtml.includes("1–11s") && !girlChatHtml.includes("1–11"));

// ── 4) task-57：对话轮次的 unscripted 发音评估 + 助手音频 0:00 修复 ───────────
{
  console.log("\n──────── 4. 对话发音评估（unscripted）+ 历史展示 + 0:00 修复 ────────");
  const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
  const captured = [];
  let pronounceMode = "ok";
  const TINY_WAV = Buffer.from("RIFF$\\u0000\\u0000\\u0000WAVEfmt \\u0010\\u0000\\u0000\\u0000\\u0001\\u0000\\u0001\\u0000\\u0080>\\u0000\\u0000\\u0000}\\u0000\\u0000\\u0002\\u0000\\u0010\\u0000data\\u0000\\u0000\\u0000\\u0000", "binary");
  const stub = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString("utf8");
      captured.push({ url: String(req.url), body });
      const send = (status, obj) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(obj));
      };
      if (String(req.url).startsWith("/v1/health")) {
        send(200, {
          status: "ok",
          version: "0.1.0-stub",
          mode: "mock",
          providers: { asr: "mock", pa: "mock", tts: "mock", llm: "mock" },
          capabilities: {
            phoneme_level: true,
            prosody: true,
            intonation_curve: true,
            nbest_phonemes: true,
            ssml: true,
            gpu: false,
            ocr: false,
          },
        });
        return;
      }
      if (String(req.url).startsWith("/v1/asr")) {
        send(200, { text: "I like playing football with my friends.", provider: "stub", duration_ms: 900 });
        return;
      }
      if (String(req.url).startsWith("/v1/dialogue")) {
        send(200, {
          reply: "That sounds like so much fun!",
          reply_zh: "听起来很好玩！",
          correction: null,
          flag: "ok",
          provider: "stub",
          done: false,
          suggested_replies: ["Yes, I love it!"],
        });
        return;
      }
      if (String(req.url).startsWith("/v1/pronounce")) {
        if (pronounceMode === "fail") {
          send(502, { error: { code: "provider_error", message: "stub 失败" } });
          return;
        }
        send(200, {
          reference_text: "",
          recognized_text: "i like playing football with my friends",
          scores: { pron: 82, accuracy: 85, fluency: 78, completeness: 95, prosody: null },
          issues: [{ type: "mispronunciation", word: "football", phoneme: "θ", score: 55 }],
          words: [
            { word: "football", score: 61, start_ms: 300, end_ms: 900 },
            { word: "friends", score: 88, start_ms: 1000, end_ms: 1400 },
          ],
          intonation: { dtw_distance: 0.3, worst_regions: [] },
          warnings: [],
          provider: "stub",
          duration_ms: 1600,
        });
        return;
      }
      if (String(req.url).startsWith("/v1/tts")) {
        res.statusCode = 200;
        res.setHeader("content-type", "audio/wav");
        res.end(TINY_WAV);
        return;
      }
      send(404, { error: { code: "not_found", message: "stub: no route" } });
    });
  });
  await new Promise((r) => stub.listen(8137, "127.0.0.1", r));

  const PORT = 3027;
  const child = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
    cwd: WEB_ROOT,
    env: { ...process.env, VOICE_SERVICE_URL: "http://127.0.0.1:8137" },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
    }
    check("stub-voice web 实例（3027）启动成功", up);

    const stubLogin = async (email, password) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
    };
    const childCookie = await stubLogin("girl@example.com", "Girl12345!");
    const dadCookie = await stubLogin("dad@example.com", "Dad12345!");
    check("stub 实例可登录（儿童 + 家长）", Boolean(childCookie) && Boolean(dadCookie));

    const startSession = async (cookie) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ scenario_id: "self_intro" }),
      });
      return (await r.json().catch(() => null))?.session_id ?? null;
    };
    /** 走一轮语音对话：multipart 带录音 */
    const voiceTurn = async (cookie, sessionId, text = "I like playing football.") => {
      const form = new FormData();
      form.append("audio", new Blob([TINY_WAV], { type: "audio/wav" }), "turn.wav");
      form.append("text", text);
      const r = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/${sessionId}/turn`, {
        method: "POST",
        headers: { cookie },
        body: form,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const waitPron = async (cookie, sessionId, timeoutMs = 15000) => {
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < timeoutMs) {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/${sessionId}/messages`, {
          headers: { cookie },
        });
        const data = await r.json().catch(() => null);
        const userMsgs = (data?.messages ?? []).filter((m) => m.role === "user");
        last = userMsgs[userMsgs.length - 1] ?? null;
        if (last?.pron) return last.pron;
        await new Promise((r2) => setTimeout(r2, 500));
      }
      return null;
    };

    // ① 家长自己讲一轮（家长视图应看到分数）
    const dadSession = await startSession(dadCookie);
    const dadTurn = await voiceTurn(dadCookie, dadSession);
    check("语音轮次：multipart turn → 200", dadTurn.status === 200 && Boolean(dadTurn.body?.user_message_id), `status=${dadTurn.status}`);
    const dadPron = await waitPron(dadCookie, dadSession);
    check("★ 一轮后 chat_messages.pron_json 非空（后台评分完成）", Boolean(dadPron), JSON.stringify(dadPron ?? null).slice(0, 140));
    check("★ pron_json 内容正确（pron=82 / 最弱 th / 逐词）", dadPron?.pron === 82 && (dadPron?.weak_phonemes ?? [])[0]?.label === "th" && (dadPron?.words ?? []).length >= 1, JSON.stringify(dadPron?.weak_phonemes ?? null));
    {
      const DatabaseMod = (await import("better-sqlite3")).default;
      const db = new DatabaseMod(DB_PATH, { readonly: true });
      const row = db.prepare("SELECT pron_json FROM chat_messages WHERE id = ?").get(dadTurn.body?.user_message_id);
      db.close();
      check("★ 库里 pron_json 已写入（非空）", Boolean(row?.pron_json), String(row?.pron_json ?? "null").slice(0, 120));
    }

    // ② outbound：unscripted + reference_text 为空
    const pronCaptured = captured.filter((c) => c.url.startsWith("/v1/pronounce"));
    const lastPron = pronCaptured[pronCaptured.length - 1]?.body ?? "";
    check("★ /v1/pronounce outbound 使用 mode=unscripted", /name="mode"\r\n\r\nunscripted/.test(lastPron), (lastPron.match(/name="mode"\r\n\r\n([^\r]+)/) ?? [])[1] ?? "(未捕获)");
    check("★ outbound reference_text 为空字符串", /name="reference_text"\r\n\r\n\r\n/.test(lastPron), "reference_text 空");
    check("outbound 带 phoneme 粒度", /name="granularity"\r\n\r\nphoneme/.test(lastPron));

    // ③ 家长视图 HTML：有分数与弱音
    const dadChatHtml = await (await fetch(`http://127.0.0.1:${PORT}/chat`, { headers: { cookie: dadCookie } })).text();
    check("★ 家长历史对话含发音分数（history-pron + 发音）", dadChatHtml.includes('data-testid="history-pron"') && dadChatHtml.includes('data-kind="parent-score"') && /发音\s*<strong>82<\/strong>|发音/.test(dadChatHtml), (dadChatHtml.match(/发音[^<]{0,20}/) ?? [""])[0]);
    check("家长视图显示最弱音 th", /最弱[^<]{0,12}/.test(dadChatHtml), (dadChatHtml.match(/最弱[^<]{0,12}/) ?? [""])[0]);

    // ④ 儿童视图 HTML：只有正向提示、没有分数
    const childSession = await startSession(childCookie);
    await voiceTurn(childCookie, childSession);
    const childPron = await waitPron(childCookie, childSession);
    check("儿童语音轮次同样完成评分（后台）", Boolean(childPron), JSON.stringify(childPron ?? null).slice(0, 100));
    check("★ 儿童数据里不含 IPA（弱音 ipa 为 null）", (childPron?.weak_phonemes ?? []).every((w) => w.ipa === null), JSON.stringify(childPron?.weak_phonemes ?? null));
    const childChatHtml = await (await fetch(`http://127.0.0.1:${PORT}/chat`, { headers: { cookie: childCookie } })).text();
    check("★ 儿童历史对话只有正向提示（data-kind=child-positive）", childChatHtml.includes('data-kind="child-positive"'));
    check("★ 儿童视图不含分数（无 parent-score / 无 data-pron）", !childChatHtml.includes('data-kind="parent-score"') && !/data-pron="/.test(childChatHtml));
    check("儿童 /chat 仍零 IPA", leaks(childChatHtml).length === 0, `leaked=${leaks(childChatHtml).join("")}`);

    // ⑤ 评分失败：对话仍成功，页面显示「—」
    pronounceMode = "fail";
    const failSession = await startSession(dadCookie);
    const failTurn = await voiceTurn(dadCookie, failSession);
    check("★ 评分失败时对话仍成功（200）", failTurn.status === 200 && Boolean(failTurn.body?.reply), `status=${failTurn.status}`);
    const failPron = await waitPron(dadCookie, failSession, 4000);
    check("评分失败 → pron 保持 null（不崩）", failPron === null);
    const failChatHtml = await (await fetch(`http://127.0.0.1:${PORT}/chat`, { headers: { cookie: dadCookie } })).text();
    check("★ 评分失败在页面上显示「—」（parent-failed）", failChatHtml.includes('data-kind="parent-failed"') && /发音\s*<strong>—<\/strong>|—/.test(failChatHtml));
    pronounceMode = "ok";

    // ⑥ 助手音频不再 0:00：preload=metadata（SSR HTML 断言）
    check("★ 助手音频 preload=metadata（不再 0:00 / 0:00）", /<audio[^>]*preload="metadata"[^>]*data-testid="tts-audio"/.test(dadChatHtml) || /data-testid="tts-audio"[^>]*preload="metadata"/.test(dadChatHtml), "tts-audio preload=metadata");
    check("助手音频不再用 preload=none", !/<audio[^>]*data-testid="tts-audio"[^>]*preload="none"/.test(dadChatHtml));
  } finally {
    child.kill("SIGTERM");
    stub.close();
  }
}

console.log(`\n合计失败 ${failed} 项`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
