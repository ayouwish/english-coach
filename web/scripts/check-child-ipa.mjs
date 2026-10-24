#!/usr/bin/env node
/**
 * 儿童 IPA 泄漏守卫（task-11）—— **整体序列化后扫描**，不逐字段检查。
 *
 * 为什么这么做：IPA 会从任何没被检查的序列化路径漏出去。历史三连：
 *   `srs_cards.id` → `hint_key` → `demo_text`。逐字段断言只能挡住已知字段，
 *   所以这里把儿童账号能拿到的**整个响应体/整页 HTML（含 RSC flight 负载）**转成字符串，
 *   扫全部 18 个特征字形，命中即失败；同时兼容 `\u0251` 这类转义写法。
 *
 * 覆盖（task-11 要求）：
 *   API：/api/review、/api/attempts、/api/blind-tests、/api/parent/summary（应 403）
 *   页面：/practice、/review、/、/blindtest、/blindtest/report（额外：/chat、/settings）
 *
 * 用法：BASE_URL=http://127.0.0.1:3010 node scripts/check-child-ipa.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const CHILD_EMAIL = process.env.CHILD_EMAIL ?? "girl@example.com";
const CHILD_PASSWORD = process.env.CHILD_PASSWORD ?? "Girl12345!";

const { glyphs } = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "src/lib/child-safe.json"), "utf8"));
const GLYPH_SET = new Set(glyphs);
const LITERAL_RE = new RegExp(`[${glyphs.map((g) => g.replace(/[\\\]^/-]/g, "\\$&")).join("")}]`, "g");
// \u0251 / \\u0251 两种转义写法（RSC flight 负载里可能被转义）
const ESCAPES = glyphs.map((g) => "\\u" + g.codePointAt(0).toString(16).padStart(4, "0").toLowerCase());

let failed = 0;
const rows = [];

/** 扫描一段文本，返回命中的字形/转义写法 */
function scan(text, label) {
  const hits = new Set();
  for (const m of text.matchAll(LITERAL_RE)) hits.add(m[0]);
  const lower = text.toLowerCase();
  for (const esc of ESCAPES) {
    if (lower.includes(esc)) hits.add(esc);
  }
  const ok = hits.size === 0;
  if (!ok) failed += 1;
  rows.push({ label, ok, hits: [...hits].join(" "), bytes: text.length });
  console.log(`${ok ? "✅" : "❌"} ${label.padEnd(34)} ${ok ? "干净" : `命中 → ${[...hits].join(" ")}`} (${text.length} 字符)`);
  return ok;
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: CHILD_EMAIL, password: CHILD_PASSWORD }),
  });
  if (!res.ok) throw new Error(`儿童账号登录失败：${res.status}`);
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cookie = (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
  const body = await res.json();
  console.log(
    `以儿童账号登录：${body.user.displayName}（role=${body.user.role}, age_band=${body.user.ageBand}）\n`,
  );
  return cookie;
}

async function checkApi(cookie, pathname, { expectStatus = 200, extra } = {}) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { cookie } });
  const text = await res.text();
  if (res.status !== expectStatus) {
    failed += 1;
    rows.push({ label: pathname, ok: false, hits: `HTTP ${res.status}`, bytes: text.length });
    console.log(`❌ ${pathname.padEnd(34)} 期望 HTTP ${expectStatus}，实际 ${res.status}`);
    return null;
  }
  const suffix = expectStatus === 200 ? "" : `（HTTP ${expectStatus}，符合预期）`;
  scan(text, `${pathname}${suffix}`);
  // 再扫一遍"解析后重新序列化"的形态（覆盖 JSON 解码后的字形）
  try {
    const parsed = JSON.parse(text);
    const reserialized = JSON.stringify(parsed);
    if (reserialized !== text) scan(reserialized, `${pathname} (re-serialized)`);
    if (extra) extra(parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function checkPage(cookie, pathname) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { cookie }, redirect: "manual" });
  const html = await res.text();
  if (res.status !== 200) {
    failed += 1;
    rows.push({ label: pathname, ok: false, hits: `HTTP ${res.status}`, bytes: html.length });
    console.log(`❌ ${pathname.padEnd(34)} 期望 200，实际 ${res.status}`);
    return;
  }
  scan(html, `页面 ${pathname}（含 RSC 负载）`);
}

console.log(`=== 儿童 IPA 泄漏守卫（整体序列化扫描 ${glyphs.length} 个特征字形）===`);
console.log(`BASE=${BASE}\n`);

const cookie = await login();

console.log("── API 响应 ──");
const reviewBody = await checkApi(cookie, "/api/review", {
  extra: (parsed) => {
    const cards = parsed.due_cards ?? [];
    const demoTexts = cards.map((c) => JSON.stringify(c.demo_text));
    console.log(
      `   ↳ /api/review 里 ${cards.length} 张卡片的 demo_text 实际值：${
        demoTexts.length ? demoTexts.join(", ") : "（无卡片）"
      }`,
    );
    const phonemeCards = cards.filter((c) => c.is_phoneme);
    console.log(
      `   ↳ 其中音素卡片 ${phonemeCards.length} 张；ref/phoneme 是否为空：` +
        phonemeCards.map((c) => `${JSON.stringify(c.ref)}/${JSON.stringify(c.phoneme)}`).join(", "),
    );
    const empties = cards.filter((c) => !String(c.label ?? "").trim() || !String(c.how_zh ?? "").trim());
    console.log(`   ↳ 主体文案为空的卡片：${empties.length} 张（应为 0）`);
    if (empties.length > 0) failed += 1;
  },
});
await checkApi(cookie, "/api/attempts?limit=50");
await checkApi(cookie, "/api/blind-tests");
await checkApi(cookie, "/api/parent/summary", { expectStatus: 403 });

console.log("\n── 页面 HTML（含 RSC flight 负载）──");
for (const p of ["/practice", "/review", "/", "/blindtest", "/blindtest/report"]) {
  await checkPage(cookie, p);
}
console.log("\n── 额外覆盖（同样对儿童可访问）──");
for (const p of ["/chat", "/settings"]) {
  await checkPage(cookie, p);
}

console.log(`\n合计 ${rows.length} 项，命中 ${rows.filter((r) => !r.ok).length} 项。`);
if (reviewBody) {
  const badDemo = (reviewBody.due_cards ?? []).filter((c) => GLYPH_SET.has(String(c.demo_text ?? "")));
  console.log(`demo_text 直接等于音素符号的卡片：${badDemo.length} 张（应为 0）`);
  if (badDemo.length > 0) failed += 1;
}
console.log(failed === 0 ? "\n结论：儿童可见载荷全部干净 ✅" : `\n结论：发现 ${failed} 处 IPA 泄漏 ❌`);
process.exit(failed > 0 ? 1 : 0);
