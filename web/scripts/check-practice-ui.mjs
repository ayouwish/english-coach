#!/usr/bin/env node
/**
 * task-14 的 UI 断言（无浏览器）：
 *   A) 纯逻辑：雷达图的 null 处理、词级"长度编码"排序、整句没听到的判定（直接 import TS 模块，
 *      Node 24 原生支持类型剥离 —— 与页面用的是同一份实现，不是复制的测试代码）；
 *   B) HTTP：真实请求 /practice 的 HTML，验证
 *        · 正常结果 → 出现雷达图 + 词条横排（长度编码）DOM，且 prosody=null 的轴标 "—"
 *        · 完全没有识别到语音 → 出现"没听到"提示，且**不出现**逐词条/雷达（避免满屏 0 分）
 *
 * 用法：BASE_URL=http://127.0.0.1:3010 DB_PATH=... node scripts/check-practice-ui.mjs
 * （脚本会切换隔离测试库里的"最新一条 attempt"来驱动两种页面状态，不会碰 Lead 的库。）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/practice-ui-selftest/app.db");
const CHILD_EMAIL = process.env.CHILD_EMAIL ?? "girl@example.com";
const CHILD_PASSWORD = process.env.CHILD_PASSWORD ?? "Girl12345!";

const { buildRadarSvg, lowestAxis, formatScore } = await import(
  path.join(WEB_ROOT, "src/lib/radar.ts")
);
const { encodeWordRows } = await import(path.join(WEB_ROOT, "src/lib/word-encoding.ts"));
const { isSpeechMissing, spokenCharCount } = await import(
  path.join(WEB_ROOT, "src/lib/speech-detection.ts")
);

let failed = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n──────── ${t} ────────`);

// ── A. 纯逻辑 ────────────────────────────────────────────────────────────────
section("A1. 雷达图：null 轴标 —、且不参与多边形（绝不画成 0）");
{
  const withNull = buildRadarSvg(
    { accuracy: 78, fluency: 80, completeness: 100, prosody: null },
    { isChild: false },
  );
  check("prosody 轴标记为 null", withNull.includes('data-axis="prosody" data-value="null"'));
  check("prosody 轴显示 —", /data-axis="prosody"[\s\S]{0,400}?>\s*—/.test(withNull) || withNull.includes(">—</text>"));
  const polygonPoints = /data-testid="radar-polygon"[^>]*/.exec(withNull)?.[0] ?? "";
  const pts = /points="([^"]+)"/.exec(withNull)?.[1] ?? "";
  check("有值轴参与多边形（3 个顶点）", (pts.match(/,/g) ?? []).length >= 3, `points=${pts}`);
  check("null 轴不产生顶点（顶点数 = 3 = 有值轴数）", withNull.match(/<circle /g)?.length === 3, `circles=${withNull.match(/<circle /g)?.length}`);
  check(
    "抛物线不包含 0 分（没有把 null 当 0 画）",
    !/points="[^"]*\b0(\.0+)?,/.test(pts),
    polygonPoints.slice(0, 60),
  );

  const allNull = buildRadarSvg(
    { accuracy: null, fluency: null, completeness: null, prosody: null },
    { isChild: true },
  );
  check("全部为 null 时不画多边形", !allNull.includes('data-testid="radar-polygon"'));
  check(
    "四个轴都标 null",
    (allNull.match(/data-value="null"/g) ?? []).length === 4,
    `n=${(allNull.match(/data-value="null"/g) ?? []).length}`,
  );
  check("最低分项：忽略 null", lowestAxis({ accuracy: 70, fluency: null, completeness: 90, prosody: 60 })?.key === "prosody");
  check("儿童模式不显示小数", formatScore(78.4, true) === "78" && formatScore(78.4, false) === "78.4");
}

section("A2. 词级反馈：长度编码 + 问题词置顶排序（不靠颜色）");
{
  const rows = encodeWordRows([
    { word: "I", score: 96 },
    { word: "think", score: 41 },
    { word: "the", score: 52 },
    { word: "weather", score: 76 },
    { word: "today", score: null },
  ]);
  check("完整列表保持句子顺序", rows.all.map((r) => r.word).join(",") === "I,think,the,weather,today");
  check("问题词按分数升序（最差在最前）", rows.problem.map((r) => r.word).join(",") === "think,the", rows.problem.map((r) => `${r.word}:${r.score}`).join(","));
  check("问题词阈值 <60", rows.problem.every((r) => (r.score ?? 100) < 60));
  check("条长 = 分数（96 → 96%）", rows.all[0].barPct === 96, `barPct=${rows.all[0].barPct}`);
  check("无分数词不误判为问题词", rows.all[4].problem === false && rows.all[4].barPct === 0);
  check("最差的词 = think", rows.worst?.word === "think", JSON.stringify(rows.worst));
}

section("A3. 整句没听到的判定");
{
  check("recognized_text='.' → 没听到", isSpeechMissing({ recognized_text: ".", warnings: [] }));
  check("空字符串 → 没听到", isSpeechMissing({ recognized_text: "", warnings: [] }));
  check("low_snr 警告 → 没听到", isSpeechMissing({ recognized_text: "hello", warnings: ["low_snr"] }));
  check(
    "正常识别 → 不算没听到",
    !isSpeechMissing({ recognized_text: "i can see three birds", warnings: [] }),
  );
  check(
    "只有 asr_mismatch（读错内容）→ 不算没听到",
    !isSpeechMissing({ recognized_text: "i can see birds", warnings: ["asr_mismatch"] }),
  );
  check("标点不计入字母数", spokenCharCount("...") === 0 && spokenCharCount("hi!") === 2);
}

// ── B. HTTP：真实页面 HTML ───────────────────────────────────────────────────
section("B. /practice 页面 HTML 断言");
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: CHILD_EMAIL, password: CHILD_PASSWORD }),
});
if (!login.ok) {
  console.log(`❌ 登录失败：HTTP ${login.status}（BASE=${BASE}）`);
  process.exit(1);
}
const setCookies = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [];
const cookie = (setCookies.find((c) => c.startsWith("ec_session=")) ?? setCookies[0] ?? "").split(";")[0];
console.log(`以儿童账号登录：${(await login.json()).user.displayName}`);

function setLatest(attemptId) {
  const db = new Database(DB_PATH);
  db.prepare("UPDATE attempts SET created_at = ? WHERE id = ?").run(new Date(Date.now() + 60000).toISOString(), attemptId);
  db.close();
}

async function practiceHtml() {
  const res = await fetch(`${BASE}/practice`, { headers: { cookie } });
  return { status: res.status, html: await res.text() };
}

if (!fs.existsSync(DB_PATH)) {
  check(`隔离测试库存在（${DB_PATH}）`, false, "请先按 README 建练习 UI 自测库");
} else {
  setLatest("att_normal");
  const normal = await practiceHtml();
  check("GET /practice 200", normal.status === 200, `status=${normal.status}`);
  check("正常结果：出现雷达图", normal.html.includes('data-testid="score-radar"'));
  check(
    "正常结果：prosody=null 的轴标 —（未当成 0）",
    normal.html.includes('data-axis="prosody" data-value="null"'),
  );
  check(
    "正常结果：出现「最需要练的是 …」文字兜底",
    /最需要练的是[^<]{0,20}/.test(normal.html),
    (normal.html.match(/最需要练的是[^<]{0,20}/) ?? [""])[0],
  );
  check("正常结果：出现词条横排（长度编码）", normal.html.includes('data-testid="word-bars"'));
  check("正常结果：问题词小结在", normal.html.includes('data-testid="problem-words"'));
  const wordRow = /<li[^>]*data-testid="word-row"[\s\S]{0,2000}?<\/li>/.exec(normal.html)?.[0] ?? "";
  check("词条 DOM 含 单词/条长/分数 三段", /data-word="[^"]+"/.test(wordRow) && /data-testid="word-bar"/.test(wordRow) && /tabular-nums/.test(wordRow), wordRow.slice(0, 160));
  check(
    "⚠️ 图标用于问题词（非颜色编码）",
    normal.html.includes("⚠️") && normal.html.includes('data-problem="1"'),
  );
  check("不出现「没听到」提示（这是正常结果）", !normal.html.includes("这次好像没听到你的声音"));
  check("儿童页不出现 IPA 字形", !/[θðɹŋæʃɪʌɔɜəʊʒɑɒɛ]/.test(normal.html));
  console.log(`\n   ↳ 词条 DOM 片段：${wordRow.replace(/\s+/g, " ").slice(0, 300)}`);
  const radarSnippet =
    /<svg[^>]*data-testid="score-radar"[\s\S]{0,3000}?<\/svg>/.exec(normal.html)?.[0] ?? "";
  console.log(`   ↳ 雷达图 SVG 片段（前 300 字符）：${radarSnippet.replace(/\s+/g, " ").slice(0, 300)}`);

  setLatest("att_nospeech");
  const noSpeech = await practiceHtml();
  check("没听到：200", noSpeech.status === 200, `status=${noSpeech.status}`);
  check(
    "★ 没听到：出现明确提示",
    noSpeech.html.includes('data-testid="no-speech-notice"') &&
      noSpeech.html.includes("这次好像没听到你的声音"),
  );
  check("★ 没听到：出现引导文案", noSpeech.html.includes("离麦克风近一点、说大声一点"));
  check("★ 没听到：不出现逐词条（没有「每词 0 分」）", !noSpeech.html.includes('data-testid="word-bars"'));
  check("★ 没听到：不出现雷达图", !noSpeech.html.includes('data-testid="score-radar"'));
  check("没听到：带重录入口（页面录音按钮仍在）", noSpeech.html.includes("按这里开始说") || noSpeech.html.includes("开始录音"));
}

console.log(`\n合计断言失败 ${failed} 项`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
