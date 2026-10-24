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
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
check("preload=none（不预先请求所有音频）", /preload="none"/.test(audioTag));
check("audio 带 aria-label", /aria-label="[^"]+"/.test(audioTag));
check("★ 自动朗读开关存在且带 aria-pressed", /data-testid="autoread-toggle"[^>]*aria-pressed/.test(girlChat));
check("儿童 /chat 零 IPA", !IPA_RE.test(girlChatRaw));
console.log(`   ↳ audio 标签：${audioTag.replace(/\s+/g, " ").slice(0, 300)}`);
console.log(`   ↳ audio src：${audioSrc.slice(0, 140)}`);

const momChat = (await (await fetch(`${BASE}/chat`, { headers: { cookie: mom.cookie } })).text()).replace(/&amp;/g, "&");
const momSrc = /src="(\/api\/tts\?[^"]+)"/.exec(momChat)?.[1] ?? "";
check("成人 src 带 rate=normal", momSrc.includes("rate=normal"), (momSrc.match(/rate=(\w+)/) ?? [])[1] ?? "");

// ── 3) bundle / 源码断言（录音态是客户端状态，SSR 断言不到）──────────────────
section("3. 客户端行为（bundle + 源码断言）");
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

console.log(`\n合计失败 ${failed} 项`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
