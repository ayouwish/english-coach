#!/usr/bin/env node
/**
 * 端到端集成验证（Lead 维护）—— web(:3000) + voice(:8100) 必须都在运行。
 *
 * 与各模块自测的分工：
 *   - voice 的自测覆盖 provider 内部逻辑；
 *   - web 的自测覆盖自己的业务逻辑；
 *   - **本脚本覆盖两模块之间的接缝，以及只有真实集成才会暴露的问题**：
 *       · 录音经 web → voice 评测 → 落盘 → 经 web /api/audio 回放的完整闭环
 *       · Next.js `/voice/*` 反向代理（rewrites 构建期烘焙，最容易在部署时静默失效）
 *       · 三个账号的角色隔离（儿童不得访问家长面板 / 不得进入超龄场景）
 *       · 儿童每日时长上限
 *
 * 用法：
 *   node tests/e2e_full.mjs                       # 默认 http://127.0.0.1:3000
 *   BASE=http://localhost:3000 node tests/e2e_full.mjs
 */

import { readFileSync } from "node:fs";

const BASE = (process.env.BASE || "http://127.0.0.1:3000").replace(/\/$/, "");

let pass = 0;
const failures = [];
const warnings = [];

const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const fail = (n, d) => { failures.push(`${n}: ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n} — ${d}`); };
const warn = (n, d) => { warnings.push(`${n}: ${d}`); console.log(`  \x1b[33m!\x1b[0m ${n} — ${d}`); };
const check = (n, c, d = "断言失败") => { c ? ok(n) : fail(n, d); return !!c; };
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** 创建类接口用 201 是正确语义，不该因为不是 200 就判失败 */
const is2xx = (s) => s >= 200 && s < 300;

/** 极简 cookie jar（Node fetch 不自动保持 cookie） */
const jar = new Map();
function saveCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

async function call(path, { method = "GET", json, form, raw = false, expectBinary = false } = {}) {
  const headers = {};
  if (jar.size) headers.cookie = cookieHeader();
  let body;
  if (json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
  saveCookies(res);
  if (expectBinary) return { res, buffer: Buffer.from(await res.arrayBuffer()) };
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json().catch(() => null) : await res.text().catch(() => null);
  return { res, data, ct };
}

/** 生成 16k 单声道 WAV（模拟一段有升降调的"语音"），用于真实触发整条音频链路 */
function makeWav(seconds = 1.8, sampleRate = 16000) {
  const n = Math.floor(seconds * sampleRate);
  const d = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = 170 + 90 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / seconds));
    const env = Math.min(1, i / (0.05 * sampleRate)) * Math.min(1, (n - i) / (0.05 * sampleRate));
    d.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Math.sin(2 * Math.PI * f * t) * 0.6 * env * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + d.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(d.length, 40);
  return Buffer.concat([h, d]);
}

function audioForm(fields) {
  const fd = new FormData();
  fd.append("audio", new Blob([makeWav()], { type: "audio/wav" }), "take.wav");
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fd;
}

async function login(email, password, label) {
  jar.clear();
  const { res, data } = await call("/api/auth/login", { method: "POST", json: { email, password } });
  if (!check(`${label} 登录成功`, res.status === 200, `status=${res.status} body=${JSON.stringify(data)?.slice(0, 200)}`)) return null;
  const me = await call("/api/auth/me");
  check(`${label} /api/auth/me 可用`, me.res.status === 200, `status=${me.res.status}`);
  return me.data?.user ?? me.data ?? null;
}

async function main() {
  console.log(`\n=== 端到端集成验证 @ ${BASE} ===\n`);

  // ---------- 0. 服务可达 + voice 状态 ----------
  console.log("[0] 服务探活");
  const health = await call("/api/health");
  if (!check("web /api/health 返回 200", health.res.status === 200, `status=${health.res.status}`)) {
    console.log("\nweb 没起来或 /api/health 不存在，后续无法继续。请先启动 web 与 voice。");
    return finish();
  }
  const voiceInfo = health.data?.voice ?? health.data?.dependencies?.voice ?? null;
  console.log(`    /api/health 内容片段：${JSON.stringify(health.data).slice(0, 300)}`);
  if (voiceInfo) {
    const reachable = voiceInfo.reachable ?? voiceInfo.status === "ok";
    check("web 报告 voice 可达（跨服务连通）", reachable === true, JSON.stringify(voiceInfo));
  } else {
    warn("未能从 /api/health 读到 voice 状态字段", "跳过跨服务连通断言，后续用实际评测结果验证");
  }

  // ---------- 0b. 语料文件基线（API 侧核对放在登录之后）----------
  console.log("\n[0b] 语料文件基线");
  let corpusCount = null;
  try {
    const corpusPath = new URL("../web/src/data/sentences.json", import.meta.url);
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8")).sentences;
    corpusCount = corpus.length;
    console.log(`    sentences.json 共 ${corpusCount} 条`);
    check("语料文件条数 ≥ 300（V1.5 目标）", corpusCount >= 300, `实际 ${corpusCount} 条`);
  } catch (e) {
    warn("无法读取语料文件", String(e).slice(0, 160));
  }

  // ---------- 1. 三个账号 ----------
  console.log("\n[1] 三账号登录与角色");
  const dad = await login("dad@example.com", "Dad12345!", "爸爸");
  const mom = await login("mom@example.com", "Mom12345!", "妈妈");
  const girl = await login("girl@example.com", "Girl12345!", "女儿");
  check("爸爸 role=parent", dad?.role === "parent", `role=${dad?.role}`);
  check("妈妈 role=parent", mom?.role === "parent", `role=${mom?.role}`);
  check("女儿 role=child", girl?.role === "child", `role=${girl?.role}`);
  check("女儿 age_band=child（决定儿童模式）", girl?.age_band === "child" || girl?.ageBand === "child",
    `age_band=${girl?.age_band ?? girl?.ageBand}`);

  const badLogin = await call("/api/auth/login", { method: "POST", json: { email: "dad@example.com", password: "wrong" } });
  check("错误密码被拒绝（401）", badLogin.res.status === 401, `status=${badLogin.res.status}`);

  // ---------- 2. 儿童跟读闭环（女儿童）----------
  console.log("\n[2] 跟读闭环（女儿）");
  await login("girl@example.com", "Girl12345!", "女儿");
  const sents = await call("/api/sentences");
  const list = sents.data?.sentences ?? sents.data?.items ?? [];
  check("GET /api/sentences 返回语料", Array.isArray(list) && list.length > 0, `条数=${list?.length}`);
  // 语料集成：文件 → seed → DB → API，条数必须一致（防止 seed 静默丢数据）
  if (corpusCount != null) {
    check("API 返回的语料条数与 sentences.json 一致（seed 无丢失）", list.length === corpusCount,
      `API=${list.length} 文件=${corpusCount}`);
  }
  // 归一化后语料不应再出现英式专有符号（否则 SRS 卡片 key 会与 provider 输出对不上）
  const rpLeftovers = list.filter((s) => (s.focus_phonemes ?? []).some((p) => ["ɒ", "iː", "uː", "ɔː", "ɜː", "ɑː", "ɹ", "ɛ"].includes(p)));
  check("语料音素已归一到 canonical-v1（无英式专有符号）", rpLeftovers.length === 0,
    `仍有 ${rpLeftovers.length} 句含旧符号，例：${rpLeftovers[0]?.text}`);
  // 优先挑含 /θ/ /ð/ 的句子：这是中国学习者的典型难点，能真正打通「出错 → 错音本 → SRS」闭环
  const rankSent = (s) => {
    const ph = s.focus_phonemes ?? s.focusPhonemes ?? [];
    const hard = ph.some((p) => p === "θ" || p === "ð") ? 0 : 1;
    const lvl = s.level === "A1" ? 0 : s.level === "A2" ? 1 : 2;
    return hard * 10 + lvl;
  };
  const ordered = [...list].sort((a, b) => rankSent(a) - rankSent(b));
  const sent = ordered[0];
  if (!check("取到一条可练习的句子", !!sent && isStr(sent.text), JSON.stringify(sent)?.slice(0, 120))) return finish();
  console.log(`    选用：${JSON.stringify(sent.text)} (${sent.level}, 难点音素 ${JSON.stringify(sent.focus_phonemes ?? [])})`);

  const att = await call("/api/attempts", {
    method: "POST",
    form: audioForm({
      sentence_id: sent.id, reference_text: sent.text, mode: "scripted", duration_ms: 1800,
    }),
  });
  if (!check("POST /api/attempts 成功（2xx）", is2xx(att.res.status), `status=${att.res.status} body=${JSON.stringify(att.data)?.slice(0, 300)}`)) {
    return finish();
  }
  const attemptId = att.data?.attempt_id;
  check("返回 attempt_id", isStr(attemptId) && attemptId.length > 0);
  // 本脚本用**合成音频**（正弦/扫频）驱动链路，只有 mock provider 会把它当成"语音"。
  // 真实 provider（azure）需要真实人声，会把合成音判为"未识别到语音"并按设计降级。
  // 因此：mock 模式下这条是硬断言；其它模式下只提示，并指向 azure_selfcheck.py。
  const voiceMode = health.data?.voice?.mode ?? "unknown";
  if (voiceMode === "mock") {
    check("不是降级结果（mock 模式下应给出真实评测）", att.data?.degraded !== true,
      `degraded=${att.data?.degraded} message=${att.data?.message}`);
  } else if (att.data?.degraded === true) {
    warn(`voice 处于 ${voiceMode} 模式，合成音频被真实 provider 判为"未识别到语音"并按设计降级`,
      "预期行为、非缺陷。真实语音的验证请跑 tests/azure_selfcheck.py（用 TTS 合成真实语音）");
  } else {
    check("非 mock 模式下仍拿到非降级评测", true);
  }
  const r = att.data?.result;
  check("result.scores.pron 为 0-100 数值", isNum(r?.scores?.pron) && r.scores.pron >= 0 && r.scores.pron <= 100,
    `scores=${JSON.stringify(r?.scores)}`);
  check("评测结果带 words 数组", Array.isArray(r?.words));
  check("评测结果带 issues 数组（≤5 条）", Array.isArray(r?.issues) && r.issues.length <= 5, `issues=${r?.issues?.length}`);
  check("返回 intonation（语调曲线是降级模式下唯一还能给的精确反馈）", !!r?.intonation,
    `intonation=${JSON.stringify(r?.intonation)?.slice(0, 120)}`);
  if (r?.intonation?.available) {
    check("F0 两条曲线等长（已对齐同一时间轴）",
      Array.isArray(r.intonation.user_f0) && r.intonation.user_f0.length === r.intonation.reference_f0?.length,
      `user=${r.intonation.user_f0?.length} ref=${r.intonation.reference_f0?.length}`);
  }
  check("返回中文反馈（LLM 或模板降级均可）", !!att.data?.feedback && isStr(att.data.feedback.summary),
    JSON.stringify(att.data?.feedback)?.slice(0, 150));

  // ---- 练一小节课：单句不足以验证「错音本 + SRS」闭环，需要一定量的练习数据 ----
  let sawIssues = (r?.issues?.length ?? 0) > 0;
  let issueSample = r?.issues?.[0] ? `${r.issues[0].word}:${r.issues[0].phoneme}→${r.issues[0].actual}` : null;
  const practiceSet = ordered.slice(1, 5);
  for (const s of practiceSet) {
    const a = await call("/api/attempts", {
      method: "POST",
      form: audioForm({ sentence_id: s.id, reference_text: s.text, mode: "scripted", duration_ms: 1600 }),
    });
    if (!is2xx(a.res.status)) { warn(`句子「${s.text}」提交失败`, `status=${a.res.status}`); continue; }
    const iss = a.data?.result?.issues ?? [];
    if (iss.length && !sawIssues) { sawIssues = true; issueSample = `${iss[0].word}:${iss[0].phoneme}→${iss[0].actual}`; }
  }
  console.log(`    本节共练 ${1 + practiceSet.length} 句，是否捕获到音素错误：${sawIssues}${issueSample ? `（例：${issueSample}）` : ""}`);
  if (voiceMode === "mock") {
    check("练习产生了音素级错误（错音本的数据来源）", sawIssues,
      "mock 模式下分数由参考文本决定；若全为高分则说明语料选择或评测链路有问题");
  } else if (!sawIssues) {
    warn(`voice 处于 ${voiceMode} 模式，合成音频拿不到音素级错误`, "预期行为；真实人声见 tests/azure_selfcheck.py");
  } else {
    check("非 mock 模式下仍捕获到音素级错误", true);
  }

  // ---------- 3. 落盘 + 回放 + 反代 ----------
  console.log("\n[3] 音频落盘与回放（只有真实集成才暴露）");
  const hist = await call("/api/attempts?limit=5");
  const rows = hist.data?.attempts ?? [];
  const row = rows.find((x) => x.id === attemptId);
  check("评测记录已入库（GET /api/attempts 能查到）", !!row, `最近 ${rows.length} 条`);
  const audioUrl = row?.audio_url;
  if (check("记录带 audio_url", isStr(audioUrl), `audio_url=${audioUrl}`)) {
    const au = await call(audioUrl, { expectBinary: true });
    check("录音可回放（HTTP 200）", au.res.status === 200, `status=${au.res.status}`);
    check("回放内容非空", au.buffer.length > 0, `bytes=${au.buffer.length}`);
  }
  const refUrl = row?.ref_audio_url;
  if (isStr(refUrl) && refUrl.startsWith("/voice/")) {
    const ref = await call(refUrl, { expectBinary: true });
    // ★ 这一条专门验证 Next.js 的 /voice/* rewrite。构建期烘焙错了会在这里静默 404/502。
    check("示范音频经 web 反代 /voice/* 可取回（验证 rewrites 生效）", ref.res.status === 200,
      `status=${ref.res.status} url=${refUrl}`);
    if (ref.res.status === 200) check("示范音频内容非空", ref.buffer.length > 0, `bytes=${ref.buffer.length}`);
  } else {
    warn("未拿到 /voice/ 前缀的 ref_audio_url", `ref_audio_url=${refUrl}；无法验证反向代理`);
  }

  // ---------- 4. 儿童场景年龄过滤 ----------
  console.log("\n[4] 儿童安全：场景年龄准入");
  const sc = await call("/api/chat/scenarios");
  const scenarios = sc.data?.scenarios ?? [];
  check("GET /api/chat/scenarios 返回场景", scenarios.length > 0, `条数=${scenarios.length}`);
  const tooOld = scenarios.filter((s) => (s.min_age ?? 0) > 8);
  check("女儿看不到超龄场景（服务端过滤，不只是前端隐藏）", tooOld.length === 0,
    `越权场景：${tooOld.map((s) => `${s.title_zh}(${s.min_age}+)`).join(", ")}`);
  const kidScenario = scenarios.find((s) => (s.min_age ?? 99) <= 8) ?? scenarios[0];

  // ---------- 5. 对话闭环 ----------
  console.log("\n[5] 对话闭环（女儿，多轮）");
  const sess = await call("/api/chat/sessions", { method: "POST", json: { scenario_id: kidScenario.id } });
  if (!check("创建对话会话成功（2xx；201 Created 是正确语义）", is2xx(sess.res.status), `status=${sess.res.status} body=${JSON.stringify(sess.data)?.slice(0, 200)}`)) {
    return finish();
  }
  const sid = sess.data?.session_id;
  check("开场白已生成", isStr(sess.data?.scenario?.opening_line), JSON.stringify(sess.data?.scenario?.opening_line));
  const turns = ["I want a coffee.", "Hot, please.", "Thank you!"];
  let lastTurn = null;
  for (let i = 0; i < turns.length; i++) {
    const t = await call(`/api/chat/sessions/${sid}/turn`, { method: "POST", json: { text: turns[i] } });
    if (!check(`第 ${i + 1} 轮成功（2xx）`, is2xx(t.res.status), `status=${t.res.status} body=${JSON.stringify(t.data)?.slice(0, 200)}`)) break;
    lastTurn = t.data;
  }
  if (lastTurn) {
    check("多轮对话有回复文本", isStr(lastTurn.reply) && lastTurn.reply.length > 0, JSON.stringify(lastTurn.reply)?.slice(0, 120));
    check("带中文翻译（儿童需要）", isStr(lastTurn.reply_zh), `reply_zh=${JSON.stringify(lastTurn.reply_zh)?.slice(0, 80)}`);
    check("suggested_replies 为 2-3 条（降低孩子开口门槛的关键字段）",
      Array.isArray(lastTurn.suggested_replies) && lastTurn.suggested_replies.length >= 2 && lastTurn.suggested_replies.length <= 3,
      JSON.stringify(lastTurn.suggested_replies));
    check("correction 对象存在", !!lastTurn.correction, JSON.stringify(lastTurn.correction)?.slice(0, 150));
  }
  const detail = await call(`/api/chat/sessions/${sid}`);
  check("会话详情可读取（消息已落库）", is2xx(detail.res.status) && Array.isArray(detail.data?.messages),
    `status=${detail.res.status}`);

  // ---------- 6. 错音本 / SRS ----------
  console.log("\n[6] 错音本与间隔复习");
  const rev = await call("/api/review");
  check("GET /api/review 返回 2xx", is2xx(rev.res.status), `status=${rev.res.status}`);
  const cards = rev.data?.cards ?? rev.data?.due_cards ?? [];
  check("返回 SRS 评分档位（again/hard/good/easy）",
    Array.isArray(rev.data?.grades) && rev.data.grades.length === 4,
    JSON.stringify(rev.data?.grades));
  if (Array.isArray(cards) && cards.length > 0) {
    check("练习后错音本生成了待复习卡片（SRS 闭环打通）", true);
    console.log(`    待复习卡片 ${cards.length} 张，例：${JSON.stringify(cards[0]).slice(0, 160)}`);
    const g = await call("/api/review", { method: "POST", json: { card_id: cards[0].id, grade: "good" } });
    check("提交 SRS 评分成功（2xx）", is2xx(g.res.status), `status=${g.res.status} body=${JSON.stringify(g.data)?.slice(0, 200)}`);
    const after = await call("/api/review");
    const card2 = (after.data?.cards ?? []).find((c) => c.id === cards[0].id);
    if (card2) {
      const moved = card2.due_at && card2.due_at !== cards[0].due_at;
      check("评分后卡片的下次复习时间被重排（SM-2 生效）", moved || (card2.reps ?? 0) > (cards[0].reps ?? 0),
        `before=${cards[0].due_at} after=${card2.due_at} reps=${cards[0].reps}->${card2.reps}`);
    } else {
      ok("评分为 good 后卡片已移出待复习队列（排期到未来）");
    }
  } else {
    // 已练了 5 句仍无卡片 → 说明「错误 → 错音本」这条链断了，是真的失败
    fail("练习后错音本仍无卡片", "已完成 5 次含音素错误的跟读，但 /api/review 没有生成任何 SRS 卡片");
  }
  // 契约 §10 只冻结了数据库表名 phoneme_mastery；API 响应字段名未冻结，
  // 这里接受 weak_phonemes / phoneme_mastery 两种命名。
  // 注意：音素级数据只可能来自真实人声。mock 模式下合成音频能产出音素错误；
  // 真实 provider 模式下合成音频被判为"无语音"→ 按设计降级为单词级 → 音素聚合必然为空。
  const mastery = rev.data?.weak_phonemes ?? rev.data?.phoneme_mastery ?? rev.data?.mastery ?? null;
  if (mastery === null || mastery === undefined) {
    fail("响应中没有音素掌握度聚合字段", `可用字段：${Object.keys(rev.data ?? {}).join(",")}`);
  } else {
    const n = Array.isArray(mastery) ? mastery.length : Object.keys(mastery).length;
    const sample = Array.isArray(mastery) ? mastery[0] : mastery[Object.keys(mastery)[0]];
    if (n > 0) {
      check("返回音素掌握度聚合（phoneme_mastery 的对外形态，长期价值的载体）", true);
      console.log(`    音素掌握度 ${n} 条，例：${JSON.stringify(sample ?? {}).slice(0, 160)}`);
    } else if (voiceMode === "mock") {
      fail("音素掌握度聚合为空", "mock 模式下练习应产出音素级数据");
    } else {
      warn(`voice 处于 ${voiceMode} 模式，合成音频无音素级数据，故 phoneme_mastery 为空`,
        "预期行为。真实人声下会有音素聚合，验证方式见 tests/azure_selfcheck.py");
    }
  }

  // ---------- 6b. 盲测（契约 v1.1 §13）----------
  console.log("\n[6b] 盲测：唯一能诚实证明进步的指标");
  await login("girl@example.com", "Girl12345!", "女儿");

  // 先记录盲测前的日常统计，用于验证"盲测不污染日常指标"
  const revBefore = await call("/api/review");
  const cardsBefore = (revBefore.data?.due_cards ?? []).length;
  const weakBefore = JSON.stringify(revBefore.data?.weak_phonemes ?? []);
  const attemptsBefore = await call("/api/attempts?limit=100");
  const practiceCountBefore = (attemptsBefore.data?.attempts ?? []).length;

  const bt = await call("/api/blind-tests", { method: "POST", json: {} });
  if (check("开始盲测成功（2xx）", is2xx(bt.res.status), `status=${bt.res.status} body=${JSON.stringify(bt.data)?.slice(0, 200)}`)) {
    const btId = bt.data?.blind_test_id;
    const sids = bt.data?.sentence_ids ?? [];
    check("返回 blind_test_id", isStr(btId) && btId.length > 0);
    check("返回待测句子列表与总数", Array.isArray(sids) && sids.length > 0 && bt.data?.total === sids.length,
      `total=${bt.data?.total} 句数=${sids.length}`);
    check("盲测从练过的语料里抽题（否则分数无同比性）", sids.length <= practiceCountBefore,
      `抽了 ${sids.length} 句，此前练习过 ${practiceCountBefore} 句`);

    // ★ 最关键：进行中绝不能返回分数/反馈
    let leaked = [];
    let progressOk = true;
    for (let i = 0; i < sids.length; i++) {
      const s = list.find((x) => x.id === sids[i]) ?? sent;
      const a = await call("/api/attempts", {
        method: "POST",
        form: audioForm({ sentence_id: sids[i], reference_text: s.text, mode: "scripted", duration_ms: 1500, blind_test_id: btId }),
      });
      if (!is2xx(a.res.status)) { fail(`盲测第 ${i + 1} 句提交失败`, `status=${a.res.status}`); break; }
      const keys = Object.keys(a.data ?? {});
      const bad = ["result", "feedback", "scores", "issues", "intonation"].filter((k) => keys.includes(k) && a.data[k] != null);
      if (bad.length) leaked.push(`第${i + 1}句:${bad.join("+")}`);
      if (a.data?.blind !== true) progressOk = false;
    }
    check("★ 盲测进行中不返回任何分数或反馈（否则盲测静默失效）", leaked.length === 0,
      `泄漏字段：${leaked.join(" / ")}`);
    check("盲测提交标记 blind=true", progressOk, "响应缺少 blind:true 标记");

    const fin = await call(`/api/blind-tests/${btId}/finish`, { method: "POST", json: {} });
    if (check("结束盲测成功（2xx）", is2xx(fin.res.status), `status=${fin.res.status} body=${JSON.stringify(fin.data)?.slice(0, 300)}`)) {
      const summary = fin.data?.summary ?? fin.data;
      check("结束后给出平均分（avg_pron 为数值）", isNum(summary?.avg_pron), JSON.stringify(summary)?.slice(0, 200));
      check("结束后给出与上一次的差值字段", "delta_pron" in (fin.data ?? {}) || "delta_pron" in (summary ?? {}),
        Object.keys(fin.data ?? {}).join(","));
    }

    const hist = await call("/api/blind-tests");
    check("可查询盲测历史与趋势", is2xx(hist.res.status) && Array.isArray(hist.data?.tests),
      `status=${hist.res.status}`);
    check("趋势含 current/previous/delta_pron（家长面板画图的数据源）",
      !!hist.data?.trend && "delta_pron" in hist.data.trend,
      JSON.stringify(hist.data?.trend));

    // ★ 盲测不得污染日常统计
    const revAfter = await call("/api/review");
    const cardsAfter = (revAfter.data?.due_cards ?? []).length;
    const weakAfter = JSON.stringify(revAfter.data?.weak_phonemes ?? []);
    check("★ 盲测记录不污染错音本与 phoneme_mastery", cardsAfter === cardsBefore && weakAfter === weakBefore,
      `卡片 ${cardsBefore}→${cardsAfter}；掌握度${weakBefore === weakAfter ? "未变" : "被改变"}`);
  } else {
    fail("无法开始盲测", `status=${bt.res.status}`);
  }

  // ---------- 7. 家长面板与越权 ----------
  console.log("\n[7] 家长面板与权限隔离");
  await login("dad@example.com", "Dad12345!", "爸爸");
  const ps = await call("/api/parent/summary");
  if (check("爸爸可访问 /api/parent/summary（2xx）", is2xx(ps.res.status), `status=${ps.res.status}`)) {
    const members = ps.data?.members ?? ps.data?.users ?? [];
    check("面板包含三个家庭成员", Array.isArray(members) && members.length === 3, `members=${members?.length}`);
    check("面板含学习时长与错音统计字段",
      JSON.stringify(ps.data).includes("minute") || JSON.stringify(ps.data).includes("duration") || JSON.stringify(ps.data).includes("phoneme"),
      Object.keys(ps.data ?? {}).join(","));
  }
  await login("girl@example.com", "Girl12345!", "女儿");
  const forbidden = await call("/api/parent/summary");
  // ★ 安全红线：儿童账号必须被服务端拒绝
  check("女儿访问家长面板被拒绝（403/401，服务端校验而非隐藏菜单）",
    forbidden.res.status === 403 || forbidden.res.status === 401,
    `status=${forbidden.res.status} body=${JSON.stringify(forbidden.data)?.slice(0, 200)}`);
  const parentPage = await call("/parent");
  check("女儿访问 /parent 页面同样被拒", parentPage.res.status === 403 || parentPage.res.status === 307 || parentPage.res.status === 308,
    `status=${parentPage.res.status}`);

  // ---------- 8. 页面渲染 + 儿童 IPA 泄漏 ----------
  console.log("\n[8] 服务端渲染与儿童模式");
  await login("girl@example.com", "Girl12345!", "女儿");
  // 这一组字形是 IPA 独有的（不会被普通拉丁文本误命中）。
  // 之所以要检查**完整 HTML（含 Next 的 RSC flight 负载）**：曾真实发生过
  // `srs_cards.id = "u-girl:phoneme:θ"` 被序列化进页面负载、绕过"儿童页面不得出现 IPA"
  // 的产品约束 —— 可见文案是干净的，泄漏藏在 id/props 里。
  const IPA_MARKS = ["θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ʤ", "ʧ", "ɑ", "ɒ", "ɛ", "ˈ", "ˌ"];
  const pages = [
    ["/", ["练", "英语"]],
    ["/practice", ["录", "音"]],
    ["/chat", ["对话"]],
    ["/review", ["复习"]],
    ["/settings", ["设置"]],
  ];
  for (const [p, must] of pages) {
    const page = await call(p);
    const html = typeof page.data === "string" ? page.data : "";
    const hit = must.some((m) => html.includes(m));
    check(`页面 ${p} 可渲染（2xx 且含关键文案）`, is2xx(page.res.status) && hit,
      `status=${page.res.status} len=${html.length} 命中=${hit}`);
    if (!is2xx(page.res.status)) continue;
    const leaked = IPA_MARKS.filter((ch) => html.includes(ch));
    // 硬失败：这是「6–9 岁不显示 IPA」的产品约束，不是风格问题
    check(`儿童页面 ${p} 的 HTML/RSC 负载不含 IPA 字形`, leaked.length === 0,
      `泄漏字形：${leaked.join(" ")}（共 ${leaked.length} 种）`);
  }
  const kidHtml = (await call("/practice")).data;
  check("女儿页面进入儿童模式（HTML 含儿童模式标记）", /儿童|kids?|child/i.test(String(kidHtml)),
    "未在 HTML 中匹配到儿童模式标记");

  // ---------- 9. 登出 ----------
  console.log("\n[9] 会话失效");
  const lo = await call("/api/auth/logout", { method: "POST" });
  check("登出返回 200", lo.res.status === 200, `status=${lo.res.status}`);
  const meAfter = await call("/api/auth/me");
  check("登出后 /api/auth/me 不再返回用户", meAfter.res.status === 401 || !meAfter.data?.user,
    `status=${meAfter.res.status} body=${JSON.stringify(meAfter.data)?.slice(0, 120)}`);

  finish();
}

function finish() {
  console.log(`\n=== 结果：通过 ${pass} 项，失败 ${failures.length} 项，警告 ${warnings.length} 项 ===`);
  if (warnings.length) { console.log("\n警告（需人工判断，不阻断）："); warnings.forEach((w) => console.log(`  ! ${w}`)); }
  if (failures.length) {
    console.log("\n失败明细："); failures.forEach((f) => console.log(`  ✗ ${f}`));
    console.log(""); process.exit(1);
  }
  console.log("\n\x1b[32m端到端集成验证全部通过。\x1b[0m\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n脚本异常：", e);
  console.error("（fetch failed / ECONNREFUSED 说明 web 或 voice 没起来）");
  process.exit(1);
});
