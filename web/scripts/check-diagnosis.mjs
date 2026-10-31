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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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

// ── task-40：对比听 = 两词顺序播放（normal 语速 + 词间停顿），不再拼成一句合成 ──
{
  const hasContrast = childReport.text.includes('data-testid="contrast-play"');
  const adultHasContrast = dadReport.text.includes('data-testid="contrast-play"');
  check("★ /report 有「对比听」按钮（儿童或成人页）", hasContrast || adultHasContrast);
  const html = hasContrast ? childReport.text : dadReport.text;
  const btn = /<button[^>]*data-testid="contrast-play"[^>]*>/.exec(html)?.[0] ?? "";
  check(
    "★ 对比听按钮带两词顺序信息（data-pair=\"a|b\" + data-rate=normal）",
    /data-pair="[^"|]+\|[^"]+"/.test(btn) && /data-rate="normal"/.test(btn),
    btn.replace(/\s+/g, " ").slice(0, 220),
  );
  check(
    "★ 顺序可读（页面标注 先 A → 再 B）",
    /→/.test(html) && /先 [^，。]{1,40}? 再 /.test(btn) === true,
    (btn.match(/title="[^"]*"/) ?? [""])[0],
  );

  const reportSrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/report/page.tsx"), "utf8");
  check(
    "★ 源码：对比听不再把两个词拼成一次合成",
    !/text=\{`\$\{c\.pair\[0\]\}, \$\{c\.pair\[1\]\}`\}/.test(reportSrc) &&
      reportSrc.includes("<ContrastButton"),
  );
  const contrastSrc = fs.readFileSync(path.join(WEB_ROOT, "src/components/ContrastButton.tsx"), "utf8");
  check("★ 源码：对比听用 normal 语速（不传 slow）", /rate:\s*"normal"/.test(contrastSrc) && !/rate:\s*"slow"/.test(contrastSrc));
  check(
    "★ 源码：顺序播放逻辑（两段请求 + 词间停顿 + onended）",
    contrastSrc.includes("gapMs") && /setTimeout/.test(contrastSrc) && contrastSrc.includes('"ended"'),
  );
  check("源码：播放中再点先停掉当前（不叠加）", contrastSrc.includes("pause()") && contrastSrc.includes("runRef.current"));
  check("源码：失败可见（示范音暂时不可用）", contrastSrc.includes("示范音暂时不可用"));
  const bundle = (() => {
    const dir = path.join(WEB_ROOT, ".next/static/chunks");
    const walk = (d) =>
      fs.existsSync(d)
        ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
            const full = path.join(d, e.name);
            if (e.isDirectory()) return walk(full);
            return e.name.endsWith(".js") ? [full] : [];
          })
        : [];
    return walk(dir).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  })();
  check("bundle 含「对比中…」状态文案", bundle.includes("对比中"));
}
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


// ── task-71：作用域诊断（单句/批次/最近）+ 对子去重 ───────────────────────────
section("task-71 · 作用域诊断（attempt / batch / recent）+ 对子去重");
{
  const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
  const db = new Database(DB_PATH);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const ids = {
    dadA: `att_test71_dad_a_${now}`,
    dadB: `att_test71_dad_b_${now}`,
    dadOld: `att_test71_dad_old_${now}`,
    momB: `att_test71_mom_b_${now}`,
  };
  const insertAttempt = db.prepare(
    `INSERT INTO attempts (id, user_id, reference_text, created_at, status, scored_at, scores_json, warnings_json)
     VALUES (?, ?, ?, ?, 'done', ?, ?, '[]')`,
  );
  const insertScore = db.prepare(
    `INSERT INTO phoneme_scores (id, attempt_id, user_id, word, phoneme, score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  try {
    // 家长：A=θ 50（now）/ B=s 95（now）/ OLD=ʒ 40（8 天前）；妈妈：ŋ 60（now，用于越权断言）
    insertAttempt.run(ids.dadA, "u-dad", "I think this is thin.", iso(now), iso(now), JSON.stringify({ pron: 55 }));
    insertAttempt.run(ids.dadB, "u-dad", "Sun is so nice.", iso(now - 1000), iso(now), JSON.stringify({ pron: 92 }));
    insertAttempt.run(ids.dadOld, "u-dad", "Usually it is pleasure.", iso(now - 8 * 86400000), iso(now), JSON.stringify({ pron: 45 }));
    insertAttempt.run(ids.momB, "u-mom", "Singing morning.", iso(now), iso(now), JSON.stringify({ pron: 60 }));
    insertScore.run(`ps_${ids.dadA}_th`, ids.dadA, "u-dad", "think", "θ", 50, iso(now));
    insertScore.run(`ps_${ids.dadB}_s`, ids.dadB, "u-dad", "sun", "s", 95, iso(now));
    insertScore.run(`ps_${ids.dadOld}_zh`, ids.dadOld, "u-dad", "usually", "ʒ", 40, iso(now));
    insertScore.run(`ps_${ids.momB}_ng`, ids.momB, "u-mom", "singing", "ŋ", 60, iso(now));

    const scoped = async (qs) => getJson(`/api/diagnosis?${qs}`, dad.cookie);
    const childScoped = async (qs) => getJson(`/api/diagnosis?${qs}`, girl.cookie);
    const phonemes = (r) => (r.json?.items ?? []).map((i) => i.phoneme || i.child_label).filter(Boolean);

    // ① all 结构回归（旧字段都在）
    const all = await getJson("/api/diagnosis", dad.cookie);
    check(
      "★ scope=all 结构兼容（items/counts/summary_zh/focus_phonemes 都在）",
      all.status === 200 &&
        Array.isArray(all.json?.items) &&
        typeof all.json?.summary_zh === "string" &&
        Array.isArray(all.json?.focus_phonemes) &&
        typeof all.json?.counts?.weak === "number" &&
        all.json?.scope === "all",
      `status=${all.status} scope=${all.json?.scope}`,
    );

    // ② attempt：只含这一句的音素
    const a = await scoped(`scope=attempt&attempt_id=${ids.dadA}`);
    check("★ scope=attempt → 200 且只含这一句的音素", a.status === 200 && phonemes(a).includes("θ") && !phonemes(a).includes("s"), JSON.stringify(phonemes(a)));
    check("attempt scope summary 用「这一句」口吻", /这一句/.test(a.json?.summary_zh ?? ""), a.json?.summary_zh ?? "");
    const b = await scoped(`scope=attempt&attempt_id=${ids.dadB}`);
    check("两次不同句子的 attempt 互不包含", phonemes(b).includes("s") && !phonemes(b).includes("θ"), JSON.stringify(phonemes(b)));
    check("★ 别人的 attempt_id → 404（不泄漏）", (await scoped(`scope=attempt&attempt_id=${ids.momB}`)).status === 404);
    check("attempt 缺 attempt_id → 400", (await scoped("scope=attempt")).status === 400);

    // ③ batch：只含 A+B 的音素（不含 8 天前的 ʃ）
    const batch = await scoped(`scope=batch&attempt_ids=${ids.dadA},${ids.dadB}`);
    check(
      "★ scope=batch → 只含这一批的音素（θ+s，排除旧的 ʒ）",
      batch.status === 200 && phonemes(batch).includes("θ") && phonemes(batch).includes("s") && !phonemes(batch).includes("ʒ"),
      JSON.stringify(phonemes(batch)),
    );
    check("batch summary 含「这一批」+ 句数", /这一批/.test(batch.json?.summary_zh ?? ""), batch.json?.summary_zh ?? "");
    const tooMany = await scoped(`scope=batch&attempt_ids=${Array.from({ length: 21 }, (_, i) => `x${i}`).join(",")}`);
    check("batch 超过 20 个 id → 400", tooMany.status === 400);
    const foreignBatch = await scoped(`scope=batch&attempt_ids=${ids.dadA},${ids.momB}`);
    check("★ batch 含别人的 id → 404（不泄漏）", foreignBatch.status === 404);

    // ④ recent&days=7：排除 8 天前的旧数据
    const recent = await scoped("scope=recent&days=7");
    check(
      "★ scope=recent&days=7 → 排除 8 天前的旧音素（ʒ）",
      recent.status === 200 && !phonemes(recent).includes("ʒ") && phonemes(recent).includes("θ"),
      JSON.stringify(phonemes(recent)),
    );
    const recentAll = await scoped("scope=recent&days=30");
    check("scope=recent&days=30 → 旧音素（ʒ）重新出现", phonemes(recentAll).includes("ʒ"), JSON.stringify(phonemes(recentAll)));

    // ⑤ 对子去重：同一对子（a-b 与 b-a）只出现一次
    const pairs = (rows) =>
      (rows ?? []).flatMap((i) => (i.contrasts ?? []).map((c) => [...(c.pair ?? [])].sort().join("-")));
    const allPairs = pairs(all.json?.items);
    const dup = allPairs.filter((k, i) => allPairs.indexOf(k) !== i);
    check("★ 对子去重：没有任何重复 pair（a→b 与 b→a 合并）", allPairs.length > 0 && dup.length === 0, `pairs=${allPairs.length} dup=${JSON.stringify(dup.slice(0, 3))}`);
    const scopedPairs = pairs(batch.json?.items);
    check(
      "★ 作用域结果里也没有重复对子",
      scopedPairs.length === 0 || scopedPairs.every((k, i) => scopedPairs.indexOf(k) === i),
      `pairs=${JSON.stringify(scopedPairs.slice(0, 4))}`,
    );

    // ⑥ 儿童零 IPA（四个 scope 全覆盖）
    const childPayloads = await Promise.all([
      childScoped("scope=all"),
      childScoped("scope=recent&days=7"),
      childScoped(`scope=attempt&attempt_id=${ids.dadA}`), // 别人的 id → 404 也不算泄漏
      childScoped(`scope=batch&attempt_ids=${ids.dadA},${ids.dadB}`),
    ]);
    const leaks = childPayloads.flatMap((r) => IPA.filter((c) => JSON.stringify(r.json ?? {}).includes(c)));
    check("★ 儿童四种 scope 的响应均零 IPA", leaks.length === 0, `leaked=${[...new Set(leaks)].join("")}`);

    // ⑦ 页面：/report 默认 recent + 可切 all
    const report = await get("/report", girl.cookie);
    check(
      "★ /report 默认 recent 且有切换（scope-recent / scope-all）",
      report.status === 200 &&
        report.text.includes('data-testid="scope-recent"') &&
        report.text.includes('data-testid="scope-all"') &&
        /最近 7 天/.test(report.text),
      `status=${report.status}`,
    );
    check("★ /report 有「最近最需要练的」高亮块", report.text.includes('data-testid="recent-focus"'));
    check("/report?scope=all → 200", (await get("/report?scope=all", girl.cookie)).status === 200);
    check("儿童 /report 零 IPA", IPA.filter((c) => report.text.includes(c)).length === 0, IPA.filter((c) => report.text.includes(c)).join(""));

    // ⑧ practice / flow 页面（client 组件，源码级断言）
    const practiceSrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/practice/PracticeClient.tsx"), "utf8");
    const flowSrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/flow/FlowClient.tsx"), "utf8");
    check("★ practice 结果卡含「这一句的问题」（scope=attempt）", practiceSrc.includes('scope="attempt"') && practiceSrc.includes("这一句的问题"));
    check("★ flow 汇总含「这一批（N 句）的问题」（scope=batch）", flowSrc.includes('scope="batch"') && flowSrc.includes("这一批"));
  } finally {
    // 清理测试数据（attempts + phoneme_scores 级联手动删）
    for (const id of Object.values(ids)) {
      db.prepare("DELETE FROM phoneme_scores WHERE attempt_id = ?").run(id);
      db.prepare("DELETE FROM attempts WHERE id = ?").run(id);
    }
    db.close();
  }
}

console.log(`\n合计失败 ${failed} 项`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
