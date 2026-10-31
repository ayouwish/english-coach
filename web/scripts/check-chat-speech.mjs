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

/** 杀掉整条进程组：`next start` 是 pnpm 的子进程，只 kill pnpm 会留下孤儿占着端口，
 *  导致后续守卫静默跑到旧实例上（"假失败"）。因此 spawn 时 detached:true，这里杀进程组。 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
}


const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 守卫会连续发很多轮对话；当天免费额度常被别的自测耗尽 → 临时把这两个测试账号额度调大，进程退出恢复。
const MAIN_DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const DatabaseModLib = (await import("better-sqlite3")).default;
const __limitBackup = [];
try {
  const db = new DatabaseModLib(MAIN_DB_PATH);
  __limitBackup.push(...db.prepare("SELECT id, daily_limit_minutes FROM users WHERE id IN ('u-girl','u-dad')").all());
  db.prepare("UPDATE users SET daily_limit_minutes = 600 WHERE id IN ('u-girl','u-dad')").run();
  db.close();
} catch {
  /* 测试库不可用就算了：后面的限额断言会自己报错 */
}
process.on("exit", () => {
  try {
    const db = new DatabaseModLib(MAIN_DB_PATH);
    for (const r of __limitBackup) db.prepare("UPDATE users SET daily_limit_minutes = ? WHERE id = ?").run(r.daily_limit_minutes, r.id);
    db.close();
  } catch {
    /* 恢复失败不影响结果 */
  }
});
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
// task-68：场景按 audience 分组后，按各账号可见场景挑第一个（不再写死儿童场景 id）
const firstScenarioFor = async (cookie) => {
  const res = await fetch(`${BASE}/api/chat/scenarios`, { headers: { cookie } });
  const list = ((await res.json().catch(() => null))?.scenarios ?? []);
  return list[0]?.id ?? null;
};
const girlScenarioId = await firstScenarioFor(girl.cookie);
const momScenarioId = await firstScenarioFor(mom.cookie);
check(
  "儿童创建会话（让「最近一次对话」出现在 SSR HTML 里）",
  Boolean(girlScenarioId) && (await mk(girl.cookie, girlScenarioId)).status === 201,
  `scenario=${girlScenarioId}`,
);
check("成人创建会话", Boolean(momScenarioId) && (await mk(mom.cookie, momScenarioId)).status === 201, `scenario=${momScenarioId}`);

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
  !/<input[^>]*type="(text|search|email|url|tel|password)"/i.test(chatSrcForInput) &&
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
  // 额度在脚本顶部已临时提权（见 boostTestQuota），这里不再重复
  const captured = [];
  let pronounceMode = "ok";
  /** task-68：助手是否主动结束；TTS / concat 调用计数（验证缓存命中） */
  let dialogueDone = false;
  let ttsCalls = 0;
  let concatCalls = 0;
  /** task-72：concat 失败/延迟开关（验证 failed→force 重建、building→202、并发去重） */
  let concatMode = "ok";
  let concatDelayMs = 0;
  /** task-74 追加：TTS 503（真实失败原因） */
  let ttsMode = "ok";
  /** task-74 ②：助手返回「更自然：…」校正提示（历史对话要保留） */
  let emitCorrection = false;
  /** 合法的 24kHz/mono/16bit PCM WAV（10ms），保证 status.duration_ms 可解析 */
  const TINY_WAV = (() => {
    const sampleRate = 24000;
    const samples = 240;
    const dataSize = samples * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + dataSize, 4);
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
    buf.writeUInt32LE(dataSize, 40);
    return buf;
  })();
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
          correction: emitCorrection
            ? {
                has_error: true,
                type: "natural",
                original: "everything is going good",
                better: "everything's going well",
                explain_zh: "母语者更常说 everything's going well。",
                severity: "minor",
              }
            : null,
          flag: "ok",
          provider: "stub",
          done: dialogueDone,
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
        ttsCalls += 1;
        if (ttsMode === "503") {
          res.statusCode = 503;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "provider_error", message: "stub TTS 503" } }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "audio/wav");
        res.end(TINY_WAV);
        return;
      }
      if (String(req.url).startsWith("/v1/audio/concat")) {
        concatCalls += 1;
        const mode = concatMode;
        const delay = concatDelayMs;
        const finish = () => {
          if (mode === "404") {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { code: "not_found", message: "stub: concat 未上线" } }));
            return;
          }
          if (mode === "fail") {
            res.statusCode = 502;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { code: "provider_error", message: "stub concat 失败" } }));
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "audio/wav");
          res.end(TINY_WAV);
        };
        if (delay > 0) setTimeout(finish, delay);
        else finish();
        return;
      }
      send(404, { error: { code: "not_found", message: "stub: no route" } });
    });
  });
  await new Promise((r) => stub.listen(8137, "127.0.0.1", r));

  const PORT = 3027;
  const child = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
      detached: true,
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

    /** 起一个会话：按该账号能看到的场景里挑第一个（task-68 后儿童/成人场景已分组） */
    const startSession = async (cookie) => {
      const sc = await fetch(`http://127.0.0.1:${PORT}/api/chat/scenarios`, { headers: { cookie } });
      const list = ((await sc.json().catch(() => null))?.scenarios ?? []);
      const scenarioId = list[0]?.id ?? "self_intro";
      const r = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ scenario_id: scenarioId }),
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

    // ── task-72：整段回放异步预生成的状态/轮询工具 ──────────────────────────
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const audioUrlFor = (sessionId) => `http://127.0.0.1:${PORT}/api/chat/sessions/${sessionId}/audio`;
    const audioStatusUrlFor = (sessionId) => `${audioUrlFor(sessionId)}/status`;
    const fetchAudioStatus = async (cookie, sessionId) => {
      const r = await fetch(audioStatusUrlFor(sessionId), { headers: { cookie } });
      return { http: r.status, body: await r.json().catch(() => null) };
    };
    /** 轮询 status 直到 ready / failed（或超时），返回最后状态 + 采样序列 */
    const pollAudioStatus = async (cookie, sessionId, timeoutMs = 30000) => {
      const t0 = Date.now();
      const samples = [];
      let last = { http: 0, body: null };
      while (Date.now() - t0 < timeoutMs) {
        last = await fetchAudioStatus(cookie, sessionId);
        samples.push(last.body?.status ?? `http-${last.http}`);
        if (last.body?.status === "ready" || last.body?.status === "failed") break;
        await sleep(250);
      }
      return { ...last, elapsed_ms: Date.now() - t0, samples };
    };
    const chatAudioDir = path.join(process.env.DATA_DIR ?? path.join(WEB_ROOT, "data"), "chat-audio");

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

    // ⑦ task-68：不限轮数（10 轮不结束）
    const longSession = await startSession(childCookie);
    let lastTurn = null;
    for (let i = 1; i <= 10; i++) {
      lastTurn = await voiceTurn(childCookie, longSession, `Round ${i}: I like football.`);
    }
    check(
      "★ 10 轮后对话仍未结束（CHAT_MAX_TURNS=0 不限制）",
      lastTurn?.status === 200 && lastTurn?.body?.done === false && lastTurn?.body?.turn_index === 10,
      `turn_index=${lastTurn?.body?.turn_index} done=${lastTurn?.body?.done}`,
    );
    {
      const dbCheck = new Database(DB_PATH, { readonly: true });
      const row = dbCheck.prepare("SELECT turn_count, ended_at FROM chat_sessions WHERE id = ?").get(longSession);
      dbCheck.close();
      check("★ 库里会话仍开着（ended_at 为空、turn_count=10）", row?.turn_count === 10 && !row?.ended_at, JSON.stringify(row ?? {}));
    }
    check("页面有「结束对话」按钮（源码级，client 面板）", fs.readFileSync(path.join(WEB_ROOT, "src/app/chat/ChatClient.tsx"), "utf8").includes('data-testid="chat-end-session"'));
    const endAt = Date.now();
    const endRes = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/${longSession}/end`, {
      method: "POST",
      headers: { cookie: childCookie },
    });
    const endBody = await endRes.json().catch(() => null);
    check("★ POST /end → 200 且会话结束", endRes.status === 200 && endBody?.ok === true && endBody?.ended === true, `status=${endRes.status}`);
    check("★ /end 响应不等待整段拼接（<3s）", Date.now() - endAt < 3000, `${Date.now() - endAt}ms`);
    // task-72：/end 之后**无需点击**，轮询 status 就应该变 ready（after() 预生成）
    const endedStatus = await pollAudioStatus(childCookie, longSession, 30000);
    console.log(`   ↳ /end → status=${endedStatus.body?.status} · ${endedStatus.elapsed_ms}ms · 采样=${endedStatus.samples.slice(0, 8).join("→")}`);
    check(
      "★ /end 后无需点击：轮询 status 变 ready",
      endedStatus.body?.status === "ready",
      `status=${endedStatus.body?.status} ${endedStatus.elapsed_ms}ms samples=${endedStatus.samples.join(",")}`,
    );
    check("status.turn_count = 10（与库里一致）", endedStatus.body?.turn_count === 10, `turn_count=${endedStatus.body?.turn_count}`);
    check("status 带 duration_ms（WAV 时长）", Number(endedStatus.body?.duration_ms) > 0, `${endedStatus.body?.duration_ms}ms`);
    {
      const wavPath = path.join(chatAudioDir, `${longSession}.wav`);
      const metaPath = path.join(chatAudioDir, `${longSession}.json`);
      const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : null;
      check("★ 预生成已缓存 wav（DATA_DIR/chat-audio/<id>.wav）", fs.existsSync(wavPath) && fs.statSync(wavPath).size > 0, wavPath);
      check(
        "★ sidecar 状态文件字段齐全（status/turn_count/started_at/ready_at）",
        meta?.status === "ready" && meta?.turn_count === 10 && Boolean(meta?.started_at) && Boolean(meta?.ready_at),
        JSON.stringify(meta ?? {}).slice(0, 180),
      );
    }
    // ready → 200 读缓存；status 只读不触发构建
    {
      const concatBefore = concatCalls;
      const ttsBefore = ttsCalls;
      const cached = await fetch(audioUrlFor(longSession), { headers: { cookie: childCookie } });
      const cachedBytes = Buffer.from(await cached.arrayBuffer());
      check(
        "★ ready → GET audio 200 audio/wav（读缓存）",
        cached.status === 200 && (cached.headers.get("content-type") ?? "").includes("audio/wav") && cachedBytes.length > 0,
        `status=${cached.status} ${cachedBytes.length}B`,
      );
      check("Content-Length 正确 + Accept-Ranges: none", Number(cached.headers.get("content-length")) === cachedBytes.length && cached.headers.get("accept-ranges") === "none", `len=${cached.headers.get("content-length")} ranges=${cached.headers.get("accept-ranges")}`);
      check(
        "★ ready 命中缓存：不再调 concat / TTS",
        cached.headers.get("x-chat-audio-cache") === "hit" && concatCalls === concatBefore && ttsCalls === ttsBefore,
        `cache=${cached.headers.get("x-chat-audio-cache")} concat=${concatCalls - concatBefore} tts=${ttsCalls - ttsBefore}`,
      );
      const statusBefore = concatCalls;
      const s1 = await fetchAudioStatus(childCookie, longSession);
      const s2 = await fetchAudioStatus(childCookie, longSession);
      await sleep(400);
      check(
        "★ status 接口只读：调用前后 concat 调用次数不变",
        s1.http === 200 && s2.http === 200 && s1.body?.status === "ready" && concatCalls === statusBefore,
        `status=${s1.body?.status} concatDelta=${concatCalls - statusBefore}`,
      );
    }

    // ⑧ reply.done=true 时自然结束（不回归）+ task-72：done=true 也触发异步预生成
    dialogueDone = true;
    const doneSession = await startSession(childCookie);
    const concatBeforeDone = concatCalls;
    const doneTurn = await voiceTurn(childCookie, doneSession);
    check("★ reply.done 仍生效（助手自然结束时 done=true）", doneTurn.status === 200 && doneTurn.body?.done === true, `done=${doneTurn.body?.done}`);
    dialogueDone = false;
    const doneStatus = await pollAudioStatus(childCookie, doneSession, 30000);
    console.log(`   ↳ done=true turn → status=${doneStatus.body?.status} · ${doneStatus.elapsed_ms}ms · concatDelta=${concatCalls - concatBeforeDone}`);
    check(
      "★ turn done=true 也触发后台构建（无需再点回放）",
      doneStatus.body?.status === "ready" && concatCalls - concatBeforeDone === 1,
      `status=${doneStatus.body?.status} concatDelta=${concatCalls - concatBeforeDone}`,
    );

    // ⑨ task-72：异步预生成后的 audio 语义（building→202 / ready→200 / force / failed）
    {
      // ① 无缓存首次 GET → 202，并真的在后台构建（concat 放慢，确保能观察到 building）
      concatDelayMs = 1200;
      const buildSession = await startSession(childCookie);
      const buildTurn = await voiceTurn(childCookie, buildSession, "Building state test.");
      check("building 场景：语音轮次成功", buildTurn.status === 200, `status=${buildTurn.status}`);
      const concatBeforeBuild = concatCalls;
      const firstGet = await fetch(audioUrlFor(buildSession), { headers: { cookie: childCookie } });
      const firstGetBody = await firstGet.json().catch(() => null);
      console.log(`   ↳ 无缓存首次 GET：HTTP ${firstGet.status} · ${JSON.stringify(firstGetBody)}`);
      check(
        "★ 无缓存且未构建：GET audio → 202 {status:'building'}（不现拼）",
        firstGet.status === 202 && firstGetBody?.status === "building",
        `status=${firstGet.status} body=${JSON.stringify(firstGetBody)}`,
      );
      // 等 status 进入 building，再 GET 一次，命中 building 分支
      let sawBuilding = null;
      for (let i = 0; i < 30; i++) {
        const s = await fetchAudioStatus(childCookie, buildSession);
        if (s.body?.status === "building") {
          sawBuilding = s;
          break;
        }
        if (s.body?.status === "ready" || s.body?.status === "failed") break;
        await sleep(100);
      }
      check("status 在后台构建期间报 building", sawBuilding?.body?.status === "building", JSON.stringify(sawBuilding?.body ?? null));
      const buildingGet = await fetch(audioUrlFor(buildSession), { headers: { cookie: childCookie } });
      const buildingGetBody = await buildingGet.json().catch(() => null);
      check(
        "★ building 时 GET audio → 202（不重复构建）",
        buildingGet.status === 202 && buildingGetBody?.status === "building",
        `status=${buildingGet.status} body=${JSON.stringify(buildingGetBody)}`,
      );
      const builtStatus = await pollAudioStatus(childCookie, buildSession, 30000);
      check("构建完成 → status ready", builtStatus.body?.status === "ready", JSON.stringify(builtStatus.body ?? null));
      check("building→ready 期间只 concat 一次", concatCalls - concatBeforeBuild === 1, `concatDelta=${concatCalls - concatBeforeBuild}`);
      const readyGet = await fetch(audioUrlFor(buildSession), { headers: { cookie: childCookie } });
      const readyBytes = Buffer.from(await readyGet.arrayBuffer());
      check(
        "★ ready 后 GET audio → 200 audio/wav",
        readyGet.status === 200 && (readyGet.headers.get("content-type") ?? "").includes("audio/wav") && readyBytes.length > 0,
        `status=${readyGet.status} ${readyBytes.length}B`,
      );
      concatDelayMs = 0;
    }

    // ⑩ 并发两次触发只构建一次（concat 调用次数 = 1）
    {
      concatDelayMs = 1200;
      const raceSession = await startSession(childCookie);
      await voiceTurn(childCookie, raceSession, "Concurrency test.");
      const concatBeforeRace = concatCalls;
      const [r1, r2] = await Promise.all([
        fetch(audioUrlFor(raceSession), { headers: { cookie: childCookie } }),
        fetch(audioUrlFor(raceSession), { headers: { cookie: childCookie } }),
      ]);
      const b1 = await r1.json().catch(() => null);
      const b2 = await r2.json().catch(() => null);
      check("并发两次触发都返回 202 building", r1.status === 202 && r2.status === 202 && b1?.status === "building" && b2?.status === "building", `${r1.status}/${r2.status}`);
      const raceStatus = await pollAudioStatus(childCookie, raceSession, 30000);
      check("并发构建最终 ready", raceStatus.body?.status === "ready", JSON.stringify(raceStatus.body ?? null));
      check(
        "★ 并发两次触发只构建一次（concat 调用次数 = 1）",
        concatCalls - concatBeforeRace === 1,
        `concatDelta=${concatCalls - concatBeforeRace}`,
      );
      concatDelayMs = 0;
    }

    // ⑪ failed → 可读错误；?force=1 → 后台重建
    {
      const failSession = await startSession(childCookie);
      await voiceTurn(childCookie, failSession, "Failure test.");
      concatMode = "fail";
      const failGet = await fetch(audioUrlFor(failSession), { headers: { cookie: childCookie } });
      check("失败场景：首次 GET → 202（后台开始构建）", failGet.status === 202, `status=${failGet.status}`);
      const failStatus = await pollAudioStatus(childCookie, failSession, 30000);
      console.log(`   ↳ concat 失败后 status=${failStatus.body?.status} · error=${String(failStatus.body?.error ?? "").slice(0, 60)}`);
      check(
        "★ concat 失败 → status failed + 可读错误",
        failStatus.body?.status === "failed" && typeof failStatus.body?.error === "string" && failStatus.body.error.length > 0,
        JSON.stringify(failStatus.body ?? null),
      );
      const concatBeforeFailGet = concatCalls;
      const failedGet = await fetch(audioUrlFor(failSession), { headers: { cookie: childCookie } });
      const failedGetBody = await failedGet.json().catch(() => null);
      check(
        "★ failed 时 GET audio → 500 + 可读错误（不自动重试）",
        failedGet.status === 500 && Boolean(failedGetBody?.error?.message) && concatCalls === concatBeforeFailGet,
        `status=${failedGet.status} concatDelta=${concatCalls - concatBeforeFailGet}`,
      );
      concatMode = "ok";
      const concatBeforeForce = concatCalls;
      const forceGet = await fetch(`${audioUrlFor(failSession)}?force=1`, { headers: { cookie: childCookie } });
      const forceBody = await forceGet.json().catch(() => null);
      check("★ failed 时 ?force=1 → 202 后台重建", forceGet.status === 202 && forceBody?.status === "building" && forceBody?.forced === true, `status=${forceGet.status} body=${JSON.stringify(forceBody)}`);
      const forcedStatus = await pollAudioStatus(childCookie, failSession, 30000);
      check("force 重建后 status ready", forcedStatus.body?.status === "ready", JSON.stringify(forcedStatus.body ?? null));
      const forcedAudio = await fetch(audioUrlFor(failSession), { headers: { cookie: childCookie } });
      check("force 重建后 GET audio → 200", forcedAudio.status === 200 && (forcedAudio.headers.get("content-type") ?? "").includes("audio/wav"), `status=${forcedAudio.status}`);
      check("force 重建只 concat 一次", concatCalls - concatBeforeForce === 1, `concatDelta=${concatCalls - concatBeforeForce}`);
    }

    // ⑪-b task-74 追加：失败归因准确 + 失败 backoff（60s 内不反复重试，避免刷爆 TTS）
    {
      // A) TTS 503：错误应说「语音合成暂时不可用」，而不是甩锅 concat
      ttsMode = "503";
      const ttsSession = await startSession(childCookie);
      await voiceTurn(childCookie, ttsSession, "TTS failure test.");
      const ttsFirst = await fetch(audioUrlFor(ttsSession), { headers: { cookie: childCookie } });
      check("TTS 503 场景：首次 GET → 202", ttsFirst.status === 202, `status=${ttsFirst.status}`);
      const ttsStatus = await pollAudioStatus(childCookie, ttsSession, 30000);
      console.log(`   ↳ TTS 503 后 status=${ttsStatus.body?.status} code=${ttsStatus.body?.error_code} error=${String(ttsStatus.body?.error ?? "").slice(0, 70)}`);
      check(
        "★ TTS 503 → failed 且原因含「语音合成暂时不可用」",
        ttsStatus.body?.status === "failed" && /语音合成暂时不可用/.test(ttsStatus.body?.error ?? ""),
        String(ttsStatus.body?.error ?? "").slice(0, 90),
      );
      check("★ 错误分类 = tts_unavailable（不再误报 concat 未上线）", ttsStatus.body?.error_code === "tts_unavailable", String(ttsStatus.body?.error_code));
      check("失败文案不含「拼接服务未就绪」", !/拼接服务/.test(ttsStatus.body?.error ?? ""));
      const ttsCallsAfterFail = ttsCalls;
      const repeatGets = [];
      for (let i = 0; i < 3; i++) {
        const r = await fetch(audioUrlFor(ttsSession), { headers: { cookie: childCookie } });
        const b = await r.json().catch(() => null);
        repeatGets.push({ status: r.status, msg: b?.error?.message ?? "" });
      }
      check(
        "★ failed 后 60s 内重复 GET 不自动重试（TTS 调用次数不增加）",
        ttsCalls === ttsCallsAfterFail && repeatGets.every((g) => g.status === 500),
        `ttsDelta=${ttsCalls - ttsCallsAfterFail} statuses=${repeatGets.map((g) => g.status).join(",")}`,
      );
      check("★ 重复 GET 返回真实原因（不是笼统提示）", repeatGets.every((g) => /语音合成暂时不可用/.test(g.msg)), repeatGets[0]?.msg?.slice(0, 60) ?? "");
      check("失败后 status.auto_retry=false（需手动「重新生成」）", ttsStatus.body?.auto_retry === false, String(ttsStatus.body?.auto_retry));
      const ttsCallsBeforeForce = ttsCalls;
      const ttsForce = await fetch(`${audioUrlFor(ttsSession)}?force=1`, { headers: { cookie: childCookie } });
      check("★ 只有 ?force=1 才重试（202）", ttsForce.status === 202, `status=${ttsForce.status}`);
      await pollAudioStatus(childCookie, ttsSession, 20000);
      check("force 后确实又调用了 TTS（说明重试生效）", ttsCalls > ttsCallsBeforeForce, `ttsDelta=${ttsCalls - ttsCallsBeforeForce}`);
      ttsMode = "ok";

      // B) concat 404：文案应说「拼接服务未就绪」，与 TTS 失败不同
      concatMode = "404";
      const concatSession = await startSession(childCookie);
      await voiceTurn(childCookie, concatSession, "Concat failure test.");
      const concatFirst = await fetch(audioUrlFor(concatSession), { headers: { cookie: childCookie } });
      check("concat 404 场景：首次 GET → 202", concatFirst.status === 202, `status=${concatFirst.status}`);
      const concatStatus = await pollAudioStatus(childCookie, concatSession, 30000);
      console.log(`   ↳ concat 404 后 status=${concatStatus.body?.status} code=${concatStatus.body?.error_code} error=${String(concatStatus.body?.error ?? "").slice(0, 70)}`);
      check(
        "★ concat 404 → failed 且原因含「拼接服务未就绪」",
        concatStatus.body?.status === "failed" && /拼接服务/.test(concatStatus.body?.error ?? ""),
        String(concatStatus.body?.error ?? "").slice(0, 90),
      );
      check("★ 错误分类 = concat_unavailable", concatStatus.body?.error_code === "concat_unavailable", String(concatStatus.body?.error_code));
      check(
        "★ 两种失败文案不同（TTS vs concat 不混淆）",
        concatStatus.body?.error !== ttsStatus.body?.error && /语音合成/.test(ttsStatus.body?.error ?? "") && !/语音合成/.test(concatStatus.body?.error ?? ""),
      );
      concatMode = "ok";

      // C) UI：failed 分支显示真实原因 + 手动「重新生成」；不自动轮询重试
      const uiSrc = fs.readFileSync(path.join(WEB_ROOT, "src/components/ChatSessionAudio.tsx"), "utf8");
      check("★ UI failed 分支不再自动 schedule（轮询只查状态）", (() => {
        const failedIdx = uiSrc.indexOf('body.status === "failed"');
        const scheduleAfter = uiSrc.indexOf("schedule()", failedIdx);
        const returnAfter = uiSrc.indexOf("return;", failedIdx);
        return failedIdx >= 0 && returnAfter > failedIdx && (scheduleAfter < 0 || scheduleAfter > returnAfter);
      })());
      check("UI 显示服务端真实错误文案 + 「重新生成」按钮", uiSrc.includes("setError(body.error") && uiSrc.includes("chat-session-audio-retry"));
    }

    // ⑮ task-74 ②③④：校正保留 + 历史列表/详情 + 评价随会话保存
    {
      const dbq = (sql, ...args) => {
        const db2 = new Database(DB_PATH, { readonly: true });
        const row = db2.prepare(sql).get(...args);
        db2.close();
        return row;
      };
      // A) 校正提示：messages API 返回 + 历史详情渲染
      emitCorrection = true;
      const corrSession = await startSession(childCookie);
      const corrTurn = await voiceTurn(childCookie, corrSession, "everything is going good.");
      emitCorrection = false;
      check("助手返回校正（stub 触发）", corrTurn.body?.correction?.has_error === true, JSON.stringify(corrTurn.body?.correction ?? null).slice(0, 60));
      const msgs = await (await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/${corrSession}/messages`, { headers: { cookie: childCookie } })).json();
      const assistantMsg = [...(msgs?.messages ?? [])].reverse().find((m) => m.role === "assistant");
      check("★ messages API 返回 correction（历史可回溯）", assistantMsg?.correction?.better === "everything's going well", JSON.stringify(assistantMsg?.correction ?? null).slice(0, 80));
      const corrDetail = await (await fetch(`http://127.0.0.1:${PORT}/chat/sessions/${corrSession}`, { headers: { cookie: childCookie } })).text();
      check("★ 历史详情页渲染黄色校正块（history-correction）", corrDetail.includes('data-testid="history-correction"') && /更自然/.test(corrDetail));

      // B) 结束写评价汇总（家长视角可看分数）
      const dadSession = await startSession(dadCookie);
      await voiceTurn(dadCookie, dadSession, "Evaluation summary test.");
      // 发音评分是后台任务：先等它写回 pron_json，再 /end 才能算出 avg_pron
      for (let i = 0; i < 20; i++) {
        const m = await (await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/${dadSession}/messages`, { headers: { cookie: dadCookie } })).json();
        if ((m?.messages ?? []).some((x) => x.role === "user" && x.pron)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const dadEnd = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/${dadSession}/end`, { method: "POST", headers: { cookie: dadCookie } });
      check("/end 200", dadEnd.status === 200, `status=${dadEnd.status}`);
      const sumRow = dbq("SELECT summary_json FROM chat_sessions WHERE id = ?", dadSession);
      const sum = (() => {
        try {
          return JSON.parse(sumRow?.summary_json ?? "null");
        } catch {
          return null;
        }
      })();
      console.log(`   ↳ summary_json=${JSON.stringify(sum).slice(0, 160)}`);
      check(
        "★ 结束时写入评价汇总（avg_pron/weak_phonemes/scored_turns）",
        typeof sum?.avg_pron === "number" && Array.isArray(sum?.weak_phonemes) && typeof sum?.scored_turns === "number",
        JSON.stringify(sum ?? null).slice(0, 120),
      );
      const dadDetail = await (await fetch(`http://127.0.0.1:${PORT}/chat/sessions/${dadSession}`, { headers: { cookie: dadCookie } })).text();
      check("★ 家长详情页显示「本次平均发音」", /本次平均发音/.test(dadDetail) && dadDetail.includes('data-testid="session-summary"'));
      const girlDetailSame = await (await fetch(`http://127.0.0.1:${PORT}/chat/sessions/${dadSession}`, { headers: { cookie: childCookie } }));
      check("★ 别人（儿童）看家长会话 → 404（不越权）", girlDetailSame.status === 404, `status=${girlDetailSame.status}`);

      // C) 历史对话列表（不再只保留最后一次）
      const chatHtml = await (await fetch(`http://127.0.0.1:${PORT}/chat`, { headers: { cookie: childCookie } })).text();
      const historyItems = (chatHtml.match(/data-testid="chat-history-item"/g) ?? []).length;
      check("★ /chat 有历史对话列表（chat-history-list）", chatHtml.includes('data-testid="chat-history-list"'));
      check("★ 历史对话列表 ≥ 2 条", historyItems >= 2, `items=${historyItems}`);
      check(
        "历史列表显示「历史对话（…次）」与轮数",
        chatHtml.includes("历史对话（") && chatHtml.includes("次）") && chatHtml.includes("轮") && chatHtml.includes("chat-history-item"),
      );
      check("儿童历史列表不显示分数（只显示「聊完了」）", chatHtml.includes("聊完了") && !/平均发音/.test(chatHtml));
      const girlSessionsJson = dbq("SELECT COUNT(*) c FROM chat_sessions WHERE user_id = 'u-girl'");
      check("库里确实有多次会话（>1）", (girlSessionsJson?.c ?? 0) > 1, `count=${girlSessionsJson?.c}`);
    }

    // ⑫ 鉴权：未登录拿 status / audio 都是 401
    {
      const anonStatus = await fetch(audioStatusUrlFor(longSession));
      const anonAudio = await fetch(audioUrlFor(longSession));
      check("未登录拿 status → 401", anonStatus.status === 401, `status=${anonStatus.status}`);
      check("未登录拿整段音频 → 401", anonAudio.status === 401, `status=${anonAudio.status}`);
    }

    // ⑬ 场景按账号分（child / adult + include_child 权限）
    {
      const girlScenarios = await (await fetch(`http://127.0.0.1:${PORT}/api/chat/scenarios`, { headers: { cookie: childCookie } })).json();
      const girlList = girlScenarios.scenarios ?? [];
      check("★ 儿童账号只拿到 child 场景", girlList.length > 0 && girlList.every((x) => x.audience === "child"), `count=${girlList.length}`);
      const girlInclude = await (await fetch(`http://127.0.0.1:${PORT}/api/chat/scenarios?include_child=1`, { headers: { cookie: childCookie } })).json();
      const girlIncludeList = girlInclude.scenarios ?? [];
      check(
        "★ 儿童传 include_child=1 被忽略（仍无 adult 场景）",
        girlIncludeList.length > 0 && girlIncludeList.every((x) => x.audience === "child"),
        `count=${girlIncludeList.length} adults=${girlIncludeList.filter((x) => x.audience === "adult").length}`,
      );
      const dadScenarios = await (await fetch(`http://127.0.0.1:${PORT}/api/chat/scenarios`, { headers: { cookie: dadCookie } })).json();
      const dadList = dadScenarios.scenarios ?? [];
      check("★ 家长默认只拿到 adult 场景（8 个新场景）", dadList.length === 8 && dadList.every((x) => x.audience === "adult"), `count=${dadList.length}`);
      const dadInclude = await (await fetch(`http://127.0.0.1:${PORT}/api/chat/scenarios?include_child=1`, { headers: { cookie: dadCookie } })).json();
      const dadIncludeList = dadInclude.scenarios ?? [];
      check(
        "★ 家长 include_child=1 → adult + child（带 audience）",
        dadIncludeList.filter((x) => x.audience === "adult").length === 8 && dadIncludeList.filter((x) => x.audience === "child").length > 0 && dadIncludeList.every((x) => x.audience === "adult" || x.audience === "child"),
        `total=${dadIncludeList.length}`,
      );
      const dadChatHtml = await (await fetch(`http://127.0.0.1:${PORT}/chat`, { headers: { cookie: dadCookie } })).text();
      check("★ 成人页面有「再看小朋友的场景」开关且默认未勾选", /data-testid="chat-include-child"/.test(dadChatHtml) && !/data-testid="chat-include-child"[^>]*checked/.test(dadChatHtml), "");
      const girlChatHtml2 = await (await fetch(`http://127.0.0.1:${PORT}/chat`, { headers: { cookie: childCookie } })).text();
      check("★ 儿童页面没有该开关", !girlChatHtml2.includes('data-testid="chat-include-child"'));
    }

    // ⑭ task-70：文案不再写「最多 6 轮」+ 历史对话用户录音可回放 + health features
    {
      const chatSrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/chat/ChatClient.tsx"), "utf8");
      check("★ 源码不含「最多 6 轮」误导文案", !/最多\s*6\s*轮/.test(chatSrc));
      check("★ 源码含轮次展示「第 N 轮」", /第 \{messages\.filter\(\(m\) => m\.role === "user"\)\.length\} 轮/.test(chatSrc) || chatSrc.includes("第 {messages.filter((m) => m.role === \"user\").length} 轮"));
      const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
      check(
        "★ /api/health 暴露 features.chat_audio_replay=true",
        health?.features?.chat_audio_replay === true &&
          health?.features?.chat_unlimited_turns === true &&
          health?.features?.chat_scenarios_audience === true &&
          health?.features?.avatar_presets === true &&
          health?.features?.story_mode === true &&
          health?.features?.async_scoring === true,
        JSON.stringify(health?.features ?? {}),
      );

      // 新会话：一轮带录音 + 一轮纯文本 → 历史页只给带录音的用户消息渲染播放器。
      // 注：/chat 只渲染"最近一次对话"，若期间有并发会话创建，重试几轮以保证断言针对我们自己的会话。
      let audioMsgId = null;
      let textMsgId = null;
      let historyHtml = "";
      const audioSession = await startSession(childCookie);
      for (let attempt = 0; attempt < 3; attempt++) {
        const withAudio = await voiceTurn(childCookie, audioSession, `I have a recording ${attempt}.`);
        audioMsgId = withAudio?.body?.user_message_id ?? null;
        const textOnly = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/${audioSession}/turn`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: childCookie },
          body: JSON.stringify({ text: "This turn has no recording." }),
        }).then((r) => r.json());
        textMsgId = textOnly?.user_message_id ?? null;
        historyHtml = await (await fetch(`http://127.0.0.1:${PORT}/chat`, { headers: { cookie: childCookie } })).text();
        if (audioMsgId && historyHtml.includes(`src="/api/audio/${audioMsgId}"`)) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      check("★ 历史对话含用户录音播放器（user-audio）", historyHtml.includes('data-testid="user-audio"'));
      check(
        "★ 录音播放器 src 指向 /api/audio/<消息 id>",
        Boolean(audioMsgId) && historyHtml.includes(`src="/api/audio/${audioMsgId}"`),
        `msg=${audioMsgId}`,
      );
      check(
        "★ 无录音的用户消息不渲染播放器",
        Boolean(textMsgId) && textMsgId !== audioMsgId && !historyHtml.includes(`/api/audio/${textMsgId}`),
        `textMsg=${textMsgId}`,
      );
      if (audioMsgId) {
        const audioRes = await fetch(`http://127.0.0.1:${PORT}/api/audio/${audioMsgId}`, { headers: { cookie: childCookie } });
        check(
          "★ /api/audio/<id> 实际可播放（200 audio/*）",
          audioRes.status === 200 && (audioRes.headers.get("content-type") ?? "").startsWith("audio/"),
          `status=${audioRes.status} type=${audioRes.headers.get("content-type")}`,
        );
      }

      // task-72：ChatSessionAudio 状态轮询 UI —— 未 ready 不出现坏播放器
      const audioComp = fs.readFileSync(path.join(WEB_ROOT, "src/components/ChatSessionAudio.tsx"), "utf8");
      check("★ UI 挂载即查 status（/audio/status）", audioComp.includes("/audio/status"));
      check("★ 未 ready 每 2s 轮询（POLL_MS=2000）", /POLL_MS\s*=\s*2000/.test(audioComp) && audioComp.includes("setTimeout"));
      check(
        "★ 只有 ready 才渲染 <audio>（未 ready 无坏播放器）",
        /phase === "ready" && url \?/.test(audioComp) &&
          audioComp.indexOf('phase === "ready" && url') < audioComp.indexOf('data-testid="chat-session-audio-player"'),
      );
      check(
        "★ failed 有可读错误 + 「重新生成」（force=1）",
        audioComp.includes("重新生成") && audioComp.includes("force=1") && audioComp.includes("chat-session-audio-retry"),
      );
      check("★ 儿童文案「听一听我们的对话（正在准备…）」", audioComp.includes("听一听我们的对话（正在准备…）"));
      check("bundle 含「正在生成整段回放…（可以先看文字）」", bundle.includes("正在生成整段回放…（可以先看文字）"));
      check("源码文案带 🎧（bundle 会转义 emoji）", audioComp.includes("🎧 正在生成整段回放…（可以先看文字）"));
      check("bundle 含「重新生成」", bundle.includes("重新生成"));
      // 最新会话（audioSession）还没结束/没触发构建 → 页面 SSR 应显示“准备中”，且没有播放器
      const notReadyHtml = await (await fetch(`http://127.0.0.1:${PORT}/chat`, { headers: { cookie: childCookie } })).text();
      check("★ 最新会话未 ready：页面不出现整段回放播放器", !notReadyHtml.includes('data-testid="chat-session-audio-player"'));
      check(
        "★ 最新会话未 ready：页面显示「正在生成整段回放…（可以先看文字）」",
        notReadyHtml.includes("🎧 正在生成整段回放…（可以先看文字）"),
      );
      const notReadyStatus = await fetchAudioStatus(childCookie, audioSession);
      check("最新会话 status 仍非 ready（页面/status 都没触发构建）", notReadyStatus.body?.status !== "ready", JSON.stringify(notReadyStatus.body ?? null));
    }

    // ⑥ 助手音频不再 0:00：preload=metadata（SSR HTML 断言）
    check("★ 助手音频 preload=metadata（不再 0:00 / 0:00）", /<audio[^>]*preload="metadata"[^>]*data-testid="tts-audio"/.test(dadChatHtml) || /data-testid="tts-audio"[^>]*preload="metadata"/.test(dadChatHtml), "tts-audio preload=metadata");
    check("助手音频不再用 preload=none", !/<audio[^>]*data-testid="tts-audio"[^>]*preload="none"/.test(dadChatHtml));
  } finally {
    killTree(child);
    stub.close();
  }
}

console.log(`\n合计失败 ${failed} 项`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
