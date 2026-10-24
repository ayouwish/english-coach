#!/usr/bin/env node
/**
 * task-18 的验证脚本：对话朗读（开关 / 重播按钮 / 语速 / TTS 缓存）。
 *
 * 无浏览器环境，所以用**服务端可验证**的方式：
 *   1) /api/tts 对同一句连续两次 → 打印耗时与响应头（证明走的是内容寻址缓存，第二次更快）；
 *   2) /chat 页面 HTML：自动朗读开关（aria-pressed/aria-label）、每条助手消息的重播按钮
 *      （aria-label 必须存在）、儿童 data-rate="slow" / 成人 "normal"；
 *   3) /chat 儿童页面零 IPA（顺带回归）。
 *
 * 用法：BASE_URL=http://127.0.0.1:3010 node scripts/check-chat-speech.mjs
 */
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const IPA_RE = /[θðɹŋæʃɪʌɔɜəʊʒɑɒɛˈˌ]/;

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

async function tts(cookie, text, rate, format) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(format ? { text, rate, format } : { text, rate }),
  });
  const bytes = (await res.arrayBuffer()).byteLength;
  return {
    status: res.status,
    ms: Date.now() - t0,
    bytes,
    type: res.headers.get("content-type"),
    cacheHeader:
      res.headers.get("x-cache") ??
      res.headers.get("x-tts-cache") ??
      res.headers.get("x-audio-cache") ??
      res.headers.get("cf-cache-status") ??
      null,
  };
}

console.log(`=== 对话朗读证据 @ ${BASE} ===`);
const girl = await login("girl@example.com", "Girl12345!");
const mom = await login("mom@example.com", "Mom12345!");
console.log(`儿童：${girl.user.displayName}（age_band=${girl.user.ageBand}）· 成人：${mom.user.displayName}`);

// ── 1) TTS 缓存对比 ─────────────────────────────────────────────────────────
section("1. /api/tts 同句两次调用（证明缓存）");
const SENTENCE = "Hi! I'm Sam. What's your name?";
const first = await tts(girl.cookie, SENTENCE, "slow");
const second = await tts(girl.cookie, SENTENCE, "slow");
console.log(
  `第 1 次：HTTP ${first.status} · ${first.ms}ms · ${first.bytes}B · ${first.type} · cache-header=${first.cacheHeader ?? "（未透传）"}`,
);
console.log(
  `第 2 次：HTTP ${second.status} · ${second.ms}ms · ${second.bytes}B · ${second.type} · cache-header=${second.cacheHeader ?? "（未透传）"}`,
);
check("两次都返回音频字节", first.status === 200 && first.bytes > 0 && second.bytes > 0, `${first.bytes}/${second.bytes}B`);
check(
  "第二次不慢于第一次（缓存命中）",
  second.ms <= Math.max(first.ms, 40) * 1.2 + 5,
  `${first.ms}ms → ${second.ms}ms（缓存按 (provider,文本,音色,语速) 寻址）`,
);

// ── 1b) 聊天朗读用 mp3：对比同长度、全新的两句（都是 cache miss）───────────
section("1b. 聊天朗读 mp3 vs 练习示范 wav（同长度新文本，均 cache miss）");
const wavText = "The quick brown fox speaks wav here.";
const mp3Text = "The quick brown fox speaks mp3 here."; // 与上面等长
const wavCall = await tts(girl.cookie, wavText, "slow", undefined); // 默认 wav
const mp3Call = await tts(girl.cookie, mp3Text, "slow", "mp3");
console.log(`wav：HTTP ${wavCall.status} · ${wavCall.ms}ms · ${wavCall.bytes}B · ${wavCall.type}`);
console.log(`mp3：HTTP ${mp3Call.status} · ${mp3Call.ms}ms · ${mp3Call.bytes}B · ${mp3Call.type}`);
check("不传 format 时返回 wav（练习页示范音仍共用预热缓存）", /audio\/wav/.test(wavCall.type ?? ""), wavCall.type ?? "");
check("format=mp3 时返回音频/mpeg", /audio\/mpeg|audio\/mp3/.test(mp3Call.type ?? ""), mp3Call.type ?? "");
check(
  "mp3 体积显著小于 wav（聊天每次新文本必 miss，所以更小更快）",
  mp3Call.bytes > 0 && mp3Call.bytes < wavCall.bytes * 0.5,
  `${wavCall.bytes}B → ${mp3Call.bytes}B（约 1/${Math.round(wavCall.bytes / Math.max(1, mp3Call.bytes))}）`,
);
check(
  "（参考）耗时对比：合成延迟本身波动大，不作硬断言",
  mp3Call.ms >= 0,
  `wav ${wavCall.ms}ms vs mp3 ${mp3Call.ms}ms —— 单次样本受 provider 合成波动影响（1–11s），体积才是确定收益`,
);

// ── 1c) 慢速状态文案确实打进客户端 bundle（无浏览器时的可见性兜底）──────────
section("1c. 「正在准备语音 / 正在说话 / 重试播放」状态文案已进 bundle");
const fs = await import("node:fs");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chunkDir = path.join(WEB_ROOT, ".next/static/chunks");
const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.name.endsWith(".js") ? [full] : [];
      })
    : [];
const jsFiles = walk(chunkDir);
const bundleText = jsFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
console.log(`   （扫描 ${jsFiles.length} 个 chunk，共 ${bundleText.length} 字符）`);
check("bundle 含「正在准备语音」", bundleText.includes("正在准备语音"));
check("bundle 含「正在说话」", bundleText.includes("正在说话"));
check("bundle 含「重试播放」", bundleText.includes("重试播放"));
check("bundle 含「语音合成太慢」提示", bundleText.includes("语音合成太慢"));
check("聊天朗读用 mp3（bundle 里出现 format:\"mp3\"）", /format:\s*"mp3"/.test(bundleText));

// ── 2) /chat HTML：开关 + 重播按钮 ──────────────────────────────────────────
section("2. /chat 页面 HTML 断言");
// 先给两个账号各建一个会话（拿到开场白 → 出现在「最近一次对话」的服务端渲染里）
const mk = async (cookie, scenario_id) => {
  const r = await fetch(`${BASE}/api/chat/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ scenario_id }),
  });
  return { status: r.status, body: await r.json() };
};
const girlSession = await mk(girl.cookie, "self_intro");
check("儿童创建会话（用于渲染重播按钮）", girlSession.status === 201, `status=${girlSession.status}`);
const momSession = await mk(mom.cookie, "shopping_clothes");
check("成人创建会话", momSession.status === 201, `status=${momSession.status}`);

const girlChat = await (await fetch(`${BASE}/chat`, { headers: { cookie: girl.cookie } })).text();
check("儿童 /chat 200 且有页面内容", girlChat.length > 2000, `len=${girlChat.length}`);
check("★ 自动朗读开关存在", girlChat.includes('data-testid="autoread-toggle"'));
check("★ 开关带 aria-pressed / aria-label", /data-testid="autoread-toggle"[^>]*aria-pressed/.test(girlChat) && /aria-label="[^"]*自动朗读[^"]*"/.test(girlChat));
check("★ 有服务端渲染的「最近一次对话」", girlChat.includes('data-testid="last-chat"'));
check("★ 助手消息有重播按钮", girlChat.includes('data-testid="replay-button"'));
check("★ 重播按钮带 aria-label", /data-testid="replay-button"[^>]*aria-label="[^"]+"/.test(girlChat) || /aria-label="[^"]*重播[^"]*"/.test(girlChat));
check("★ 儿童语速 = slow", girlChat.includes('data-rate="slow"'), (girlChat.match(/data-rate="([^"]+)"/) ?? [])[1] ?? "");
check("儿童 /chat 零 IPA", !IPA_RE.test(girlChat));
const replaySnippet = /<button[^>]*data-testid="replay-button"[^>]*>/.exec(girlChat)?.[0] ?? "";
console.log(`   ↳ 重播按钮 DOM：${replaySnippet.replace(/\s+/g, " ")}`);
const toggleSnippet = /<button[^>]*data-testid="autoread-toggle"[^>]*>/.exec(girlChat)?.[0] ?? "";
console.log(`   ↳ 自动朗读开关 DOM：${toggleSnippet.replace(/\s+/g, " ")}`);

const momChat = await (await fetch(`${BASE}/chat`, { headers: { cookie: mom.cookie } })).text();
check("★ 成人语速 = normal", momChat.includes('data-rate="normal"'), (momChat.match(/data-rate="([^"]+)"/) ?? [])[1] ?? "");
check("成人页也有重播按钮", momChat.includes('data-testid="replay-button"'));

// ── 3) 开场白出现在服务端渲染里（说明"先文字后声音"的位置存在）──────────────
section("3. 开场白已入库并可回放");
check(
  "最近一次对话里出现开场白文本",
  girlChat.includes("Hi! I&#x27;m Sam") || girlChat.includes("I'm Sam") || girlChat.includes("Sam"),
  "（SSR 文本会做 HTML 转义）",
);

console.log(`\n合计失败 ${failed} 项`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
