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
  const html = (await res.text()).replace(/<!--[\s\S]*?-->/g, "");
  return { status: res.status, html };
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
  // task-87：单词可点（音标点击后才由 API 下发；儿童默认不返回 IPA）
  check("★ 练习句子的单词可点（word-token）", normal.html.includes('data-testid="word-token"'));
  {
    const tokenClasses = [...normal.html.matchAll(/data-testid="word-token"[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    check("★ 单词按钮只有 word-token class（无 underline/padding 装饰，task-94）", tokenClasses.length > 0 && tokenClasses.every((c) => c === "word-token"), tokenClasses.slice(0, 2).join(" | "));
    check("练习页无 &nbsp;（词间是普通空格）", !normal.html.includes("&nbsp;"));
  }
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

// ── C. task-43：「只听示范」点了立即播放（不是只渲染播放器）─────────────────
section("C. 「只听示范」立即播放（playDemo 源码级断言）");
{
  const src = fs.readFileSync(path.join(WEB_ROOT, "src/app/practice/PracticeClient.tsx"), "utf8");
  // 抠出 playDemo 函数体（花括号配对）
  const start = src.indexOf("async function playDemo(");
  let body = "";
  if (start >= 0) {
    const open = src.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          body = src.slice(open, i + 1);
          break;
        }
      }
    }
  }
  check("能找到 playDemo 函数", body.length > 0, `len=${body.length}`);
  check(
    "★ playDemo 里真的调用了 play()（不是只 setDemoUrl）",
    /\.play\(\)/.test(body) && /new Audio\(/.test(body),
    body.includes("audio.play()") ? "命中 audio.play()" : "未命中",
  );
  check(
    "★ 重复点击先 pause + currentTime=0（从头播、不叠加）",
    /pause\(\)/.test(body) && /currentTime\s*=\s*0/.test(body),
  );
  check("★ 有「播放中」状态（按钮文案/状态变量）", src.includes('"播放中…"') && src.includes("demoPlaying"));
  check("play() 失败可见（不静默）", /自动播放被浏览器拦/.test(body) || /示范音播放失败/.test(body));
  check("兜底：原生 <audio controls> 仍在且带说明", src.includes("<audio controls src={demoUrl}") && src.includes("也可以用这个播放器重复听"));
  check("切句/卸载会停播并 revoke（不 revoke 正在播的）", src.includes("stopDemoAudio()") && src.includes("URL.revokeObjectURL(demoUrlRef.current)"));
  check("「跟我读」未被改动（仍是自己 new Audio(url) 播放）", /async function followAlong\([\s\S]{0,1200}?new Audio\(url\)/.test(src));
}

// ── D. task-84：练习游标（继续上次）+ 单句历史/进步曲线 ──────────────────────
section("D. task-84 练习游标 + 单句历史");
{
  const db84 = new Database(DB_PATH, { readonly: true });
  const sentenceRow = db84.prepare("SELECT id FROM sentences ORDER BY sort_order LIMIT 1").get();
  const historySentence = db84.prepare("SELECT sentence_id, COUNT(*) c FROM attempts WHERE sentence_id IS NOT NULL GROUP BY sentence_id ORDER BY c DESC LIMIT 1").get();
  const cursorTable = db84.prepare("SELECT name FROM sqlite_master WHERE name='practice_cursors'").get();
  db84.close();
  const sentenceId = sentenceRow?.id ?? "s-a1-01";
  const historyId = historySentence?.sentence_id ?? sentenceId;

  check("迁移 0019：practice_cursors 表存在", Boolean(cursorTable?.name));

  const put = async (body) =>
    fetch(`${BASE}/api/practice/cursor`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const get = async () => (await (await fetch(`${BASE}/api/practice/cursor?scope=all`, { headers: { cookie } })).json())?.cursor ?? null;

  const putRes = await put({ scope: "all", position: 2, total: 10, sentence_id: sentenceId });
  const cursor = await get();
  check("★ PUT 游标 → 200 且 GET 一致", putRes.status === 200 && cursor?.position === 2 && cursor?.sentence_id === sentenceId, JSON.stringify(cursor));
  const withBanner = await practiceHtml();
  check("★ 有游标时页面显示「上次练到第 3 句」", withBanner.html.includes('data-testid="practice-cursor-banner"') && /上次练到第\s*3\s*句/.test(withBanner.html), (withBanner.html.match(/上次练到第\s*\d+\s*句/) ?? [""])[0]);
  check("★ 横幅有「继续上次」+「从头开始」按钮", withBanner.html.includes('data-testid="practice-cursor-continue"') && withBanner.html.includes('data-testid="practice-cursor-restart"'));

  const reset = await put({ scope: "all", position: 0, total: 10, sentence_id: sentenceId });
  const resetCursor = await get();
  const noBanner = await practiceHtml();
  check("★ position=0 → 横幅消失（无游标不打扰）", reset.status === 200 && resetCursor?.position === 0 && !noBanner.html.includes('data-testid="practice-cursor-banner"'));

  const badPut = await put({ scope: "all", position: -2, total: 10 });
  check("非法 position → 400", badPut.status === 400, `status=${badPut.status}`);
  const badSentence = await put({ scope: "all", position: 1, total: 10, sentence_id: "s-not-exist" });
  check("不存在的句子 → 400", badSentence.status === 400, `status=${badSentence.status}`);

  // 单句历史 API（仅本人；儿童零 IPA）
  const hRes = await fetch(`${BASE}/api/sentences/${encodeURIComponent(historyId)}/attempts?limit=20`, { headers: { cookie } });
  const hBody = await hRes.json().catch(() => null);
  check("★ GET /api/sentences/:id/attempts → 200 且含 sentence/attempts", hRes.status === 200 && Boolean(hBody?.sentence?.id) && Array.isArray(hBody?.attempts), `status=${hRes.status}`);
  check("儿童历史响应零 IPA", !/[θðɹŋæʃɪʌɔɜəʊʒɑɒɛ]/.test(JSON.stringify(hBody ?? {})));
  const otherLogin = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "dad@example.com", password: "Dad12345!" }),
  });
  const rawOther = otherLogin.ok && typeof otherLogin.headers.getSetCookie === "function" ? otherLogin.headers.getSetCookie() : [];
  const dadCookie = (rawOther.find((c) => c.startsWith("ec_session=")) ?? rawOther[0] ?? "").split(";")[0];
  if (dadCookie) {
    const hOther = await (await fetch(`${BASE}/api/sentences/${encodeURIComponent(historyId)}/attempts?limit=20`, { headers: { cookie: dadCookie } })).json();
    check("★ 单句历史仅本人（他人看不到儿童记录）", (hOther?.attempts ?? []).length === 0 || (hOther?.attempts ?? []).every((a) => a.id !== hBody?.attempts?.[0]?.id), `other=${(hOther?.attempts ?? []).length}`);
  }

  // 曲线/历史 UI（源码级：SVG 元素 + ≥2 才画 + 空态）
  const histSrc = fs.readFileSync(path.join(WEB_ROOT, "src/components/SentenceHistory.tsx"), "utf8");
  check("★ 进步曲线用 SVG polyline（≥2 次才画）", histSrc.includes("<polyline") && histSrc.includes("scored.length >= 2"));
  check("★ 首末对比文案存在", histSrc.includes("首末对比"));
  check("★ 0 次时显示空态「多读几次就能看到曲线」", histSrc.includes("多读几次就能看到曲线"));
  check("结果区挂载「这一句的历史」组件", fs.readFileSync(path.join(WEB_ROOT, "src/app/practice/PracticeClient.tsx"), "utf8").includes("<SentenceHistory"));
  check("列表有「📈 历史」入口", fs.readFileSync(path.join(WEB_ROOT, "src/app/practice/PracticeClient.tsx"), "utf8").includes('data-testid="sentence-history-button"'));
  const practiceSrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/practice/PracticeClient.tsx"), "utf8");
  check("★ 提交即保存游标（不依赖评分完成）", /saveCursor\(idx\)/.test(practiceSrc) && /setResponse\(data\)/.test(practiceSrc));
  check("继续上次按 position 定位句子", /sentences\[cursor\.position\]/.test(practiceSrc));
}

console.log(`\n合计断言失败 ${failed} 项`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
