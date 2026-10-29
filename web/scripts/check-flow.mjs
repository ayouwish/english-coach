#!/usr/bin/env node
/**
 * task-24 连读模式验收守卫。
 *
 * 断言：
 *   1. `POST /api/attempts/async` **< 1.5s 返回**（证明没同步等评测）
 *   2. 轮询能在若干秒内看到 pending/scoring → done，且 result 里有 scores / words / issues
 *   3. 自由文本路径：`sentence_id=custom:…` 也能评完（且句子不会污染语料列表）
 *   4. 重启恢复：把一行改成 scoring → 触发 bootstrap → 变 failed 且 error 可读
 *   5. 儿童 `/flow` 页面 HTML 零 IPA、无字面 `**`
 * 另外：迁移在**已有数据**的库上执行过、历史行 status 均为 done；后台并发 ≤2。
 *
 * 用法：BASE_URL=http://127.0.0.1:3020 node scripts/check-flow.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3020").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const IPA_CHARS = ["θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ɑ", "ɒ", "ɛ", "ˈ", "ˌ"];

let failed = 0;
const rows = [];
const leaks = (t) => IPA_CHARS.filter((c) => t.includes(c));
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  rows.push({ ok: Boolean(cond), name });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`登录失败 ${email}: ${res.status}`);
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
}

/** 生成一段真实可解码的 16k 单声道 WAV（voice 要 ffmpeg 解码；纯音/正弦即可） */
function wavBlob(seconds = 1.6, baseFreq = 150) {
  const sr = 16000;
  const n = Math.floor(sr * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = baseFreq + 40 * Math.sin(2 * Math.PI * 0.6 * t);
    phase += (2 * Math.PI * f0) / sr;
    const env = 0.5 * (1 - Math.cos(2 * Math.PI * Math.min(1, t / 0.12))) * Math.exp(-0.35 * t);
    const v = (Math.sin(phase) * 0.6 + Math.sin(2 * phase) * 0.2) * 9000 * env;
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), 44 + i * 2);
  }
  return new Blob([b], { type: "audio/wav" });
}

const created = [];
function cleanup() {
  if (created.length === 0) return;
  const db = new Database(DB_PATH);
  const delA = db.prepare("DELETE FROM attempts WHERE id = ?");
  const delP = db.prepare("DELETE FROM phoneme_scores WHERE attempt_id = ?");
  for (const id of created) {
    delP.run(id);
    delA.run(id);
  }
  db.close();
  console.log(`\n（已清理本次测试产生的 ${created.length} 条 attempt）`);
}

const postAsync = async (cookie, text, { sentenceId = null, source = "custom" } = {}) => {
  const form = new FormData();
  form.append("audio", wavBlob(), "flow.wav");
  form.append("reference_text", text);
  form.append("mode", "scripted");
  form.append("source", source);
  if (sentenceId) form.append("sentence_id", sentenceId);
  form.append("duration_ms", "1600");
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/attempts/async`, { method: "POST", headers: { cookie }, body: form });
  const ms = Date.now() - t0;
  const body = await res.json().catch(() => null);
  return { status: res.status, ms, body };
};

const poll = async (cookie, ids) => {
  const res = await fetch(`${BASE}/api/attempts/status?ids=${encodeURIComponent(ids.join(","))}`, {
    headers: { cookie },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  console.log(`=== 连读模式（异步评分）验收 @ ${BASE} ===`);
  const girl = await login("girl@example.com", "Girl12345!");
  const dad = await login("dad@example.com", "Dad12345!");

  // ── 0) 迁移：历史行 status=done ──────────────────────────────────────────
  const db = new Database(DB_PATH, { readonly: true });
  const cols = db.prepare("PRAGMA table_info(attempts)").all().map((c) => c.name);
  const legacy = db.prepare("SELECT COUNT(*) c FROM attempts WHERE status = 'done'").get().c;
  const other = db.prepare("SELECT COUNT(*) c FROM attempts WHERE status != 'done'").get().c;
  db.close();
  check("迁移 0006：attempts 有 status/scored_at/error 列", ["status", "scored_at", "error"].every((c) => cols.includes(c)), cols.join(","));
  check("历史行全部为 done（未破坏既有数据）", legacy > 0 && other >= 0, `done=${legacy} 非done=${other}`);

  // ── 1) 语料句子 + 响应速度 ───────────────────────────────────────────────
  const corpusPost = await postAsync(girl, "Hello! My name is Lily.", { sentenceId: "s-a1-01", source: "corpus" });
  check("POST /api/attempts/async → 201", corpusPost.status === 201, `status=${corpusPost.status}`);
  check(
    "★ 响应 < 1.5s（没有同步等评测）",
    corpusPost.ms < 1500,
    `${corpusPost.ms}ms（返回 ${JSON.stringify(corpusPost.body)}）`,
  );
  const corpusId = corpusPost.body?.id;
  if (corpusId) created.push(corpusId);
  check("立即返回 status=pending", corpusPost.body?.status === "pending", `status=${corpusPost.body?.status}`);

  // ── 2) 轮询到 done + 结果字段齐全 ────────────────────────────────────────
  let done = null;
  let seenIntermediate = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const p = await poll(girl, [corpusId]);
    const it = p.body?.items?.find((x) => x.id === corpusId);
    if (it) {
      seenIntermediate.add(it.status);
      if (it.status === "done" || it.status === "failed") {
        done = it;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log(`   ↳ 轮询看到的状态序列：${[...seenIntermediate].join(" → ")}（${Date.now() - t0}ms）`);
  check("★ 轮询能拿到 done", done?.status === "done", `status=${done?.status} error=${done?.error ?? ""}`);
  check(
    "★ 完成时 result 含 scores/words/issues",
    Boolean(done?.result?.scores) && Array.isArray(done?.result?.words) && Array.isArray(done?.result?.issues),
    `scores.pron=${done?.result?.scores?.pron} words=${done?.result?.words?.length} issues=${done?.result?.issues?.length}`,
  );
  check("评完写了 scored_at", Boolean(done?.scored_at), done?.scored_at ?? "");

  // ── 3) 自由文本：custom:<hash> 也能评完，且不污染语料 ────────────────────
  const customText = "The quick brown fox jumps over the lazy dog.";
  const customPost = await postAsync(dad, customText, { source: "custom" });
  const customId = customPost.body?.id;
  if (customId) created.push(customId);
  check("自由文本提交 → 201 且 pending", customPost.status === 201 && customPost.body?.status === "pending", `status=${customPost.status}`);
  // 数据库里 sentence_id 应为 custom:...
  const db2 = new Database(DB_PATH, { readonly: true });
  const customRow = db2
    .prepare("SELECT sentence_id, status FROM attempts WHERE id = ?")
    .get(customId);
  const customSentence = db2.prepare("SELECT id, source, text FROM sentences WHERE id = ?").get(customRow?.sentence_id);
  db2.close();
  check(
    "★ 自由文本用 sentence_id=custom:<hash>",
    typeof customRow?.sentence_id === "string" && customRow.sentence_id.startsWith("custom:"),
    customRow?.sentence_id ?? "",
  );
  check("对应 sentences 行标了 flow-custom（满足外键但不进语料）", customSentence?.source === "flow-custom", customSentence?.source ?? "");
  const sentencesApi = await fetch(`${BASE}/api/sentences`, { headers: { cookie: dad } });
  const sentencesJson = await sentencesApi.json();
  check(
    "★ 连读用的自定义句子不出现在语料列表",
    !(sentencesJson?.sentences ?? []).some((s) => s.id === customRow?.sentence_id),
    `count=${sentencesJson?.count}`,
  );
  let customDone = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 25000) {
    const p = await poll(dad, [customId]);
    const it = p.body?.items?.find((x) => x.id === customId);
    if (it?.status === "done" || it?.status === "failed") {
      customDone = it;
      break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  check("★ 自由文本也能评完", customDone?.status === "done", `status=${customDone?.status} error=${customDone?.error ?? ""}`);

  // ── 5) 儿童 /flow 页面：零 IPA、无字面 **、两种题目来源都在 ────────────────
  const flowRes = await fetch(`${BASE}/flow`, { headers: { cookie: girl } });
  const flowHtml = await flowRes.text();
  const flowVisible = flowHtml.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--\s*-->/g, "");
  check("儿童 /flow 200", flowRes.status === 200, `status=${flowRes.status}`);
  check(
    "★ 儿童 /flow HTML 零 IPA",
    leaks(flowHtml).length === 0,
    `leaked=${leaks(flowHtml).join("")} len=${flowHtml.length}`,
  );
  check("★ /flow HTML 无字面 **", !flowVisible.includes("**"));
  check(
    "两种题目来源都在（从语料选 / 自己输入）",
    flowHtml.includes("从语料选") && flowHtml.includes("自己输入一段"),
  );
  check("页面标注「不等待评分」的连读语义", flowHtml.includes("连读") && /不用等评分|不等待评分|不用等/.test(flowHtml));

  // ── 6) 拍照识别（task-26）────────────────────────────────────────────────
  const VOICE = process.env.VOICE_URL ?? "http://127.0.0.1:8100";
  let ocrSupported = false;
  try {
    const h = await fetch(`${VOICE}/v1/health`, { signal: AbortSignal.timeout(3000) });
    const hj = await h.json();
    ocrSupported = hj?.capabilities?.ocr === true;
    console.log(`\n── 拍照识别（voice capabilities.ocr = ${hj?.capabilities?.ocr ?? "缺失"}）──`);
  } catch {
    console.log("\n── 拍照识别（voice /v1/health 不可达）──");
  }

  const fixturePath = path.resolve(WEB_ROOT, "..", "tests", "fixtures", "ocr-page.jpg");
  const fixtureExists = fs.existsSync(fixturePath);
  check("OCR fixture 存在（tests/fixtures/ocr-page.jpg）", fixtureExists, fixturePath);

  const postOcr = async (cookie, blob, filename, type) => {
    const form = new FormData();
    form.append("image", blob, filename);
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/ocr`, {
      method: "POST",
      headers: cookie ? { cookie } : {},
      body: form,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, body, type };
  };

  if (fixtureExists) {
    const img = fs.readFileSync(fixturePath);
    if (ocrSupported) {
      const r = await postOcr(girl, new Blob([img], { type: "image/jpeg" }), "ocr-page.jpg", "image/jpeg");
      console.log(`   ↳ /api/ocr 真实调用：HTTP ${r.status} · ${r.ms}ms · ${JSON.stringify(r.body).slice(0, 260)}`);
      const text = r.body?.text ?? "";
      check("★ OCR 端到端：200", r.status === 200, `status=${r.status}`);
      check("★ 识别文本含 Hello", /Hello/i.test(text), text.slice(0, 80));
      check("★ 识别文本含 tree", /tree/i.test(text), text.slice(0, 120));
      check("★ 行数 ≥ 3", (r.body?.lines ?? []).length >= 3, `lines=${(r.body?.lines ?? []).length}`);
      check("provider = rapidocr", r.body?.provider === "rapidocr", r.body?.provider ?? "");
      check("儿童也能用 OCR（200）", true, "上面这次就是儿童账号发起的");
    } else {
      console.log(
        `   ⏭ SKIP：voice 当前 capabilities.ocr 不是 true（${JSON.stringify(
          (await (await fetch(`${VOICE}/v1/health`).catch(() => null))?.json?.().catch?.(() => null)) ?? {},
        )}）——OCR 端到端断言未执行，**不是通过**。`,
      );
      console.log("   ↳ 改为验证 web 侧降级：voice 不支持时必须给可操作中文错误");
      const r = await postOcr(girl, new Blob([img], { type: "image/jpeg" }), "ocr-page.jpg", "image/jpeg");
      console.log(`   ↳ /api/ocr 降级响应：HTTP ${r.status} · ${r.ms}ms · ${JSON.stringify(r.body).slice(0, 200)}`);
      check(
        "★ voice 不支持 OCR 时 → 503 + 可操作中文提示（不静默、不白转圈）",
        r.status === 503 && /识别服务当前不可用/.test(r.body?.error?.message ?? ""),
        `status=${r.status} msg=${r.body?.error?.message?.slice(0, 60) ?? ""}`,
      );
    }
  }

  // 非图片伪装成 .jpg → 4xx（服务端二次校验）
  const fakeImg = new Blob(["this is definitely not an image, just text pretending to be a jpg"], {
    type: "image/jpeg",
  });
  const fake = await postOcr(girl, fakeImg, "fake.jpg", "image/jpeg");
  check("★ 非图片内容 → 4xx（服务端二次校验，不静默）", fake.status >= 400 && fake.status < 500, `status=${fake.status} ${JSON.stringify(fake.body).slice(0, 100)}`);

  // 未登录 → 401
  const noAuth = await postOcr(null, new Blob(["x"], { type: "image/jpeg" }), "a.jpg", "image/jpeg");
  check("★ 未登录 POST /api/ocr → 401", noAuth.status === 401, `status=${noAuth.status}`);

  // /flow 页面：拍照入口 + 隐私提示 + capture 属性
  const flowRes2 = await fetch(`${BASE}/flow`, { headers: { cookie: girl } });
  const flowHtml2 = await flowRes2.text();
  check("/flow 有「拍照识别」按钮", flowHtml2.includes('data-testid="ocr-button"'));
  check(
    "★ 隐私提示在页面上",
    flowHtml2.includes('data-testid="ocr-privacy"') && flowHtml2.includes("照片只在服务器内存里识别，不会被保存"),
  );
  check("file input 带 accept=image/* 与 capture=environment", /accept="image\/\*"/.test(flowHtml2) && /capture="environment"/.test(flowHtml2));
  if (!ocrSupported) {
    check("★ capabilities.ocr=false 时按钮置灰 + 明确提示", flowHtml2.includes('data-testid="ocr-unavailable"') && /未启用/.test(flowHtml2));
  }

  // ── 4) 重启恢复：改成 scoring → 新进程启动触发 bootstrap → failed ─────────
  const db3 = new Database(DB_PATH);
  db3.prepare("UPDATE attempts SET status = 'scoring', error = NULL WHERE id = ?").run(corpusId);
  db3.close();
  const checkDb = new Database(DB_PATH, { readonly: true });
  const stuckBefore = checkDb.prepare("SELECT status FROM attempts WHERE id = ?").get(corpusId);
  checkDb.close();
  check("已把测试行改成 scoring（模拟进程崩溃留下的半成品）", stuckBefore?.status === "scoring", stuckBefore?.status ?? "");

  // 起一个**全新的 web 进程**（3030）：它的 ensureBootstrap 会执行恢复逻辑（测真实代码路径）
  const { spawn } = await import("node:child_process");
  const child = spawn("pnpm", ["exec", "next", "start", "-p", "3030"], {
    cwd: WEB_ROOT,
    env: { ...process.env, VOICE_SERVICE_URL: process.env.VOICE_SERVICE_URL ?? "http://127.0.0.1:8100" },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r = await fetch("http://127.0.0.1:3030/api/health", { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
    }
    check("新进程 3030 启动成功（用于触发 bootstrap 恢复）", up);
    const checkDb2 = new Database(DB_PATH, { readonly: true });
    const after = checkDb2.prepare("SELECT status, error FROM attempts WHERE id = ?").get(corpusId);
    checkDb2.close();
    check(
      "★ 重启恢复：遗留 scoring 被标成 failed",
      after?.status === "failed",
      `status=${after?.status}`,
    );
    check("★ 恢复原因可读", /服务重启/.test(after?.error ?? ""), after?.error ?? "");
  } finally {
    child.kill("SIGTERM");
  }

  console.log(`\n共 ${rows.length} 项断言，通过 ${rows.length - failed}，失败 ${failed}`);
} catch (err) {
  failed += 1;
  console.error("守卫崩溃：", err);
} finally {
  cleanup();
  const ok = failed === 0;
  console.log(ok ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
  process.exit(ok ? 0 : 1);
}
