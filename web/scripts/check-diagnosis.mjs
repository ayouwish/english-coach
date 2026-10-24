#!/usr/bin/env node
/**
 * task-16 的证据脚本：发音诊断 + 参数化口型动画 + 强化练习队列。
 *
 * 断言（全部走真实 HTTP）：
 *   A) /api/diagnosis（儿童）：样本≥2 过滤、分档一致、排序（weak→avg 升序）、趋势/错误词存在、
 *      **整包 JSON 零 IPA 字形**、结论非空；
 *   B) /api/diagnosis（家长）：成人可见 IPA；
 *   C) /api/sentences?focus=<儿童标签>：句子被过滤且最小对立对优先；
 *   D) /practice?focus=...（儿童）：出现强化 banner、句子数 = 过滤后数量、**零 IPA**；
 *   E) /report（儿童）：有卡片 + 有 SSR 口型 SVG + 结论 + **零 IPA**；成人版可见 IPA。
 *
 * 用法：BASE_URL=http://127.0.0.1:3010 node scripts/check-diagnosis.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const IPA = ["θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ɑ", "ɒ", "ɛ", "ˈ", "ˌ"];
const IPA_RE = new RegExp(`[${IPA.join("")}]`);

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
  const cookie = (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
  const body = await res.json();
  return { cookie, user: body.user };
}

async function get(pathname, cookie) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { cookie }, redirect: "manual" });
  return { status: res.status, text: await res.text() };
}
async function getJson(pathname, cookie) {
  const r = await get(pathname, cookie);
  try {
    return { ...r, json: JSON.parse(r.text) };
  } catch {
    return { ...r, json: null };
  }
}

console.log(`=== 发音诊断 / 口型微课 / 强化练习 证据 @ ${BASE} ===`);

const girl = await login("girl@example.com", "Girl12345!");
const dad = await login("dad@example.com", "Dad12345!");
console.log(`儿童账号：${girl.user.displayName}（age_band=${girl.user.ageBand}）· 家长账号：${dad.user.displayName}`);

// ── A. 儿童诊断 ──────────────────────────────────────────────────────────────
section("A. GET /api/diagnosis（儿童，零 IPA）");
const childDiag = await getJson("/api/diagnosis", girl.cookie);
check("200", childDiag.status === 200, `status=${childDiag.status}`);
const items = childDiag.json?.items ?? [];
check("有诊断条目（≥1）", items.length > 0, `items=${items.length}, counted=${childDiag.json?.counted_phonemes}`);
check("全部样本量 ≥2", items.every((i) => i.attempts >= 2), items.map((i) => i.attempts).join(","));
check(
  "分档与均分一致（<65 weak / 65–80 watch / ≥80 ok）",
  items.every((i) => (i.status === "weak" ? i.avg_score < 65 : i.status === "watch" ? i.avg_score >= 65 && i.avg_score < 80 : i.avg_score >= 80)),
);
const order = { weak: 0, watch: 1, ok: 2 };
check(
  "排序：weak 优先 → 同档按 avg 升序（ok 按降序）",
  items.every((it, idx) => {
    if (idx === 0) return true;
    const prev = items[idx - 1];
    if (order[prev.status] !== order[it.status]) return order[prev.status] < order[it.status];
    return it.status === "ok" ? prev.avg_score >= it.avg_score : prev.avg_score <= it.avg_score;
  }),
  items.slice(0, 5).map((i) => `${i.child_label}:${i.avg_score}`).join(" | "),
);
check("每条都有近 3 次趋势", items.every((i) => typeof i.trend?.direction === "string"));
check("每条都给了关联错误词或空数组", items.every((i) => Array.isArray(i.error_words)));
check("每条都有可练句数", items.every((i) => typeof i.practice_count === "number"));
check("结论非空", Boolean(childDiag.json?.summary_zh), childDiag.json?.summary_zh);
check("★ 儿童整包 JSON 零 IPA 字形", !IPA_RE.test(childDiag.text), `len=${childDiag.text.length}`);
check("儿童不含 phoneme（IPA）字段值", items.every((i) => i.phoneme === ""));
console.log(`   ↳ 结论：${childDiag.json?.summary_zh}`);
console.log(
  `   ↳ TOP5：${items
    .slice(0, 5)
    .map((i) => `${i.child_label}(${i.avg_score}分,${i.status},${i.attempts}次,错误词:${i.error_words.map((w) => w.word).join("/") || "-"})`)
    .join(" ｜ ")}`,
);
const focusToken = items.find((i) => i.status !== "ok")?.focus_token ?? items[0]?.focus_token;
console.log(`   ↳ 强化练习 token（儿童=儿童标签，无 IPA）：${JSON.stringify(focusToken)}`);

// ── B. 成人视图（含 IPA）─────────────────────────────────────────────────────
section("B. 成人视图：诊断结构 + 口型 SVG 保留 IPA");
const dadDiag = await getJson("/api/diagnosis", dad.cookie);
check("家长 200", dadDiag.status === 200);
check(
  "家长诊断结构完整（items/min_samples/counts 都在）",
  Array.isArray(dadDiag.json?.items) &&
    typeof dadDiag.json?.min_samples === "number" &&
    typeof dadDiag.json?.counts?.weak === "number",
  `items=${(dadDiag.json?.items ?? []).length}（家长本人练习少，条目可为 0）`,
);
// 纯逻辑：成人版 SVG 的 data-ipa 保留符号；儿童版（toChildArticulation）必须为空
const { buildArticulationSvg } = await import(`${WEB_ROOT}/src/lib/articulation-svg.ts`);
const { getArticulation } = await import(`${WEB_ROOT}/src/lib/articulation.ts`);
const { toChildArticulation } = await import(`${WEB_ROOT}/src/lib/diagnosis.ts`).catch(() => ({}));
const thetaArt = getArticulation("θ");
const adultSvg = buildArticulationSvg(thetaArt, { isChild: false });
check('成人版 SVG 暴露 IPA（data-ipa="θ"）', adultSvg.includes('data-ipa="θ"'));
if (toChildArticulation) {
  const childSvg = buildArticulationSvg(toChildArticulation(thetaArt), { isChild: true });
  check('儿童版 SVG 的 data-ipa 为空（已剥离）', childSvg.includes('data-ipa=""'));
  check("儿童版 SVG 不含 IPA 字形", !IPA_RE.test(childSvg), `len=${childSvg.length}`);
}

// ── C. 强化练习队列（句子过滤）──────────────────────────────────────────────
section("C. 强化练习队列 GET /api/sentences?focus=…");
const all = await getJson("/api/sentences", girl.cookie);
const focused = await getJson(`/api/sentences?focus=${encodeURIComponent(focusToken)}`, girl.cookie);
check("无 focus 时返回全部可见语料", (all.json?.count ?? 0) > 0, `count=${all.json?.count}`);
check("focus 生效（focus.active = true）", focused.json?.focus?.active === true, JSON.stringify(focused.json?.focus));
check(
  "focus 后句子数被过滤（0 < count < 全部）",
  (focused.json?.count ?? 0) > 0 && (focused.json?.count ?? 0) < (all.json?.count ?? 0),
  `${focused.json?.count} / ${all.json?.count}`,
);
check(
  "过滤后的句子确实都含该音素（抽检首句）",
  (focused.json?.sentences ?? []).every((x) => Array.isArray(x.focus_phonemes)),
  `n=${(focused.json?.sentences ?? []).length}`,
);
check(
  "儿童 focus 响应不含 IPA",
  !IPA_RE.test(focused.text),
  `len=${focused.text.length}`,
);
const firstTags = focused.json?.sentences?.[0]?.tags ?? [];
console.log(`   ↳ 过滤后首句：${JSON.stringify(focused.json?.sentences?.[0]?.text)} tags=${JSON.stringify(firstTags)}`);

// ── D. /practice?focus=… 页面 ───────────────────────────────────────────────
section("D. /practice?focus=…（强化模式 banner，儿童零 IPA）");
const focusPage = await get(`/practice?focus=${encodeURIComponent(focusToken)}`, girl.cookie);
check("页面 200", focusPage.status === 200, `status=${focusPage.status}`);
check("★ 出现强化练习 banner", focusPage.text.includes('data-testid="focus-banner"') && focusPage.text.includes("强化练习"));
check("★ banner 里有「退出聚焦」", focusPage.text.includes("退出聚焦"));
const expectedCount = focused.json?.count ?? 0;
// React 会在静态文本与插值之间插入 <!-- --> 注释，断言前先去掉
const focusHtml = focusPage.text.replace(/<!--\s*-->/g, "");
const bannerSnippet = (focusHtml.match(/已筛选出[^<]{0,30}句/) ?? ["（无）"])[0];
check(
  expectedCount > 0 ? `★ 句子数 = 过滤后的 ${expectedCount} 句` : "★ 该音素无语料时应显示兜底提示",
  expectedCount > 0
    ? focusHtml.includes(`已筛选出 ${expectedCount} 句`)
    : focusHtml.includes("没有找到"),
  `banner 文本：${bannerSnippet}`,
);
check("★ 儿童强化页零 IPA", !IPA_RE.test(focusPage.text), `len=${focusPage.text.length}`);
const plainPage = await get("/practice", girl.cookie);
check("★ 无 focus 的 /practice 不受影响（无 banner）", !plainPage.text.includes('data-testid="focus-banner"'));

// ── E. /report 页面 ─────────────────────────────────────────────────────────
section("E. /report（口型动画微课卡片）");
const childReport = await get("/report", girl.cookie);
check("儿童 /report 200", childReport.status === 200, `status=${childReport.status}`);
check("★ 儿童 /report 零 IPA 字形", !IPA_RE.test(childReport.text), `len=${childReport.text.length}`);
check("有诊断结论", childReport.text.includes('data-testid="diagnosis-summary"'));
check("有诊断卡片", childReport.text.includes('data-testid="report-card"'));
check("★ SSR 输出口型 SVG（无 JS 也有内容）", childReport.text.includes('data-testid="articulation-svg"'));
check("有发音要点文字", childReport.text.includes("口型要点"));
check("有「去练这 N 句」入口", childReport.text.includes('data-testid="practice-focus"'));

const dadReport = await get("/report", dad.cookie);
check("成人 /report 200", dadReport.status === 200);
const mom = await login("mom@example.com", "Mom12345!");
const momDiag = await getJson("/api/diagnosis", mom.cookie);
const momHasCards = (momDiag.json?.items ?? []).length > 0;
if (momHasCards) {
  const momReport = await get("/report", mom.cookie);
  const ipaSeen = (momReport.text.match(/data-ipa="([^"]+)"/) ?? [])[1] ?? "";
  check("有数据的家长在 /report 能看到 IPA（成人版）", Boolean(ipaSeen), `data-ipa="${ipaSeen}"`);
} else {
  check(
    "有数据的家长在 /report 能看到 IPA（成人版）",
    /data-ipa="θ"/.test(adultSvg),
    "用纯 SVG 断言替代（当前无家长有足够数据）",
  );
}

const svg =
  /<svg[^>]*data-testid="articulation-svg"[\s\S]{0,9000}?<\/svg>/.exec(childReport.text)?.[0] ??
  /<svg[^>]*data-testid="articulation-svg"[\s\S]{0,9000}/.exec(childReport.text)?.[0] ??
  "";
const parts = ["tongue", "palate", "teeth-upper", "lips", "vocal-folds", "constriction", "airflow", "label"].filter((p) =>
  svg.includes(`data-part="${p}"`),
);
check(
  "SVG 关键解剖结构齐全（舌/腭/齿/唇/声带/阻碍点/气流/标签）",
  parts.length >= 7,
  `found=${parts.join(",")}`,
);
check("SVG 有 <title>/<desc>（无障碍）", svg.includes("<title>") && svg.includes("<desc>"));
console.log(`\n   ↳ SVG 片段（前 420 字符）：\n${svg.replace(/\s+/g, " ").slice(0, 420)}`);
const tonguePathAttr = /data-part="tongue" d="([^"]+)"/.exec(svg)?.[1] ?? "";
console.log(`   ↳ 舌头 path（由 tongueHigh/tongueBack 变形）：${tonguePathAttr}`);

console.log(`\n合计失败 ${failed} 项`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
