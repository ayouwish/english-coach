#!/usr/bin/env node
/**
 * task-87 验收：点单词显示音标（proxy API + WordText 组件 + 儿童策略）。
 *
 * 断言：
 *  1. GET /api/words/think → 200 ipa；未知词 → 404 ipa:null；非法/超长 → 400
 *  2. LRU 缓存：第二次同词不再调 voice；批量 ≤50、去重、缺失词 null
 *  3. 儿童默认 ipa:null（零 IPA）；家长在设置打开后儿童可拿到 IPA（显式豁免 child-ipa）
 *  4. voice 不可用 → 503 可读
 *  5. 页面 SSR 含 word-token（练习/连读/对话/故事详情/对话详情/改写预览源码）
 *  6. WordText：浮层结构、🔊 slow TTS、Esc/滚屏关闭、同一时刻只开一个
 *
 * 用法：node scripts/check-words.mjs（自起 stub voice + 独立 web 实例）
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WORDS_PORT ?? 3052);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");

let failed = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const IPA_CHARS = ["θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ɑ", "ɒ", "ɛ", "ˈ", "ˌ"];
const leaks = (t) => IPA_CHARS.filter((c) => t.includes(c));

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
}
const getJson = async (pathname, cookie) => {
  const res = await fetch(`${BASE}${pathname}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const created = [];
function cleanup() {
  const db = new Database(DB_PATH);
  for (const id of created) db.prepare("DELETE FROM reading_materials WHERE id = ?").run(id);
  db.prepare("UPDATE user_prefs SET show_word_ipa = NULL WHERE user_id IN ('u-girl','u-dad')").run();
  db.close();
}

async function main() {
  console.log(`=== 点词显示音标验收 @ ${BASE} ===`);
  const dadCookie = await login("dad@example.com", "Dad12345!");
  const girlCookie = await login("girl@example.com", "Girl12345!");
  check("登录（成人 + 儿童）", Boolean(dadCookie) && Boolean(girlCookie));

  // ① 单词 API（成人）
  const think = await getJson("/api/words/think", dadCookie);
  check("★ GET /api/words/think → 200 ipa=θɪŋk", think.status === 200 && think.json?.ipa === "θɪŋk", JSON.stringify(think.json).slice(0, 90));
  const callsAfterFirst = stubWordCalls;
  const again = await getJson("/api/words/think", dadCookie);
  check("★ LRU 缓存命中（第二次不再调用 voice）", again.status === 200 && stubWordCalls === callsAfterFirst, `voice calls delta=${stubWordCalls - callsAfterFirst}`);

  const unknown = await getJson("/api/words/zzzqqq", dadCookie);
  check("★ 未收录词 → 404 且 ipa:null", unknown.status === 404 && unknown.json?.ipa === null, `status=${unknown.status}`);
  const invalid = await getJson("/api/words/123", dadCookie);
  check("非法单词 → 400", invalid.status === 400, `status=${invalid.status}`);
  const tooLong = await getJson(`/api/words/${"a".repeat(60)}`, dadCookie);
  check("超长单词 → 400", tooLong.status === 400, `status=${tooLong.status}`);

  const batch = await getJson("/api/words?words=think,there,zzzqqq,think", dadCookie);
  check("★ 批量接口：去重且缺失词 ipa:null", batch.status === 200 && (batch.json?.words ?? []).length === 3 && (batch.json?.words ?? []).some((w) => w.word === "zzzqqq" && w.ipa === null), JSON.stringify(batch.json).slice(0, 120));
  const tooMany = await getJson(`/api/words?words=${Array.from({ length: 51 }, (_, i) => `w${i}`).join(",")}`, dadCookie);
  check("批量 >50 → 400", tooMany.status === 400, `status=${tooMany.status}`);

  // ② 儿童：task-88 起和成人一样能看到音标（去掉 ipa_disabled 门控）
  const girlDefault = await getJson("/api/words/think", girlCookie);
  check("★ 儿童默认也能拿到 IPA（不再门控）", girlDefault.status === 200 && girlDefault.json?.ipa === "θɪŋk" && !girlDefault.json?.ipa_disabled, JSON.stringify(girlDefault.json).slice(0, 90));
  const batchGirl = await getJson("/api/words?words=think,there", girlCookie);
  check("儿童批量同样返回 IPA", batchGirl.status === 200 && (batchGirl.json?.words ?? []).every((w) => typeof w.ipa === "string" && w.ipa.length > 0));
  const girlPageOn = await (await fetch(`${BASE}/practice`, { headers: { cookie: girlCookie } })).text();
  check("★ 儿童页面 SSR 仍零 IPA（音标只在点击后由 API 下发）", leaks(girlPageOn).length === 0, `leaked=${leaks(girlPageOn).join("")}`);

  // 开关关闭（所有人）：API 返回 ipa_disabled，浮层提示「音标已关闭」
  const off = await fetch(`${BASE}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: dadCookie },
    body: JSON.stringify({ show_word_ipa: false }),
  });
  const offWord = await getJson("/api/words/think", dadCookie);
  check("★ 关闭开关 → ipa:null + ipa_disabled（浮层显示「音标已关闭」）", off.status === 200 && offWord.status === 200 && offWord.json?.ipa === null && offWord.json?.ipa_disabled === true, JSON.stringify(offWord.json).slice(0, 80));
  const reset = await fetch(`${BASE}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: dadCookie },
    body: JSON.stringify({ show_word_ipa: null }),
  });
  const onAgain = await getJson("/api/words/think", dadCookie);
  check("恢复默认（开）后又能拿到 IPA", reset.status === 200 && onAgain.json?.ipa === "θɪŋk");

  // ③ voice 不可用 → 503 可读
  wordIpaMode = "503";
  const unavailable = await getJson("/api/words/banana", dadCookie);
  check("★ voice 不可用 → 503 可读提示", unavailable.status === 503 && /音标服务暂时不可用/.test(unavailable.json?.error?.message ?? ""), String(unavailable.json?.error?.message ?? "").slice(0, 60));
  wordIpaMode = "ok";

  // ④ 页面 SSR：word-token
  const practiceHtml = await (await fetch(`${BASE}/practice`, { headers: { cookie: dadCookie } })).text();
  check("★ /practice HTML 含 word-token", practiceHtml.includes('data-testid="word-token"'));
  {
    // ______________________________________
    const tokenClasses = [...practiceHtml.matchAll(/data-testid="word-token"[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    check("★ SSR：每个单词按钮 class 只有 word-token（无装饰类）", tokenClasses.length > 0 && tokenClasses.every((c) => c === "word-token"), tokenClasses.slice(0, 3).join(" | "));
    const tokenTags = [...practiceHtml.matchAll(/<span[^>]*data-testid="word-token"[^>]*>/g)].map((m) => m[0]);
    check("★ SSR：单词是 span[role=button]（不是 <button>）", tokenTags.length > 0 && tokenTags.every((t) => /role="button"/.test(t) && /tabindex="0"/.test(t)), tokenTags[0]?.slice(0, 120));
    check("SSR：页面里没有 data-testid=word-token 的 <button>", !/<button[^>]*data-testid="word-token"/.test(practiceHtml));
    check("SSR：无 &nbsp;（词间只用普通空格）", !practiceHtml.includes("&nbsp;"));
    // 用练习页里的一句真实句子做"去标签后仍是单空格"断言（词间由原文本决定）
    const dbw = new Database(DB_PATH, { readonly: true });
    const row = dbw.prepare("SELECT text FROM sentences ORDER BY sort_order LIMIT 1").get();
    dbw.close();
    const sentence = String(row?.text ?? "");
    const stripped = practiceHtml
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'");
    check("★ SSR：去标签后句子保持单空格（Hello! My name → 正常）", sentence.length > 0 && stripped.includes(sentence), sentence.slice(0, 40));
  }
  // /flow 的大字句、/chat 的消息都在「开始之后」才出现（client 阶段），SSR 里没有；
  // 用源码级断言 + 对话详情页 SSR 已经覆盖真实渲染。
  const flowSrcWords = fs.readFileSync(path.join(WEB_ROOT, "src/app/flow/FlowClient.tsx"), "utf8");
  check("★ /flow 大字句用 WordText（客户端阶段）", /<WordText text=\{item\.text\}/.test(flowSrcWords));
  const chatSrcWords = fs.readFileSync(path.join(WEB_ROOT, "src/app/chat/ChatClient.tsx"), "utf8");
  check("★ /chat 消息用 WordText（客户端阶段）", /<WordText text=\{m\.text\}/.test(chatSrcWords));
  const mk = await fetch(`${BASE}/api/materials`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: girlCookie },
    body: JSON.stringify({ title: `Words Story ${Date.now()}`, text: "I think this is thin. The weather is good.", kind: "story", level: "A2", source: "text" }),
  });
  const mat = await mk.json().catch(() => null);
  if (mat?.id) created.push(mat.id);
  const storyDetail = await (await fetch(`${BASE}/story/${mat?.id}`, { headers: { cookie: dadCookie } })).text();
  check("★ /story/[id] HTML 含 word-token", storyDetail.includes('data-testid="word-token"'));
  const storySrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/story/StoryClient.tsx"), "utf8");
  check("故事页（改写预览组件在 client）源码含 story-preview-words", storySrc.includes('data-testid="story-preview-words"'));

  // 对话详情（服务端渲染）也接入了 WordText
  const sessionStart = await fetch(`${BASE}/api/chat/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: dadCookie },
    body: JSON.stringify({ scenario_id: "adult_coffee_order" }),
  });
  const sess = await sessionStart.json().catch(() => null);
  if (sess?.session_id) {
    await fetch(`${BASE}/api/chat/sessions/${sess.session_id}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: dadCookie },
      body: JSON.stringify({ text: "A flat white, please." }),
    });
    const detail = await (await fetch(`${BASE}/chat/sessions/${sess.session_id}`, { headers: { cookie: dadCookie } })).text();
    check("★ 对话历史详情 HTML 含 word-token", detail.includes('data-testid="word-token"'));
    const childDetail = await (await fetch(`${BASE}/chat/sessions/${sess.session_id}`, { headers: { cookie: girlCookie } })).text();
    check("对话详情儿童/他人不泄漏（404 或零 IPA）", childDetail.includes("404") || leaks(childDetail).length === 0);
  }

  // ⑤ WordText 组件结构 / 长按交互 / 排版（task-94 源码级）
  const wt = fs.readFileSync(path.join(WEB_ROOT, "src/components/WordText.tsx"), "utf8");
  const css = fs.readFileSync(path.join(WEB_ROOT, "src/app/globals.css"), "utf8");
  check("★ WordText 词元是 span[role=button]（不是 <button>，免疫扩展注入）", /<span[\s\S]{0,400}?role="button"[\s\S]{0,400}?data-testid="word-token"/.test(wt) && !/<button[\s\S]{0,200}?data-testid="word-token"/.test(wt));
  check("★ 浮层只含音标（无关闭图标 / 无 🔊 / 无 TTS 残留）", wt.includes('data-testid="word-ipa-popover"') && !wt.includes('word-ipa-close') && !/✕|🔊|听发音|\/api\/tts|new Audio/.test(wt), (wt.match(/✕|🔊|听发音|\/api\/tts|new Audio/) ?? [""])[0]);
  const popoverPart = wt.slice(wt.indexOf('data-testid="word-ipa-popover"'));
  check("浮层里没有任何按钮（关闭靠再长按/点空白/Esc/滚轮）", !popoverPart.includes("<button"));
  check("★ 单词按钮无装饰类（无 underline/decoration/px-/text-left）", wt.includes('className="word-token"') && !/underline|decoration-dotted|px-0\.5|text-left/.test(wt));
  check(
    "★ globals.css !important 归零（padding/margin/border/background/display）+ 继承文字度量",
    /\.word-token\s*\{[\s\S]{0,900}?padding:\s*0\s*!important;/.test(css) &&
      /\.word-token\s*\{[\s\S]{0,900}?margin:\s*0\s*!important;/.test(css) &&
      /\.word-token\s*\{[\s\S]{0,900}?border:\s*0\s*!important;/.test(css) &&
      /\.word-token\s*\{[\s\S]{0,900}?background:\s*transparent\s*!important;/.test(css) &&
      /\.word-token\s*\{[\s\S]{0,900}?display:\s*inline\s*!important;/.test(css) &&
      /\.word-token\s*\{[\s\S]{0,900}?letter-spacing:\s*inherit;/.test(css),
  );
  check("★ 长按 450ms 触发（普通点击不打开）", wt.includes("LONG_PRESS_MS = 450") && wt.includes("setTimeout(") && !/onClick=\{\(\) => void openFor/.test(wt) && wt.includes("onPointerDown"));
  check("★ 位移 >8px / pointerup / pointercancel 取消长按", wt.includes("MOVE_CANCEL_PX = 8") && wt.includes("onPointerMove") && wt.includes("onPointerUp") && wt.includes("onPointerCancel"));
  check("★ 浮层优先在单词正下方（rect.bottom + 6，下方不够翻上方）", wt.includes("rect.bottom + 6") && /fitsBelow/.test(wt) && /placement:\s*"above"/.test(wt));
  check("窄屏（<480px）用底部 sheet", wt.includes("NARROW_SHEET_PX = 480") && wt.includes("sheet"));
  check("★ 键盘可访问（Enter/Space 打开）", /e\.key === "Enter"/.test(wt) && /e\.key === " "/.test(wt));
  check("★ 无音标显示「暂无音标」；开关关闭显示「音标已关闭」", wt.includes("暂无音标") && wt.includes("音标已关闭") && wt.includes('data-testid="word-ipa-off"'));
  check("★ 再长按同词关闭（openFor 里 toggle）", /openWord === word[\s\S]{0,80}close\(\)/.test(wt));
  check("关闭方式：点空白 / Esc / 滚轮 / 滚屏", wt.includes('e.key === "Escape"') && wt.includes('"wheel"') && wt.includes('"scroll"') && wt.includes('"pointerdown"'));
  check("保留标点空格（tokenize 只切单词）", wt.includes("isWord") && /slice\(last, match.index\)/.test(wt));

  // ⑥ 设置页有开关
  const settingsHtml = await (await fetch(`${BASE}/settings`, { headers: { cookie: dadCookie } })).text();
  check("★ 设置页有「单词显示音标」开关", settingsHtml.includes('data-testid="word-ipa-toggle"') && /单词显示音标/.test(settingsHtml));
  const girlSettings = await (await fetch(`${BASE}/settings`, { headers: { cookie: girlCookie } })).text();
  check("儿童设置页也有开关（家长可为孩子打开）", girlSettings.includes('data-testid="word-ipa-toggle"'));
}

// ── stub voice ────────────────────────────────────────────────────────────────
let stubWordCalls = 0;
let wordIpaMode = "ok";
const TINY_WAV = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64");
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), "http://x");
  const send = (status, obj) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === "/v1/health") {
    send(200, { status: "ok", version: "stub", mode: "mock", providers: {}, capabilities: { phoneme_level: true, word_ipa: true } });
    return;
  }
  if (url.pathname === "/v1/words/ipa") {
    stubWordCalls += 1;
    if (wordIpaMode === "503") {
      send(503, { error: { code: "provider_unavailable", message: "stub 音标不可用" } });
      return;
    }
    const word = (url.searchParams.get("word") ?? "").toLowerCase();
    const dict = { think: "θɪŋk", there: "ðɛr", thin: "θɪn", weather: "ˈwɛðɚ", good: "ɡʊd", a: "ə", "flat": "flæt", white: "waɪt" };
    if (dict[word]) {
      send(200, { word, ipa: dict[word], variants: [], source: "cmudict", syllables: 1 });
      return;
    }
    send(404, { error: { code: "not_found", message: "not in dictionary" } });
    return;
  }
  if (url.pathname === "/v1/tts") {
    res.statusCode = 200;
    res.setHeader("content-type", "audio/wav");
    res.end(TINY_WAV);
    return;
  }
  send(404, { error: { code: "not_found", message: "stub: no route" } });
});

try {
  await new Promise((r) => stub.listen(8141, "127.0.0.1", r));
  const child = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
    detached: true,
    cwd: WEB_ROOT,
    env: { ...process.env, VOICE_SERVICE_URL: "http://127.0.0.1:8141" },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* retry */
      }
    }
    check("stub-voice web 实例启动成功（3052）", up);
    if (up) await main();
    else failed += 1;
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
} catch (err) {
  failed += 1;
  console.error("守卫崩溃：", err);
} finally {
  stub.close();
  cleanup();
  console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
  process.exit(failed > 0 ? 1 : 0);
}
