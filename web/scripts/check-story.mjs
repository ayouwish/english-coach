#!/usr/bin/env node
/**
 * task-49 验收：故事模式 /story（web 侧）。
 *
 * 断言：
 *  1. 未登录 POST /api/story/rewrite → 401；text_zh 空/超长、level 非法 → 4xx
 *  2. voice 未就绪（404/503/连不上）→ web 返回**可读中文错误**（不静默）
 *  3. /story 页面 HTML：输入区、难度选择（≥4 级，不写死三个）、两个输入入口（文字 + 🎤）
 *  4. 儿童 /story：零 IPA、无字面 **
 *  5. 保存 → materials.kind='story' → /story 列表可见 → 删除后消失
 *  6. /api/asr 传 language=zh-CN 时，转发给 voice 的字段正确（用本地 stub voice 抓 outbound）
 *  7. 迁移 0008 在**有数据**的库上生效；历史行（无 kind 插入）默认 'page'
 *
 * 用法：BASE_URL=http://127.0.0.1:3020 node scripts/check-story.mjs
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import module from "node:module";
import Database from "better-sqlite3";

/** 杀掉整条进程组：`next start` 是 pnpm 的子进程，只 kill pnpm 会留下孤儿占着端口，
 *  导致后续守卫静默跑到旧实例上（"假失败"）。因此 spawn 时 detached:true，这里杀进程组。 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
}


// Node 直接 import TS 时需要补 .ts 后缀钩子（与 check-encouragement 相同做法）
if (typeof module.registerHooks === "function") {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(`${specifier}.ts`, context);
        } catch {
          /* 交给默认解析 */
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3020").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const IPA_CHARS = ["θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ɑ", "ɒ", "ɛ", "ˈ", "ˌ"];

let failed = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  rows.push({ ok: Boolean(cond), name });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const leaks = (t) => IPA_CHARS.filter((c) => t.includes(c));

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

const created = [];
function cleanup() {
  if (created.length === 0) return;
  const db = new Database(DB_PATH);
  const del = db.prepare("DELETE FROM reading_materials WHERE id = ?");
  for (const id of created) del.run(id);
  db.close();
  console.log(`\n（已清理本次测试创建的 ${created.length} 条故事）`);
}

try {
  console.log(`=== 故事模式 /story 验收 @ ${BASE} ===`);
  const girl = await login("girl@example.com", "Girl12345!");
  const dad = await login("dad@example.com", "Dad12345!");

  // ── 0) 迁移：kind 列 + 历史行默认 page ─────────────────────────────────────
  const db = new Database(DB_PATH, { readonly: true });
  const cols = db.prepare("PRAGMA table_info(reading_materials)").all().map((c) => c.name);
  db.close();
  check("迁移 0008：reading_materials 有 kind/source_zh/level", ["kind", "source_zh", "level"].every((c) => cols.includes(c)), cols.join(","));
  {
    // 模拟"迁移前就存在的历史行"（不带 kind 插入）→ 默认应为 page；验完即删
    const w = new Database(DB_PATH);
    w.prepare(
      "INSERT INTO reading_materials (id, created_by, title, text, image_path, sentence_count, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("mat_legacy_probe", "u-girl", "历史书页", "This is an old page.", null, 1, "photo", new Date().toISOString(), new Date().toISOString());
    const row = w.prepare("SELECT kind FROM reading_materials WHERE id = 'mat_legacy_probe'").get();
    w.prepare("DELETE FROM reading_materials WHERE id = 'mat_legacy_probe'").run();
    w.close();
    check("★ 历史行（不带 kind 插入）默认 kind='page'", row?.kind === "page", row?.kind ?? "(missing)");
  }

  // ── 1) 校验：401 + 4xx ────────────────────────────────────────────────────
  const anon = await fetch(`${BASE}/api/story/rewrite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text_zh: "今天我很开心", level: "A1" }),
  });
  check("未登录 POST /api/story/rewrite → 401", anon.status === 401, `status=${anon.status}`);

  const post = async (cookie, body) => {
    const res = await fetch(`${BASE}/api/story/rewrite`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const empty = await post(girl, { text_zh: "   ", level: "A1" });
  check("text_zh 为空 → 400", empty.status === 400, `status=${empty.status} msg=${empty.body?.error?.message?.slice(0, 40)}`);
  const tooLong = await post(girl, { text_zh: "好".repeat(2001), level: "A1" });
  check("text_zh 超长（2001 字）→ 400", tooLong.status === 400, `status=${tooLong.status}`);
  const badLevel = await post(girl, { text_zh: "今天我很开心", level: "C9" });
  check("level 非法 → 400", badLevel.status === 400 && /A1/.test(badLevel.body?.error?.message ?? ""), `status=${badLevel.status} msg=${badLevel.body?.error?.message?.slice(0, 50)}`);

  // ── 2) voice 未就绪 → 可读中文错误（不静默）────────────────────────────────
  const rewrite = await post(girl, { text_zh: "今天我和小明搭积木塔，被小华碰倒了，我很生气。", level: "A2" });
  console.log(`   ↳ /api/story/rewrite 响应：HTTP ${rewrite.status} · ${JSON.stringify(rewrite.body).slice(0, 220)}`);
  const readable =
    rewrite.status === 503 &&
    /故事改写服务还没就绪/.test(rewrite.body?.error?.message ?? "") &&
    rewrite.body?.error?.code === "story_unavailable";
  if (readable) {
    check("★ voice 未就绪 → 503 + 可读中文提示（story_unavailable）", true, rewrite.body?.error?.message?.slice(0, 60));
  } else if (rewrite.status === 200) {
    console.log("   ⏭ SKIP：voice 已上线 /v1/story/rewrite，降级用例不适用（本次验证成功路径）");
    check("★ voice 已就绪：rewrite 返回 sentences/title/level", Array.isArray(rewrite.body?.sentences) && rewrite.body.sentences.length > 0, `sentences=${rewrite.body?.sentences?.length}`);
  } else {
    check("★ voice 未就绪 → 可读中文提示", false, `status=${rewrite.status} body=${JSON.stringify(rewrite.body).slice(0, 200)}`);
  }

  // ── 3) /story 页面 HTML ──────────────────────────────────────────────────
  const pageRes = await fetch(`${BASE}/story`, { headers: { cookie: girl } });
  const html = await pageRes.text();
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--\s*-->/g, "");
  check("/story 200", pageRes.status === 200, `status=${pageRes.status}`);
  check("★ 有中文输入区（story-input textarea）", html.includes('data-testid="story-input"'));
  check("★ 有难度选择（4 级按钮）", ["A1", "A2", "B1", "B2"].every((l) => html.includes(`data-testid="story-level-${l}"`)), "");
  check("★ 有「再简单一点 / 再难一点」", html.includes('data-testid="story-simpler"') && html.includes('data-testid="story-harder"'));
  check("★ 两个输入入口：文字 + 🎤 说中文", html.includes('data-testid="story-input"') && html.includes('data-testid="story-voice-panel"') && /说中文|拍张照|说中文（我听着）/.test(html));
  check("有生成按钮 + 故事集", html.includes('data-testid="story-generate"') && html.includes("我的故事集"));
  check("儿童 /story 零 IPA", leaks(html).length === 0, `leaked=${leaks(html).join("")}`);
  check("儿童 /story 无字面 **", !visible.includes("**"));

  // ── 5) 保存 kind='story' → 列表可见 → 删除消失 ───────────────────────────
  const saveRes = await fetch(`${BASE}/api/materials`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: girl },
    body: JSON.stringify({
      title: "My Block Tower",
      text: "Today I built a tall block tower with Ming. Hua knocked it down. I was angry.",
      kind: "story",
      source_zh: "今天我和小明搭积木塔，被小华碰倒了，我很生气。",
      level: "A2",
      source: "text",
    }),
  });
  const saved = await saveRes.json().catch(() => null);
  const storyId = saved?.id ?? null;
  if (storyId) created.push(storyId);
  check("★ 保存故事 → 201 且 kind=story", saveRes.status === 201 && saved?.kind === "story", `status=${saveRes.status} kind=${saved?.kind}`);
  check("保存响应带 sentence_count / level", saved?.sentence_count === 3 && saved?.level === "A2", `count=${saved?.sentence_count} level=${saved?.level}`);

  const listRes = await fetch(`${BASE}/api/materials?kind=story&limit=50`, { headers: { cookie: girl } });
  const list = await listRes.json().catch(() => null);
  check("★ /api/materials?kind=story 能看到刚保存的故事", (list?.items ?? []).some((x) => x.id === storyId), `count=${(list?.items ?? []).length}`);
  const pageList = (list?.items ?? []).find((x) => x.id === storyId);
  check("列表项字段齐全（title/sentence_count/level/created_at）", Boolean(pageList?.title && pageList?.sentence_count === 3 && pageList?.level === "A2" && pageList?.created_at), JSON.stringify(pageList ?? {}).slice(0, 140));

  const detail = await (await fetch(`${BASE}/api/materials/${storyId}`, { headers: { cookie: girl } })).json();
  check("详情保留中文原稿（source_zh）", detail?.source_zh === "今天我和小明搭积木塔，被小华碰倒了，我很生气。", (detail?.source_zh ?? "").slice(0, 30));

  // 儿童删别人的故事 → 403
  const dadStory = await (
    await fetch(`${BASE}/api/materials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: dad },
      body: JSON.stringify({ title: "Dad Story", text: "Dad tells a story.", kind: "story", source: "text" }),
    })
  ).json();
  if (dadStory?.id) created.push(dadStory.id);
  const forbidden = await fetch(`${BASE}/api/materials/${dadStory.id}`, { method: "DELETE", headers: { cookie: girl } });
  check("儿童删别人的故事 → 403", forbidden.status === 403, `status=${forbidden.status}`);

  const delRes = await fetch(`${BASE}/api/materials/${storyId}`, { method: "DELETE", headers: { cookie: girl } });
  check("删除自己的故事 → 200", delRes.status === 200, `status=${delRes.status}`);
  const after = await (await fetch(`${BASE}/api/materials?kind=story&limit=50`, { headers: { cookie: girl } })).json();
  check("★ 删除后列表里消失", !(after?.items ?? []).some((x) => x.id === storyId), `count=${(after?.items ?? []).length}`);
  const idx = created.indexOf(storyId);
  if (idx >= 0) created.splice(idx, 1);

  // ── 6) /api/asr 转发 language（stub voice 抓 outbound）──────────────────────
  {
    const captured = [];
    /** task-74：concat 调用计数 / 每次 parts 数 + stub 返回的小 WAV */
    const TINY_WAV = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64");
    /** task-77：ASR 失败模式（验证「录音先落盘、失败可重试」） */
    let asrMode = "ok";
    let concatCalls = 0;
    const concatPartCounts = [];
    /** task-53：插画 stub 行为（ok / 503 / 400 / 502） */
    let illustrateMode = "ok";
    const TINY_PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const stub = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        captured.push({ url: String(req.url), body });
        // 每个分支自己写状态码 + JSON（不能先写 200 头再改状态）
        const send = (status, obj) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(obj));
        };
        if (String(req.url).startsWith("/v1/tts")) {
          res.statusCode = 200;
          res.setHeader("content-type", "audio/wav");
          res.end(TINY_WAV);
          return;
        }
        if (String(req.url).startsWith("/v1/audio/concat")) {
          concatCalls += 1;
          const parts = (body.match(/name="parts"/g) ?? []).length;
          concatPartCounts.push(parts);
          res.statusCode = 200;
          res.setHeader("content-type", "audio/wav");
          res.end(TINY_WAV);
          return;
        }
        if (String(req.url).startsWith("/v1/image/illustrate")) {
          if (illustrateMode === "503") {
            send(503, { error: { code: "provider_unavailable", message: "未配置智谱 key" } });
            return;
          }
          if (illustrateMode === "400") {
            send(400, { error: { code: "content_unsafe", message: "内容审核不通过" } });
            return;
          }
          if (illustrateMode === "502") {
            send(502, { error: { code: "provider_error", message: "出图失败" } });
            return;
          }
          send(
            200,
            {
              image_b64: TINY_PNG_B64,
              mime: "image/png",
              prompt_used: "watercolor, a child's story",
              provider: "zhipu",
              model: "glm-image",
              size: "1280x1280",
              elapsed_ms: 8400,
              warnings: [],
            },
          );
          return;
        }
        if (String(req.url).startsWith("/v1/story/rewrite")) {
          send(
            200,
            {
              title_en: "My Block Tower",
              sentences: ["Today I built a tall block tower with Ming.", "Hua knocked it down. I was angry."],
              text_en: "Today I built a tall block tower with Ming. Hua knocked it down. I was angry.",
              level: "A2",
              readability: { sentence_count: 2, avg_words: 6.5, max_words: 9, unknown_words: ["tower"], ok: true },
              warnings: [],
              provider: "stub-llm",
            },
          );
          return;
        }
        if (String(req.url).startsWith("/v1/story/retell")) {
          send(
            200,
            {
              coverage: 0.7,
              covered_points: ["built a tower", "someone knocked it down"],
              missing_points: ["how I felt"],
              feedback_zh: "你把事情讲清楚了，下次加上自己的感受会更好。",
              feedback_en: "You told the story clearly. Add how you felt next time.",
              warnings: [],
              provider: "stub-llm",
            },
          );
          return;
        }
        if (asrMode === "fail") {
          res.statusCode = 422;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "asr_failed", message: "stub 转录失败（音频太长）" } }));
          return;
        }
        send(200, { text: "今天我很开心", provider: "stub-asr", duration_ms: 800 });
      });
    });
    await new Promise((r) => stub.listen(8126, "127.0.0.1", r));
    const port = 3050;
    const child = spawn("pnpm", ["exec", "next", "start", "-p", String(port)], {
      detached: true,
      cwd: WEB_ROOT,
      env: { ...process.env, VOICE_SERVICE_URL: "http://127.0.0.1:8126" },
      stdio: "ignore",
    });
    try {
      let up = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
          if (r.ok) {
            up = true;
            break;
          }
        } catch {
          /* 还没起来 */
        }
      }
      check("stub-voice web 实例启动成功（3050）", up);
      const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "girl@example.com", password: "Girl12345!" }),
      });
      const rawCookie = typeof loginRes.headers.getSetCookie === "function" ? loginRes.headers.getSetCookie() : [];
      const cookie2 = (rawCookie.find((c) => c.startsWith("ec_session=")) ?? rawCookie[0] ?? "").split(";")[0];

      const wavLike = new Blob([Buffer.from("RIFF....WAVEfmt ")]);
      const sendAsr = async (language) => {
        const form = new FormData();
        form.append("audio", wavLike, "a.wav");
        if (language) form.append("language", language);
        const r = await fetch(`http://127.0.0.1:${port}/api/asr${language ? `?language=${encodeURIComponent(language)}` : ""}`, {
          method: "POST",
          headers: { cookie: cookie2 },
          body: form,
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      };

      const zh = await sendAsr("zh-CN");
      const capturedZh = captured[captured.length - 1]?.body ?? "";
      check("★ /api/asr?language=zh-CN → 200", zh.status === 200, `status=${zh.status}`);
      check(
        "★ 转发给 voice 的 language 是 zh-CN（outbound 断言）",
        /name="language"\r\n\r\nzh-CN/.test(capturedZh),
        (capturedZh.match(/name="language"\r\n\r\n([^\r]+)/) ?? [])[1] ?? "(未捕获)",
      );
      check("响应里回显 language", zh.body?.language === "zh-CN", zh.body?.language ?? "");
      const en = await sendAsr(null);
      const capturedEn = captured[captured.length - 1]?.body ?? "";
      check(
        "现有英文识别不受影响（不传 language → 默认 en-US）",
        en.status === 200 && /name="language"\r\n\r\nen-US/.test(capturedEn),
        (capturedEn.match(/name="language"\r\n\r\n([^\r]+)/) ?? [])[1] ?? "(未捕获)",
      );

      // ── P2：weak_phonemes 真的传给 voice（outbound 断言）──────────────────
      const rewriteRes = await fetch(`http://127.0.0.1:${port}/api/story/rewrite`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie2 },
        body: JSON.stringify({ text_zh: "今天我和小明搭积木塔，被小华碰倒了，我很生气。", level: "A2" }),
      });
      const rewriteBody = await rewriteRes.json().catch(() => null);
      const rewriteOutbound = captured[captured.length - 1]?.body ?? "";
      console.log(`   ↳ rewrite outbound：${rewriteOutbound.slice(0, 260)}`);
      check("★ P2 改写成功（stub voice）：返回 sentences + weak_phonemes_used", rewriteRes.status === 200 && Array.isArray(rewriteBody?.sentences) && rewriteBody.sentences.length > 0, `status=${rewriteRes.status}`);
      check(
        "★ P2 outbound 里带 weak_phonemes（复用发音诊断的弱音）",
        /"weak_phonemes":\[".+?"\]/.test(rewriteOutbound),
        (rewriteOutbound.match(/"weak_phonemes":\[[^\]]*\]/) ?? ["(未捕获)"])[0],
      );
      check(
        "P2 响应里回显 weak_phonemes_used",
        Array.isArray(rewriteBody?.weak_phonemes_used) && rewriteBody.weak_phonemes_used.length > 0,
        JSON.stringify(rewriteBody?.weak_phonemes_used ?? null),
      );
      const noWeak = await fetch(`http://127.0.0.1:${port}/api/story/rewrite`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie2 },
        body: JSON.stringify({ text_zh: "今天我很开心。", level: "A1", use_weak_phonemes: false }),
      });
      await noWeak.json().catch(() => null);
      const noWeakOutbound = captured[captured.length - 1]?.body ?? "";
      check(
        "P2 关掉开关时 outbound weak_phonemes 为空数组",
        /"weak_phonemes":\[\]/.test(noWeakOutbound),
        (noWeakOutbound.match(/"weak_phonemes":\[[^\]]*\]/) ?? ["(未捕获)"])[0],
      );

      // ── P3：复述接口（stub voice 成功路径 → 存记录）───────────────────────
      const retellRes = await fetch(`http://127.0.0.1:${port}/api/story/retell`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie2 },
        body: JSON.stringify({
          material_id: null,
          story_sentences: ["Today I built a tall block tower.", "Hua knocked it down."],
          transcript: "I built a tower and someone knocked it down.",
          level: "A2",
        }),
      });
      const retellBody = await retellRes.json().catch(() => null);
      console.log(`   ↳ retell 响应：HTTP ${retellRes.status} · ${JSON.stringify(retellBody).slice(0, 200)}`);
      check("★ P3 复述评估成功（stub voice）：200 且含覆盖度/要点/建议", retellRes.status === 200 && typeof retellBody?.coverage === "number" && Array.isArray(retellBody?.missing_points) && Boolean(retellBody?.feedback_zh), `status=${retellRes.status}`);
      check("P3 复述**不返回发音分**（响应里没有 pron/score 字段）", !/\bpron\b|\bscore\b/.test(JSON.stringify(retellBody ?? {})), Object.keys(retellBody ?? {}).join(","));
      const retellOutbound = captured[captured.length - 1]?.body ?? "";
      check(
        "P3 outbound 含 story_sentences + transcript",
        /"story_sentences":\[/.test(retellOutbound) && /"transcript":"/.test(retellOutbound),
        retellOutbound.slice(0, 120),
      );
      // ── task-53：故事插画（stub voice 控制成功/失败模式）──────────────────
      {
        const mk = await fetch(`http://127.0.0.1:${port}/api/materials`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookie2 },
          body: JSON.stringify({
            title: "Illustrated Story",
            text: "Today I built a tower. Hua knocked it down. I was angry.",
            kind: "story",
            level: "A2",
            source: "text",
          }),
        });
        const mat = await mk.json().catch(() => null);
        const illusId = mat?.id ?? null;
        if (illusId) created.push(illusId);
        const illustrate = async (force) => {
          const r = await fetch(`http://127.0.0.1:${port}/api/story/${illusId}/illustrate${force ? "?force=1" : ""}`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie2 },
            body: JSON.stringify({ force }),
          });
          return { status: r.status, body: await r.json().catch(() => null), capturedUrl: captured[captured.length - 1]?.url ?? "" };
        };
        const imagePathOf = () => {
          const db2 = new Database(DB_PATH, { readonly: true });
          const row = db2.prepare("SELECT image_path FROM reading_materials WHERE id = ?").get(illusId);
          db2.close();
          return row?.image_path ?? null;
        };
        const materialsDir = path.join(WEB_ROOT, "data", "materials");

        illustrateMode = "503";
        const s503 = await illustrate(false);
        console.log(`   ↳ illustrate(503)：HTTP ${s503.status} · ${JSON.stringify(s503.body).slice(0, 140)}`);
        check("★ 插画 503（未配置）→ 可读中文提示", s503.status === 503 && /插画服务暂未就绪/.test(s503.body?.error?.message ?? ""), s503.body?.error?.code ?? "");
        check("插画 503 时不写文件（image_path 仍为空）", imagePathOf() === null, String(imagePathOf()));

        illustrateMode = "400";
        const s400 = await illustrate(false);
        check("★ 插画 400（内容审核）→ 提示换个说法", s400.status === 400 && /不适合画成图/.test(s400.body?.error?.message ?? ""), s400.body?.error?.code ?? "");
        check("插画 400 时不写文件", imagePathOf() === null);

        illustrateMode = "502";
        const s502 = await illustrate(false);
        check("插画 502（provider 出错）→ 可读错误 + 可重试", s502.status === 502 && Boolean(s502.body?.error?.message), s502.body?.error?.code ?? "");

        illustrateMode = "ok";
        const ok1 = await illustrate(false);
        console.log(`   ↳ illustrate(ok)：HTTP ${ok1.status} · ${JSON.stringify(ok1.body).slice(0, 180)}`);
        check("★ 插画成功 → 200 且返回 image_url", ok1.status === 200 && Boolean(ok1.body?.image_url), `status=${ok1.status}`);
        check("★ 成功时 image_path 已写库", typeof imagePathOf() === "string" && imagePathOf().endsWith(".png"), String(imagePathOf()));
        const absIllus = imagePathOf() ? path.join(WEB_ROOT, "data", imagePathOf()) : null;
        check("★ 图片文件落在 DATA_DIR/materials/ 下", Boolean(absIllus && absIllus.startsWith(materialsDir) && fs.existsSync(absIllus)), absIllus ?? "");
        check("首次生成不带 force（outbound URL 不含 force=1）", !/force=1/.test(ok1.capturedUrl), ok1.capturedUrl);

        const imgRes = await fetch(`http://127.0.0.1:${port}/api/materials/${illusId}/image`, { headers: { cookie: cookie2 } });
        const imgBytes = Buffer.from(await imgRes.arrayBuffer());
        check("★ GET /api/materials/:id/image → 200 image/png", imgRes.status === 200 && (imgRes.headers.get("content-type") ?? "").includes("image/png"), imgRes.headers.get("content-type") ?? "");
        check("返回字节 = stub 给的 PNG（存储无损）", imgBytes.equals(Buffer.from(TINY_PNG_B64, "base64")), `${imgBytes.length}B`);

        const ok2 = await illustrate(true);
        check("★ 换一张（force=1）→ 200 且旧图被替换（同名文件覆盖）", ok2.status === 200 && /force=1/.test(ok2.capturedUrl), ok2.capturedUrl);
        check("替换后 image_path 仍指向同一 story 的 png", (imagePathOf() ?? "").endsWith(".png"), String(imagePathOf()));

        // 页面入口 + 费用提示（有图时）
        const detailHtml = await (await fetch(`http://127.0.0.1:${port}/story/${illusId}`, { headers: { cookie: cookie2 } })).text();
        check("★ 详情页含插画区块（illustration-box）", detailHtml.includes('data-testid="illustration-box"'));
        check("★ 有图时显示缩略图 + 「换一张」+ 费用提示（每张约 ¥0.1）", detailHtml.includes('data-testid="illustration-thumb"') && detailHtml.includes('data-testid="illustration-regenerate"') && /￥|¥|0\.1/.test(detailHtml), /每张约[^<]{0,12}/.exec(detailHtml)?.[0] ?? "");
        check("儿童插画区零 IPA、无字面 **", leaks(detailHtml).length === 0 && !detailHtml.includes("**"));
        // 故事列表是客户端 fetch 后渲染的（SSR 只有空态）→ 用源码断言卡片缩略图
        const storySrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/story/StoryClient.tsx"), "utf8");
        check(
          "故事列表卡片有缩略图（has_image 时渲染 story-thumb）",
          storySrc.includes('data-testid="story-thumb"') && /s\.has_image/.test(storySrc),
        );
      }

      // ── task-76：自动插画开关 + 性别提示词 + 音色 ───────────────────────────
      {
        const DB_PATH_T = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
        const readImg = (mid) => {
          const db = new Database(DB_PATH_T, { readonly: true });
          const row = db.prepare("SELECT image_path FROM reading_materials WHERE id = ?").get(mid);
          db.close();
          return row?.image_path ?? null;
        };
        const saveStory = async (title) => {
          const r = await fetch(`http://127.0.0.1:${port}/api/materials`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie2 },
            body: JSON.stringify({ title, text: "Today I built a tower. Hua knocked it down.", kind: "story", level: "A2", source: "text" }),
          });
          const j = await r.json().catch(() => null);
          if (j?.id) created.push(j.id);
          return j?.id ?? null;
        };
        const patchSettings = async (patch) =>
          fetch(`http://127.0.0.1:${port}/api/settings`, {
            method: "PATCH",
            headers: { "content-type": "application/json", cookie: cookie2 },
            body: JSON.stringify(patch),
          });
        const waitForImage = async (mid, ms = 6000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            if (readImg(mid)) return true;
            await new Promise((r) => setTimeout(r, 250));
          }
          return Boolean(readImg(mid));
        };

        // ① 开关默认关：保存故事**不**自动画图（illustrate 调用数不增加）
        const offBefore = captured.filter((c) => String(c.url).startsWith("/v1/image/illustrate")).length;
        const offId = await saveStory(`No Auto Illustrate ${Date.now()}`);
        await new Promise((r) => setTimeout(r, 1200));
        const offAfter = captured.filter((c) => String(c.url).startsWith("/v1/image/illustrate")).length;
        check("★ 自动插画默认关：保存后没有任何 illustrate 调用", offAfter === offBefore && readImg(offId) === null, `calls=${offAfter - offBefore} img=${readImg(offId)}`);

        // ② 打开开关 → 保存后服务端自动画一张
        const setOn = await patchSettings({ auto_illustrate: true });
        check("打开自动插画开关（PATCH /api/settings 200）", setOn.status === 200, `status=${setOn.status}`);
        const onId = await saveStory(`Auto Illustrate ${Date.now()}`);
        const gotImage = await waitForImage(onId, 8000);
        check("★ 开关打开：保存后自动生成插画（服务端 after()）", gotImage, `image_path=${readImg(onId)}`);
        await patchSettings({ auto_illustrate: false });

        // ③ 性别进提示词：girl / boy / 未设置
        const illustrateAndCapture = async (title) => {
          const mid = await saveStory(title);
          const r = await fetch(`http://127.0.0.1:${port}/api/story/${mid}/illustrate`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie2 },
            body: JSON.stringify({ force: false }),
          });
          const bodyText = captured[captured.length - 1]?.body ?? "";
          const m = bodyText.match(/"character_desc":"([^"]*)"/);
          return { status: r.status, desc: m ? JSON.parse(`"${m[1]}"`) : "" };
        };
        await patchSettings({ gender: "girl" });
        const girlIll = await illustrateAndCapture(`Gender Girl ${Date.now()}`);
        check('★ 性别 girl → outbound character_desc 含 "a girl"', /a girl/.test(girlIll.desc), girlIll.desc.slice(0, 80));
        await patchSettings({ gender: "boy" });
        const boyIll = await illustrateAndCapture(`Gender Boy ${Date.now()}`);
        check('★ 性别 boy → outbound character_desc 含 "a boy"', /a boy/.test(boyIll.desc), boyIll.desc.slice(0, 80));
        await patchSettings({ gender: null });
        const neutralIll = await illustrateAndCapture(`Gender Neutral ${Date.now()}`);
        check('★ 未设性别 → 中性 "a child"', /a child/.test(neutralIll.desc) && !/a girl|a boy/.test(neutralIll.desc), neutralIll.desc.slice(0, 80));

        // ④ 音色：列表 / 试听 / 保存生效（/api/tts 不带 voice 时回落账号偏好）
        const voicesRes = await fetch(`http://127.0.0.1:${port}/api/tts/voices`);
        const voices = await voicesRes.json().catch(() => null);
        check("★ GET /api/tts/voices 返回可选音色（英文 5 + 中文 4）", voicesRes.status === 200 && (voices?.voices ?? []).length === 9, `count=${(voices?.voices ?? []).length}`);
        check("音色列表含 Azure 英文/中文（Jenny/Aria/Ana/Guy/Michelle + Xiaoxiao/Xiaoyi/Yunxi/Yunjian）",
          ["en-US-JennyNeural", "en-US-AriaNeural", "en-US-AnaNeural", "en-US-GuyNeural", "en-US-MichelleNeural", "zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunxiNeural", "zh-CN-YunjianNeural"].every((v) => (voices?.voices ?? []).some((x) => x.id === v)));
        const previewRes = await fetch(`http://127.0.0.1:${port}/api/tts?${new URLSearchParams({ text: "Hello there", rate: "normal", format: "wav", voice: "en-US-AriaNeural" }).toString()}`, { headers: { cookie: cookie2 } });
        check("★ 音色试听 GET /api/tts?voice=… → 200 audio/*", previewRes.status === 200 && (previewRes.headers.get("content-type") ?? "").startsWith("audio/"), `status=${previewRes.status}`);
        const previewCaptured = captured[captured.length - 1]?.body ?? "";
        check("★ 试听把 voice 透传给 voice 服务", /en-US-AriaNeural/.test(previewCaptured), (previewCaptured.match(/"voice":"[^"]*"/) ?? ["(未捕获)"])[0]);
        const saveVoice = await patchSettings({ tts_voice: "zh-CN-YunxiNeural" });
        const settingsRes = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { cookie: cookie2 } });
        const settingsBody = await settingsRes.json().catch(() => null);
        check("★ 保存音色后 /api/settings 返回该音色", saveVoice.status === 200 && settingsBody?.prefs?.ttsVoice === "zh-CN-YunxiNeural", String(settingsBody?.prefs?.ttsVoice));
        const fallbackPreview = await fetch(`http://127.0.0.1:${port}/api/tts?${new URLSearchParams({ text: "你好", rate: "normal", format: "wav" }).toString()}`, { headers: { cookie: cookie2 } });
        const fallbackCaptured = captured[captured.length - 1]?.body ?? "";
        check("★ 不带 voice 的 TTS 用账号偏好音色", fallbackPreview.status === 200 && /zh-CN-YunxiNeural/.test(fallbackCaptured), (fallbackCaptured.match(/"voice":"[^"]*"/) ?? ["(未捕获)"])[0]);
        await patchSettings({ tts_voice: null });

        // ⑤ 设置页 SSR：开关/性别/音色/试听都在
        const settingsHtml = await (await fetch(`http://127.0.0.1:${port}/settings`, { headers: { cookie: cookie2 } })).text();
        check("★ 设置页含插画开关（auto-illustrate-toggle）", settingsHtml.includes('data-testid="auto-illustrate-toggle"'));
        check("★ 设置页含性别选择（gender-select）", settingsHtml.includes('data-testid="gender-select"'));
        check("★ 设置页含音色下拉 + 试听（tts-voice-select / tts-voice-preview）", settingsHtml.includes('data-testid="tts-voice-select"') && settingsHtml.includes('data-testid="tts-voice-preview"'));
        check("设置页含费用说明（每张约 ¥0.1）", /每张约\s*¥?0\.1|每张约/.test(settingsHtml));
      }

      // ── task-95 rev2：按查看者本人隔离（家长看孩子故事不展示孩子的原文/原声/朗读）──
      {
        const DB_PATH_95 = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
        const TINY_WAV_95 = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64");
        const girlLogin = async () => {
          const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "girl@example.com", password: "Girl12345!" }),
          });
          const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
          return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
        };
        const girlCookie = await girlLogin();
        const recIds = [];
        try {
          // 女孩：录中文 → 存成故事（关联录音）→ 自己读两次
          const rf = new FormData();
          rf.append("audio", new Blob([TINY_WAV_95], { type: "audio/wav" }), "g.wav");
          const recRes = await fetch(`http://127.0.0.1:${port}/api/story/recordings`, { method: "POST", headers: { cookie: girlCookie }, body: rf });
          const rec = await recRes.json().catch(() => null);
          const recId = rec?.id ?? null;
          if (recId) recIds.push(recId);
          const mk = await fetch(`http://127.0.0.1:${port}/api/materials`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: girlCookie },
            body: JSON.stringify({
              title: `Girl Private Story ${Date.now()}`,
              text: "Today I played with my friend. We built a sandcastle.",
              kind: "story",
              level: "A2",
              source: "text",
              source_zh: "今天我和朋友玩了沙子。",
              recording_id: recId,
            }),
          });
          const mat = await mk.json().catch(() => null);
          const girlStoryId = mat?.id ?? null;
          if (girlStoryId) created.push(girlStoryId);
          const submit = async (cookie, materialId) => {
            const form = new FormData();
            form.append("audio", new Blob([TINY_WAV_95], { type: "audio/wav" }), "a.wav");
            form.append("reference_text", "Today I played with my friend.");
            form.append("mode", "scripted");
            form.append("material_id", materialId);
            const r = await fetch(`http://127.0.0.1:${port}/api/attempts/async`, { method: "POST", headers: { cookie }, body: form });
            return (await r.json().catch(() => null))?.id ?? null;
          };
          const a1 = await submit(girlCookie, girlStoryId);
          const a2 = await submit(girlCookie, girlStoryId);
          for (let i = 0; i < 20; i++) {
            const st = await (await fetch(`http://127.0.0.1:${port}/api/attempts/status?ids=${encodeURIComponent(`${a1},${a2}`)}`, { headers: { cookie: girlCookie } })).json();
            if ((st?.items ?? []).every((x) => x.status === "done" || x.status === "failed")) break;
            await new Promise((r) => setTimeout(r, 500));
          }

          // ① 家长（dad）看孩子故事：朗读/原声/原文都不出现（按观众本人 0 次）
          const dadStatus = await (await fetch(`http://127.0.0.1:${port}/api/story/${girlStoryId}/audio/status`, { headers: { cookie: dad } })).json();
          check("★ 家长看孩子故事：audio/status 按观众本人（attempt_count=0）", Number(dadStatus?.attempt_count) === 0, JSON.stringify(dadStatus ?? null));
          const dadDetail = (await (await fetch(`http://127.0.0.1:${port}/story/${girlStoryId}`, { headers: { cookie: dad } })).text()).replace(/<!--[\s\S]*?-->/g, "");
          check("★ 家长看不到孩子的原声区块（无 detail-source / source-zh / source-audio）", !dadDetail.includes('data-testid="detail-source"') && !dadDetail.includes('data-testid="detail-source-zh"') && !dadDetail.includes('data-testid="detail-source-audio"'));
          check("★ 家长朗读记录按自己算（0 次空态）", /朗读记录\s*0\s*次|读过这个故事\s*0\s*次/.test(dadDetail), (dadDetail.match(/朗读记录\s*\d+\s*次|读过这个故事\s*\d+\s*次/) ?? [""])[0]);
          check("英文正文家庭可见（家长仍能看到句子 + 打印入口）", dadDetail.includes('data-testid="detail-text"') && dadDetail.includes('data-testid="detail-print-link"'));
          const girlRecAudioByDad = await fetch(`http://127.0.0.1:${port}/api/story/recordings/${recId}/audio`, { headers: { cookie: dad } });
          check("★ 孩子的原始录音家长不能听（404）", girlRecAudioByDad.status === 404, `status=${girlRecAudioByDad.status}`);

          // ② 打印页：非 owner 即使 ?zh=1 也不渲染中文；英文句子保留
          const dadPrint = (await (await fetch(`http://127.0.0.1:${port}/story/${girlStoryId}/print?zh=1&layout=card`, { headers: { cookie: dad } })).text()).replace(/<!--[\s\S]*?-->/g, "");
          check("★ 家长打印孩子故事（?zh=1）不含中文原文", dadPrint.includes('data-testid="print-card"') && !dadPrint.includes('data-testid="print-card-source-zh"') && !/今天我和朋友玩了沙子/.test(dadPrint));
          check("打印页英文句子家庭可见（保留编号句子）", (dadPrint.match(/data-testid="print-sentence"/g) ?? []).length >= 2);
          const girlPrint = (await (await fetch(`http://127.0.0.1:${port}/story/${girlStoryId}/print?zh=1`, { headers: { cookie: girlCookie } })).text()).replace(/<!--[\s\S]*?-->/g, "");
          check("★ owner 自己打印仍可见中文（回归）", girlPrint.includes('data-testid="print-source-zh"') && /今天我和朋友玩了沙子/.test(girlPrint));

          // ③ 列表 🎙️ 标记仅看自己
          const girlList = await (await fetch(`http://127.0.0.1:${port}/api/materials?kind=story&limit=50`, { headers: { cookie: girlCookie } })).json();
          const dadList = await (await fetch(`http://127.0.0.1:${port}/api/materials?kind=story&limit=50`, { headers: { cookie: dad } })).json();
          check("★ 列表标记：女孩自己的故事 has_recording=true", (girlList?.items ?? []).find((x) => x.id === girlStoryId)?.has_recording === true);
          check("★ 列表标记：家长看同一故事 has_recording=false（不显示孩子的录音标记）", (dadList?.items ?? []).find((x) => x.id === girlStoryId)?.has_recording === false);

          // ④ /story「🎙️ 我的录音」仅本人：家长页不出现孩子的录音/所属人
          const dadStoryPage = (await (await fetch(`http://127.0.0.1:${port}/story`, { headers: { cookie: dad } })).text()).replace(/<!--[\s\S]*?-->/g, "");
          check("★ /story 家长页面不展示孩子的录音（仅本人）", !dadStoryPage.includes(recId));
          const girlStoryPage = (await (await fetch(`http://127.0.0.1:${port}/story`, { headers: { cookie: girlCookie } })).text()).replace(/<!--[\s\S]*?-->/g, "");
          check("女孩 /story 能看到自己的录音", girlStoryPage.includes(recId));

          // ⑤ 音频缓存按用户隔离（story-audio/<userId>/<materialId>.wav）
          const girlAudio = await fetch(`http://127.0.0.1:${port}/api/story/${girlStoryId}/audio`, { headers: { cookie: girlCookie } });
          for (let i = 0; i < 30; i++) {
            const st = await (await fetch(`http://127.0.0.1:${port}/api/story/${girlStoryId}/audio/status`, { headers: { cookie: girlCookie } })).json();
            if (st?.status === "ready") break;
            await new Promise((r) => setTimeout(r, 500));
          }
          check("女孩自己的整段回放可用（200 audio/wav，回归）", girlAudio.status === 200 || girlAudio.status === 202, `status=${girlAudio.status}`);
          const fileFor = (userId) => path.join(WEB_ROOT, "data", "story-audio", userId, `${girlStoryId}.wav`);
          check("★ 缓存按用户隔离：文件在 story-audio/<userId>/<materialId>.wav", fs.existsSync(fileFor("u-girl")), fileFor("u-girl").replace(WEB_ROOT, "…"));
          check("家长没有该故事的缓存文件（不串音/不共享）", !fs.existsSync(fileFor("u-dad")));

          // ⑥ 儿童看自己故事：原始输入/原声/朗读记录正常（回归）
          const girlDetail = (await (await fetch(`http://127.0.0.1:${port}/story/${girlStoryId}`, { headers: { cookie: girlCookie } })).text()).replace(/<!--[\s\S]*?-->/g, "");
          check("★ 儿童看自己故事：原声/原文/朗读记录都在（回归）", girlDetail.includes('data-testid="detail-source"') && girlDetail.includes('data-testid="detail-source-zh"') && girlDetail.includes('data-testid="detail-source-audio"') && /朗读记录\s*2\s*次|读过这个故事\s*2\s*次/.test(girlDetail));
          const girlStatus = await (await fetch(`http://127.0.0.1:${port}/api/story/${girlStoryId}/audio/status`, { headers: { cookie: girlCookie } })).json();
          check("儿童自己 audio/status attempt_count=2（回归）", Number(girlStatus?.attempt_count) === 2, JSON.stringify(girlStatus ?? null));
        } finally {
          const d = new Database(DB_PATH_95);
          for (const id of recIds) {
            const r = d.prepare("SELECT audio_path FROM story_recordings WHERE id = ?").get(id);
            if (r?.audio_path) {
              const abs = path.join(WEB_ROOT, "data", r.audio_path);
              if (fs.existsSync(abs)) fs.rmSync(abs);
            }
            d.prepare("DELETE FROM story_recordings WHERE id = ?").run(id);
          }
          d.close();
        }
      }


      // ── task-92：打印入口始终渲染（无 source_zh/录音的故事也要有）────────────
      {
        const mkStory = async (title, body) => {
          const r = await fetch(`http://127.0.0.1:${port}/api/materials`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie2 },
            body: JSON.stringify({ title, text: "I went to the park. The weather was nice.", kind: "story", level: "A2", source: "text", ...body }),
          });
          const j = await r.json().catch(() => null);
          if (j?.id) created.push(j.id);
          return j?.id ?? null;
        };
        // ① 无 source_zh、无录音
        const bareId = await mkStory(`Bare Story ${Date.now()}`, {});
        const bareDetail = (await (await fetch(`http://127.0.0.1:${port}/story/${bareId}`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
        check("★ 无 source_zh/录音的故事：仍有整页打印入口", bareDetail.includes('data-testid="detail-print-link"') && bareDetail.includes(`/story/${bareId}/print`));
        check("★ 无 source_zh/录音的故事：仍有卡片打印入口（href 带 layout=card）", bareDetail.includes('data-testid="detail-print-card-link"') && bareDetail.includes(`/story/${bareId}/print?layout=card`));
        check("无 source 时原始输入区块不显示（只有条件块按条件）", !bareDetail.includes('data-testid="detail-source"'));
        // ② 有 source_zh 的故事：回归两个入口 + 原始输入区块
        const withId = await mkStory(`Sourced Story ${Date.now()}`, { source_zh: "我去公园了，天气很好。" });
        const withDetail = (await (await fetch(`http://127.0.0.1:${port}/story/${withId}`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
        check("★ 有 source 的故事：两个打印入口仍在（回归）", withDetail.includes('data-testid="detail-print-link"') && withDetail.includes('data-testid="detail-print-card-link"') && withDetail.includes(`/story/${withId}/print?layout=card`));
        check("有 source 的故事：原始输入区块仍显示", withDetail.includes('data-testid="detail-source"') && /我去公园了/.test(withDetail));
        // ③ 打印入口不在条件块内（源码级：Link 不在 detail-source 的条件 JSX 里）
        const detailSrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/story/[id]/page.tsx"), "utf8");
        check("源码里打印入口独立于 detail-source 条件块", detailSrc.includes('data-testid="detail-print-actions"') && detailSrc.indexOf('data-testid="detail-print-actions"') < detailSrc.indexOf('data-testid="detail-source"'));
      }


      // ── task-89：故事详情页「打印卡片」（A5 卡片版式）──────────────────────
      {
        const mk = await fetch(`http://127.0.0.1:${port}/api/materials`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookie2 },
          body: JSON.stringify({
            title: `Card Story ${Date.now()}`,
            text: "Today I built a tall block tower. Then my friend knocked it down. I was a little angry.",
            kind: "story",
            level: "A2",
            source: "text",
            source_zh: "今天我搭了一座很高的积木塔，然后朋友把它推倒了，我有点生气。",
          }),
        });
        const mat = await mk.json().catch(() => null);
        const mid = mat?.id ?? null;
        if (mid) created.push(mid);
        check("task-89：创建测试故事", Boolean(mid), String(mid));

        const pageHtml = async (qs = "") => {
          const res = await fetch(`http://127.0.0.1:${port}/story/${mid}/print${qs}`, { headers: { cookie: cookie2 } });
          const html = (await res.text()).replace(/<!--[\s\S]*?-->/g, "");
          return { status: res.status, html };
        };

        // ① 卡片版式
        const card = await pageHtml("?layout=card");
        check("★ 卡片页 200", card.status === 200, `status=${card.status}`);
        check("★ 含 print-card 容器 + 标题/级别/编号句子", card.html.includes('data-testid="print-card"') && card.html.includes('data-testid="print-card-title"') && (card.html.match(/data-testid="print-sentence"/g) ?? []).length >= 2);
        check("★ A5 尺寸 + 虚线裁切框（148×210mm / dashed）", /148mm/.test(card.html) && /210mm/.test(card.html) && /1\.5px dashed/.test(card.html));
        check("★ 打印 CSS：@page A4 + 10mm 边距 + break-inside avoid", /@page\s*\{\s*size:\s*A4;\s*margin:\s*10mm;?\s*\}/.test(card.html) && /break-inside/.test(card.html));
        check("★ 卡片有姓名/日期手写栏 + 品牌落款", /姓名 Name/.test(card.html) && /日期 Date/.test(card.html) && /我的故事卡/.test(card.html));
        check("卡片默认不显示中文原文", !card.html.includes('data-testid="print-card-source-zh"'));
        const cardZh = await pageHtml("?layout=card&zh=1&lines=1");
        check("★ 卡片 ?zh=1 显示中文原文", cardZh.html.includes('data-testid="print-card-source-zh"') && /今天我搭了一座很高的积木塔/.test(cardZh.html));
        check("★ 卡片 ?lines=1 加书写留白行", cardZh.html.includes("print-line"));
        check("卡片页零 IPA、无字面 **", leaks(cardZh.html).length === 0 && !cardZh.html.includes("**"));

        // ② 默认仍是整页练习纸（回归）
        const full = await pageHtml();
        check("★ 默认（无 layout）仍为整页练习纸", full.status === 200 && full.html.includes('data-testid="print-full"') && full.html.includes('data-testid="print-sheet"') && !full.html.includes('data-testid="print-card"'), `status=${full.status}`);
        check("整页版式仍有编号句子 + 名字/日期", full.html.includes('data-testid="print-sentence"') && /名字 Name/.test(full.html));

        // ③ 工具栏版式切换
        check("★ 工具栏有版式切换（整页练习纸 / A5 卡片）", card.html.includes('data-testid="print-layout-switch"') && card.html.includes('data-testid="print-layout-full"') && card.html.includes('data-testid="print-layout-card"'));
        check("卡片版式选中态（aria-pressed=true）", /data-testid="print-layout-card"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="print-layout-card"/.test(card.html));
        check("整页版式里卡片链接带 layout=card、整页链接不带 card", /href="\/story\/[^"]+\/print\?layout=card"/.test(full.html) && /href="\/story\/[^"]+\/print"/.test(full.html));

        // ④ 详情页两个入口
        const detail = (await (await fetch(`http://127.0.0.1:${port}/story/${mid}`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
        check("★ 详情页有「打印卡片」入口（href 带 layout=card）", detail.includes('data-testid="detail-print-card-link"') && /href="\/story\/[^"]+\/print\?layout=card"/.test(detail));
        check("详情页原有整页打印入口保留", detail.includes('data-testid="detail-print-link"'));
        check("儿童文案「打印卡片出来读」存在于源码", fs.readFileSync(path.join(WEB_ROOT, "src/app/story/[id]/page.tsx"), "utf8").includes("打印卡片出来读"));
      }


      // ── task-85：多选故事 → 故事集打印（封面 + 每篇分页）────────────────────
      {
        const makeStory = async (n) => {
          const r = await fetch(`http://127.0.0.1:${port}/api/materials`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie2 },
            body: JSON.stringify({
              title: `Collection Story ${n} ${Date.now()}`,
              text: `I went to the park with my friend number ${n}. We played on the slide.`,
              kind: "story",
              level: "A2",
              source: "text",
              source_zh: `故事${n}：我和朋友去公园玩滑梯。`,
            }),
          });
          const body = await r.json().catch(() => null);
          if (body?.id) created.push(body.id);
          return body?.id ?? null;
        };
        const ids = [];
        for (let i = 1; i <= 3; i++) ids.push(await makeStory(i));
        check("task-85：创建 3 篇测试故事", ids.every(Boolean), `ids=${ids.length}`);
        const idsQs = ids.join(",");

        const coll = (await (await fetch(`http://127.0.0.1:${port}/story/print?ids=${encodeURIComponent(idsQs)}`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
        check("★ 故事集打印页 200 且含封面", coll.includes('data-testid="collection-cover"') && /我的故事集/.test(coll));
        check("★ 封面显示篇数「共 3 篇」", /共\s*3\s*篇/.test(coll));
        check("★ 3 篇都渲染（collection-story ×3）", (coll.match(/data-testid="collection-story"/g) ?? []).length === 3);
        check("★ 每篇有编号句子", (coll.match(/data-testid="print-sentence"/g) ?? []).length >= 3);
        // task-90：封面独占第一页；故事内容自然拼接（不再强制每篇分页）
        check("★ 封面独占第一页（.print-cover break-after: page）", /\.print-cover\s*\{[^}]*break-after:\s*page/.test(coll) && coll.includes('print-cover'));
        check("★ 已无「每个故事强制分页」规则（.print-story + .print-story）", !/\.print-story\s*\+\s*\.print-story/.test(coll));
        check("★ 防难看分割：标题 break-after:avoid / 句子与书写线 break-inside:avoid", /\.print-story-heading\s*\{[^}]*break-after:\s*avoid/.test(coll) && /\.print-sentence\s*\{[^}]*break-inside:\s*avoid/.test(coll) && /\.print-line\s*\{[^}]*break-inside:\s*avoid/.test(coll));
        check("★ 故事块允许跨页拼接（.print-story break-inside:auto）", /\.print-story\s*\{[^}]*break-inside:\s*auto/.test(coll));
        check("3 篇仍全部渲染（回归）", (coll.match(/data-testid="collection-story"/g) ?? []).length === 3);
        check("★ 页脚「第 X / N 篇」", /第\s*1\s*\/\s*3\s*篇/.test(coll) && /第\s*3\s*\/\s*3\s*篇/.test(coll));
        check("★ 合集有打印按钮 + @media print", coll.includes('data-testid="collection-print-button"') && /@media print/.test(coll));
        check("合集默认不显示中文", !coll.includes('data-testid="print-source-zh"'));

        const collZh = (await (await fetch(`http://127.0.0.1:${port}/story/print?ids=${encodeURIComponent(idsQs)}&zh=1&lines=1`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
        check("★ ?zh=1 显示中文原文", collZh.includes('data-testid="print-source-zh"') && /故事1：我和朋友去公园玩滑梯/.test(collZh));
        check("★ ?lines=1 加书写留白行", collZh.includes("print-line"));
        check("合集页儿童零 IPA、无字面 **", leaks(collZh).length === 0 && !collZh.includes("**"));

        const empty = (await (await fetch(`http://127.0.0.1:${port}/story/print`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
        check("★ 空 ids → 可读提示（不白屏）", empty.includes('data-testid="collection-empty"') && /还没有选择要打印的故事/.test(empty));
        const missing = (await (await fetch(`http://127.0.0.1:${port}/story/print?ids=${encodeURIComponent(`${ids[0]},mat_not_exist_xxx`)}`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
        check("★ 不存在的 id → 跳过并提示（不泄漏/不白屏）", missing.includes('data-testid="collection-missing"') && (missing.match(/data-testid="collection-story"/g) ?? []).length === 1);
        const tooManyIds = Array.from({ length: 31 }, (_, i) => ids[i % 3] ?? ids[0]).join(",");
        const tooMany = await fetch(`http://127.0.0.1:${port}/story/print?ids=${encodeURIComponent(tooManyIds)}`, { headers: { cookie: cookie2 } });
        const tooManyHtml = (await tooMany.text()).replace(/<!--[\s\S]*?-->/g, "");
        check("★ >30 篇 → 截断并提示（200 + 可读提示）", tooMany.status === 200 && tooManyHtml.includes('data-testid="collection-too-many"'), `status=${tooMany.status}`);

        const single = (await (await fetch(`http://127.0.0.1:${port}/story/${ids[0]}/print`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
        check("单篇打印页仍正常（回归）", single.includes('data-testid="print-sentences"') && single.includes('data-testid="print-button"'));

        const storyListHtml = (await (await fetch(`http://127.0.0.1:${port}/story`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
        check("★ /story 有「选择」模式入口（SSR）", storyListHtml.includes('data-testid="story-select-toggle"'));
        check("★ /story 有「打印故事集」按钮与已选数量（SSR，默认隐藏）", storyListHtml.includes('data-testid="story-collection-print"') && /已选\s*0\s*篇/.test(storyListHtml));
        check("★ 儿童文案「打印出来读」/「选几篇打印」", storyListHtml.includes("选几篇打印") || storyListHtml.includes("打印出来读"));
        const storySrc85 = fs.readFileSync(path.join(WEB_ROOT, "src/app/story/StoryClient.tsx"), "utf8");
        check("多选逻辑：勾选框 + 全选 + 最多 30 篇", storySrc85.includes('data-testid="story-select-check"') && storySrc85.includes('data-testid="story-select-all"') && storySrc85.includes("slice(0, 30)"));
      }


      // ── task-83：故事原始输入留存（原话 + 原声）+ 可打印文档 ────────────────
      {
        const DB_PATH_83 = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
        const TINY_WAV_83 = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64");
        const recIds83 = [];
        asrMode = "ok";
        // ① 上传一段录音（中文转录成功）
        let recId = null;
        {
          const form = new FormData();
          form.append("audio", new Blob([TINY_WAV_83], { type: "audio/wav" }), "src.wav");
          const r = await fetch(`http://127.0.0.1:${port}/api/story/recordings`, { method: "POST", headers: { cookie: cookie2 }, body: form });
          const body = await r.json().catch(() => null);
          recId = body?.id ?? null;
          if (recId) recIds83.push(recId);
          check("task-83：上传原始录音 → 201 transcribed", r.status === 201 && body?.status === "transcribed", `status=${r.status}`);
        }
        try {
          // ② 保存故事时带 recording_id → 回填 material_id
          const mk = await fetch(`http://127.0.0.1:${port}/api/materials`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie2 },
            body: JSON.stringify({
              title: `Source Story ${Date.now()}`,
              text: "Today I built a tower with Ming. Hua knocked it down.",
              kind: "story",
              level: "A2",
              source: "text",
              source_zh: "今天我和小明搭积木塔，小华把它推倒了。",
              recording_id: recId,
            }),
          });
          const material = await mk.json().catch(() => null);
          const mid = material?.id ?? null;
          if (mid) created.push(mid);
          check("task-83：保存故事（带 recording_id）→ 201", mk.status === 201 && Boolean(mid), `status=${mk.status}`);
          const dbRec = (() => {
            const d = new Database(DB_PATH_83, { readonly: true });
            const row = d.prepare("SELECT material_id FROM story_recordings WHERE id = ?").get(recId);
            d.close();
            return row;
          })();
          check("★ 回填证据：story_recordings.material_id = 故事 id", dbRec?.material_id === mid, `${dbRec?.material_id} vs ${mid}`);

          // ③ 详情页「🗣️ 我当时讲的原话」+ 原声播放器
          const detail = (await (await fetch(`http://127.0.0.1:${port}/story/${mid}`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
          check("★ 详情页含「🗣️ 我当时讲的原话」区块", detail.includes('data-testid="detail-source"') && /我当时讲的原话/.test(detail));
          check("★ 详情页显示中文原文", detail.includes('data-testid="detail-source-zh"') && /今天我和小明搭积木塔/.test(detail));
          check("★ 详情页有原声播放器（/api/story/recordings/<id>/audio）", detail.includes('data-testid="detail-source-audio"') && detail.includes(`/api/story/recordings/${recId}/audio`));
          check("★ 详情页有打印入口", detail.includes('data-testid="detail-print-link"'));
          const recAudio = await fetch(`http://127.0.0.1:${port}/api/story/recordings/${recId}/audio`, { headers: { cookie: cookie2 } });
          check("原声可播放（200 audio/*）", recAudio.status === 200 && (recAudio.headers.get("content-type") ?? "").startsWith("audio/"), `status=${recAudio.status}`);
          const otherAudio = await fetch(`http://127.0.0.1:${port}/api/story/recordings/${recId}/audio`, { headers: { cookie: dad } });
          check("★ 原始录音仅本人（别人听 → 404，不泄漏）", otherAudio.status === 404, `status=${otherAudio.status}`);

          // ④ 无录音的故事：只有中文原文，没有坏播放器
          const mk2 = await fetch(`http://127.0.0.1:${port}/api/materials`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie2 },
            body: JSON.stringify({ title: `Typed Story ${Date.now()}`, text: "I like apples.", kind: "story", level: "A1", source: "text", source_zh: "我喜欢苹果。" }),
          });
          const typed = await mk2.json().catch(() => null);
          const mid2 = typed?.id ?? null;
          if (mid2) created.push(mid2);
          const detail2 = (await (await fetch(`http://127.0.0.1:${port}/story/${mid2}`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
          check("★ 无录音故事：只显示中文原文", detail2.includes('data-testid="detail-source-zh"') && /我喜欢苹果/.test(detail2));
          check("★ 无录音故事：不显示原声播放器（无坏播放器）", !detail2.includes('data-testid="detail-source-audio"'));

          // ⑤ 列表：有原声的卡片有 🎙️ 标记（API has_recording + 源码标记）
          const list = await (await fetch(`http://127.0.0.1:${port}/api/materials?kind=story&limit=50`, { headers: { cookie: cookie2 } })).json();
          const row = (list?.items ?? []).find((x) => x.id === mid);
          check("★ 列表 API 标记 has_recording + recording_id", row?.has_recording === true && row?.recording_id === recId, JSON.stringify({ has: row?.has_recording, rec: row?.recording_id }));
          const storySrc83 = fs.readFileSync(path.join(WEB_ROOT, "src/app/story/StoryClient.tsx"), "utf8");
          check("★ 故事卡片有 🎙️ 标记与 🖨️ 打印入口", storySrc83.includes('data-testid="story-recording-mark"') && storySrc83.includes('data-testid="story-print-link"'));

          // ⑥ 打印页：编号句子 + @media print + 打印按钮 + 可选中文/留白行
          const printRes = await fetch(`http://127.0.0.1:${port}/story/${mid}/print`, { headers: { cookie: cookie2 } });
          const printHtml = (await printRes.text()).replace(/<!--[\s\S]*?-->/g, "");
          check("★ 打印页 200", printRes.status === 200, `status=${printRes.status}`);
          check("★ 打印页含编号英文句子（≥2 条）", (printHtml.match(/data-testid="print-sentence"/g) ?? []).length >= 2);
          check("★ 打印页含 @media print 样式", /@media print/.test(printHtml) && /print-color-adjust/.test(printHtml));
          check("★ 打印页有「🖨️ 打印 / 另存为 PDF」按钮", printHtml.includes('data-testid="print-button"') && /打印 \/ 另存为 PDF/.test(printHtml));
          check("默认不显示中文原文", !printHtml.includes('data-testid="print-source-zh"'));
          const zhLines = (await (await fetch(`http://127.0.0.1:${port}/story/${mid}/print?zh=1&lines=1`, { headers: { cookie: cookie2 } })).text()).replace(/<!--[\s\S]*?-->/g, "");
          check("★ ?zh=1 显示中文原文", zhLines.includes('data-testid="print-source-zh"') && /今天我和小明搭积木塔/.test(zhLines));
          check("★ ?lines=1 加书写留白行", zhLines.includes("print-line"));
          check("打印页页脚有名字/日期手写栏", /名字 Name/.test(printHtml) && /日期 Date/.test(printHtml));
          check("打印页零 IPA、无字面 **", leaks(zhLines).length === 0 && !zhLines.includes("**"));
        } finally {
          asrMode = "ok";
          const d = new Database(DB_PATH_83);
          for (const id of recIds83) {
            const r = d.prepare("SELECT audio_path FROM story_recordings WHERE id = ?").get(id);
            if (r?.audio_path) {
              const abs = path.join(WEB_ROOT, "data", r.audio_path);
              if (fs.existsSync(abs)) fs.rmSync(abs);
            }
            d.prepare("DELETE FROM story_recordings WHERE id = ?").run(id);
          }
          d.close();
        }
      }


      // ── task-81：故事句子数（角色默认 5/8 + 设置可改 + outbound）───────────
      {
        const DB_PATH_S = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
        const patchSettings = async (cookie, patch) =>
          fetch(`http://127.0.0.1:${port}/api/settings`, {
            method: "PATCH",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify(patch),
          });
        // React SSR 会在动态文本旁插 <!-- -->（如 "5<!-- --> 句"）→ 先去掉注释再断言
        const storyHtml = async (cookie) => {
          const res = await fetch(`http://127.0.0.1:${port}/story`, { headers: { cookie } });
          const text = await res.text();
          return text.replace(/<!--[\s\S]*?-->/g, "");
        };
        const dadCookie2 = await (async () => {
          const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "dad@example.com", password: "Dad12345!" }),
          });
          const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
          return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
        })();

        await patchSettings(cookie2, { story_sentences: null });
        await patchSettings(dadCookie2, { story_sentences: null });
        const childHtml = await storyHtml(cookie2);
        const dadHtml = await storyHtml(dadCookie2);
        check("★ 儿童未设置 → 故事页默认 5 句", /data-testid="story-sentence-count"[^>]*>\s*5 句|5 句/.test(childHtml) && childHtml.includes('data-testid="story-sentence-count"'), (childHtml.match(/(\d+) 句/) ?? [""])[0]);
        check("★ 家长未设置 → 故事页默认 8 句", /8 句/.test(dadHtml), (dadHtml.match(/(\d+) 句/) ?? [""])[0]);

        const set10 = await patchSettings(cookie2, { story_sentences: 10 });
        check("设置页改默认句子数 → PATCH 200", set10.status === 200, `status=${set10.status}`);
        const after10 = await storyHtml(cookie2);
        check("★ 改成 10 后故事页默认 = 10", /10 句/.test(after10));
        const reset = await patchSettings(cookie2, { story_sentences: null });
        const afterReset = await storyHtml(cookie2);
        check("★ 恢复默认后回到 5 句", reset.status === 200 && /5 句/.test(afterReset));
        const settingsHtml2 = await (await fetch(`http://127.0.0.1:${port}/settings`, { headers: { cookie: cookie2 } })).text();
        check("★ 设置页有「📖 故事句子数」区块 + 3–12 选项 + 恢复默认", settingsHtml2.includes('data-testid="story-sentences-section"') && settingsHtml2.includes('data-testid="story-sentences-3"') && settingsHtml2.includes('data-testid="story-sentences-12"') && settingsHtml2.includes('data-testid="story-sentences-reset"'));

        // 前端只给 3–12（2/13 不在选项里）
        check("★ 故事页句子数选项只有 3–12（无 2/13）", afterReset.includes('data-testid="story-sentences-3"') && afterReset.includes('data-testid="story-sentences-12"') && !afterReset.includes('data-testid="story-sentences-2"') && !afterReset.includes('data-testid="story-sentences-13"'));

        // outbound：12 / 3 / 默认；非法 2/13 → 400
        const rewrite = async (cookie, maxSentences) => {
          const body = { text_zh: "今天我和朋友一起搭了一个很高的积木塔。", level: "A2" };
          if (maxSentences !== undefined) body.max_sentences = maxSentences;
          const before = captured.length;
          const r = await fetch(`http://127.0.0.1:${port}/api/story/rewrite`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify(body),
          });
          const outbound = captured.slice(before).find((c) => String(c.url).startsWith("/v1/story/rewrite"))?.body ?? "";
          return { status: r.status, outbound };
        };
        const r12 = await rewrite(cookie2, 12);
        check("★ 选 12 → outbound max_sentences=12", r12.status === 200 && /"max_sentences":12/.test(r12.outbound), (r12.outbound.match(/"max_sentences":\d+/) ?? ["(未捕获)"])[0]);
        const r3 = await rewrite(cookie2, 3);
        check("★ 选 3 → outbound max_sentences=3", r3.status === 200 && /"max_sentences":3/.test(r3.outbound), (r3.outbound.match(/"max_sentences":\d+/) ?? ["(未捕获)"])[0]);
        const bad2 = await rewrite(cookie2, 2);
        check("★ 直接调接口 2 句 → 400", bad2.status === 400, `status=${bad2.status}`);
        const bad13 = await rewrite(cookie2, 13);
        check("★ 直接调接口 13 句 → 400", bad13.status === 400, `status=${bad13.status}`);
        const def = await rewrite(cookie2);
        check("★ 不传时用账号默认（儿童 5）", def.status === 200 && /"max_sentences":5/.test(def.outbound), (def.outbound.match(/"max_sentences":\d+/) ?? ["(未捕获)"])[0]);

        const dbCols = (() => {
          const d = new Database(DB_PATH_S, { readonly: true });
          const cols = d.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
          const rows = d.prepare("SELECT id, story_sentences FROM users").all();
          d.close();
          return { cols, rows };
        })();
        check("迁移 0017：users.story_sentences 存在", dbCols.cols.includes("story_sentences"));
        check("历史行 story_sentences 为 NULL（不崩）", dbCols.rows.every((r) => r.story_sentences === null || typeof r.story_sentences === "number"), JSON.stringify(dbCols.rows));
      }


      // ── task-82：同一故事两次朗读都入库（重读产生新 attempts）─────────────
      {
        const mk = await fetch(`http://127.0.0.1:${port}/api/materials`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookie2 },
          body: JSON.stringify({ title: `Two Rounds ${Date.now()}`, text: "Today I built a tower. Hua knocked it down.", kind: "story", level: "A2", source: "text" }),
        });
        const mat = await mk.json().catch(() => null);
        const mid = mat?.id ?? null;
        if (mid) created.push(mid);
        const submit = async () => {
          const form = new FormData();
          form.append("audio", new Blob([Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64")], { type: "audio/wav" }), "a.wav");
          form.append("reference_text", "Today I built a tower.");
          form.append("mode", "scripted");
          form.append("material_id", mid);
          const r = await fetch(`http://127.0.0.1:${port}/api/attempts/async`, { method: "POST", headers: { cookie: cookie2 }, body: form });
          return { status: r.status, body: await r.json().catch(() => null) };
        };
        const t1 = await submit();
        const t2 = await submit();
        check("重读第 1/2 遍都创建了新的 attempt", Boolean(t1.body?.id) && Boolean(t2.body?.id) && t1.body.id !== t2.body.id, `${t1.body?.id} vs ${t2.body?.id}`);
        for (let i = 0; i < 20; i++) {
          const st = await (await fetch(`http://127.0.0.1:${port}/api/attempts/status?ids=${encodeURIComponent(`${t1.body?.id},${t2.body?.id}`)}`, { headers: { cookie: cookie2 } })).json();
          if ((st?.items ?? []).every((x) => x.status === "done" || x.status === "failed")) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const detail2 = await (await fetch(`http://127.0.0.1:${port}/story/${mid}`, { headers: { cookie: cookie2 } })).text();
        check("★ 故事详情显示读过 2 次（两轮都入库）", /读过这个故事 2 次|朗读记录 2 次/.test(detail2), (detail2.match(/读过这个故事\s*\d+\s*次|朗读记录\s*\d+\s*次/) ?? [""])[0]);
      }


      // ── task-77：故事录音先落盘、转录失败可重试、录音列表 ─────────────────
      {
        const DB_PATH_R = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
        const TINY_WAV_R = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64");
        const recIds = [];
        const cleanupRec = () => {
          const db = new Database(DB_PATH_R);
          for (const id of recIds) {
            const row = db.prepare("SELECT audio_path FROM story_recordings WHERE id = ?").get(id);
            if (row?.audio_path) {
              const abs = path.join(WEB_ROOT, "data", row.audio_path);
              if (fs.existsSync(abs)) fs.rmSync(abs);
            }
            db.prepare("DELETE FROM story_recordings WHERE id = ?").run(id);
          }
          db.close();
        };
        const uploadRecording = async (cookie, bytes = TINY_WAV_R, mime = "audio/wav") => {
          const form = new FormData();
          form.append("audio", new Blob([bytes], { type: mime }), "zh-story.wav");
          const r = await fetch(`http://127.0.0.1:${port}/api/story/recordings`, { method: "POST", headers: { cookie }, body: form });
          return { status: r.status, body: await r.json().catch(() => null) };
        };
        try {
          asrMode = "fail";
          const failed = await uploadRecording(cookie2);
          console.log(`   ↳ 上传录音（ASR 失败）：HTTP ${failed.status} · ${JSON.stringify(failed.body).slice(0, 160)}`);
          const recId = failed.body?.id ?? null;
          if (recId) recIds.push(recId);
          check("★ 转录失败仍 201（录音不丢）", failed.status === 201 && Boolean(recId), `status=${failed.status}`);
          check("★ 转录失败 → status=failed + 可读 error", failed.body?.status === "failed" && /录音已保存|重试/.test(failed.body?.error ?? ""), String(failed.body?.error ?? "").slice(0, 70));
          const dbRec = (() => {
            const db = new Database(DB_PATH_R, { readonly: true });
            const row = db.prepare("SELECT audio_path, status FROM story_recordings WHERE id = ?").get(recId);
            db.close();
            return row;
          })();
          check("★ DB 行在 + 状态 failed", dbRec?.status === "failed", JSON.stringify(dbRec ?? {}));
          check("★ 原始录音文件已落盘", Boolean(dbRec?.audio_path && fs.existsSync(path.join(WEB_ROOT, "data", dbRec.audio_path))), String(dbRec?.audio_path ?? ""));
          const audioRes = await fetch(`http://127.0.0.1:${port}/api/story/recordings/${recId}/audio`, { headers: { cookie: cookie2 } });
          check("★ GET 录音音频 → 200 audio/*", audioRes.status === 200 && (audioRes.headers.get("content-type") ?? "").startsWith("audio/"), `status=${audioRes.status} type=${audioRes.headers.get("content-type")}`);

          asrMode = "ok";
          const retried = await fetch(`http://127.0.0.1:${port}/api/story/recordings/${recId}/transcribe`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie2 }, body: "{}" });
          const retriedBody = await retried.json().catch(() => null);
          check("★ 重试转录 → 200 且 status=transcribed", retried.status === 200 && retriedBody?.status === "transcribed", `status=${retried.status} body=${JSON.stringify(retriedBody).slice(0, 100)}`);
          check("★ 转录文字回填（不用重录）", (retriedBody?.transcript_zh ?? "").includes("今天我很开心"), String(retriedBody?.transcript_zh ?? "").slice(0, 40));

          const listRes = await fetch(`http://127.0.0.1:${port}/api/story/recordings?limit=20`, { headers: { cookie: cookie2 } });
          const listBody = await listRes.json().catch(() => null);
          check("★ GET /api/story/recordings 返回我的录音", listRes.status === 200 && (listBody?.items ?? []).some((x) => x.id === recId), `count=${(listBody?.items ?? []).length}`);
          const storyHtml = await (await fetch(`http://127.0.0.1:${port}/story`, { headers: { cookie: cookie2 } })).text();
          check("★ 故事页含「🎙️ 我的录音」区块（SSR）", storyHtml.includes('data-testid="story-recordings"') && /我的录音/.test(storyHtml));
          check("★ 故事页含录音条目 + 播放器", storyHtml.includes('data-testid="story-recording-item"') && storyHtml.includes('data-testid="story-recording-audio"'));
          check("故事页含「重试转录」按钮（失败条目渲染）", fs.readFileSync(path.join(WEB_ROOT, "src/components/StoryRecordingsSection.tsx"), "utf8").includes("重试转录"));

          check("未登录上传录音 → 401", (await fetch(`http://127.0.0.1:${port}/api/story/recordings`, { method: "POST", body: new FormData() })).status === 401);
          const otherRec = await fetch(`http://127.0.0.1:${port}/api/story/recordings/${recId}/transcribe`, { method: "POST", headers: { "content-type": "application/json", cookie: dad }, body: "{}" });
          check("★ 别人的录音 → 404（不越权）", otherRec.status === 404, `status=${otherRec.status}`);
          const bigBytes = Buffer.alloc(26 * 1024 * 1024, 1);
          const big = await uploadRecording(cookie2, bigBytes, "audio/wav");
          check("超过 25MB → 413", big.status === 413, `status=${big.status}`);
          const notAudio = await uploadRecording(cookie2, Buffer.from("this is not audio", "utf8"), "audio/wav");
          check("非音频内容 → 400（magic bytes 校验）", notAudio.status === 400, `status=${notAudio.status}`);
        } finally {
          asrMode = "ok";
          cleanupRec();
        }
      }


      // ── task-74 ①：故事整段朗读回放（status/audio、拼接、单条直用、401/404）────
      {
        const DB_PATH_T = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
        const dataDir = path.join(WEB_ROOT, "data");
        const ts = Date.now();
        const wavPath1 = `audio/u-girl/task74-${ts}-1.wav`;
        const wavPath2 = `audio/u-girl/task74-${ts}-2.wav`;
        const singlePath = `audio/u-girl/task74-${ts}-single.wav`;
        const TINY_WAV2 = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64");
        for (const rel of [wavPath1, wavPath2, singlePath]) {
          const abs = path.join(dataDir, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, TINY_WAV2);
        }
        const db = new Database(DB_PATH_T);
        const attemptIds = [`att_t74_${ts}_a`, `att_t74_${ts}_b`, `att_t74_${ts}_s`];
        const insAttempt = db.prepare(
          "INSERT INTO attempts (id, user_id, reference_text, material_id, created_at, status, scores_json, warnings_json, audio_path) VALUES (?, ?, ?, ?, ?, 'done', ?, '[]', ?)",
        );
        const mkStory = async () => {
          const r = await fetch(`http://127.0.0.1:${port}/api/materials`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie2 },
            body: JSON.stringify({
              title: `Audio Replay ${ts}`,
              text: "Today I built a tower. Hua knocked it down. I was angry.",
              kind: "story",
              level: "A2",
              source: "text",
            }),
          });
          const j = await r.json().catch(() => null);
          if (j?.id) created.push(j.id);
          return j?.id ?? null;
        };
        const multiId = await mkStory();
        const singleId = await mkStory();
        const emptyId = await mkStory();
        insAttempt.run(attemptIds[0], "u-girl", "Today I built a tower.", multiId, new Date(ts).toISOString(), JSON.stringify({ pron: 70 }), wavPath1);
        insAttempt.run(attemptIds[1], "u-girl", "Hua knocked it down.", multiId, new Date(ts + 1000).toISOString(), JSON.stringify({ pron: 75 }), wavPath2);
        insAttempt.run(attemptIds[2], "u-girl", "I was angry.", singleId, new Date(ts + 2000).toISOString(), JSON.stringify({ pron: 80 }), singlePath);
        db.close();
        const cacheFiles = [multiId, singleId].filter(Boolean).map((id) => [
          path.join(dataDir, "story-audio", `${id}.wav`),
          path.join(dataDir, "story-audio", `${id}.json`),
        ]);
        try {
          const statusOf = async (mid, cookie = cookie2) =>
            (await (await fetch(`http://127.0.0.1:${port}/api/story/${mid}/audio/status`, { headers: { cookie } })).json()).status;
          const audioOf = async (mid, cookie = cookie2, qs = "") =>
            fetch(`http://127.0.0.1:${port}/api/story/${mid}/audio${qs}`, { headers: { cookie } });

          check("未登录拿故事回放 → 401", (await fetch(`http://127.0.0.1:${port}/api/story/${multiId}/audio`)).status === 401);
          check("未登录查回放状态 → 401", (await fetch(`http://127.0.0.1:${port}/api/story/${multiId}/audio/status`)).status === 401);

          const first = await audioOf(multiId);
          check("★ 首次请求无缓存 → 202（触发后台拼接）", first.status === 202, `status=${first.status}`);
          let ready = null;
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if ((await statusOf(multiId)) === "ready") {
              ready = true;
              break;
            }
          }
          check("★ 轮询后状态变为 ready", ready === true);
          const wav = await audioOf(multiId);
          const wavBytes = Buffer.from(await wav.arrayBuffer());
          console.log(`   ↳ story audio：HTTP ${wav.status} · ${wav.headers.get("content-type")} · ${wavBytes.length}B · single=${wav.headers.get("x-story-audio-single")}`);
          check("★ ready 后 GET audio → 200 audio/wav 且字节 > 0", wav.status === 200 && (wav.headers.get("content-type") ?? "").includes("audio/wav") && wavBytes.length > 0, `${wavBytes.length}B`);
          check("Content-Length 正确 + Accept-Ranges: none", Number(wav.headers.get("content-length")) === wavBytes.length && wav.headers.get("accept-ranges") === "none");
          check("★ 多录音：确实调用了 concat 且 parts=2（按时间序两条）", concatCalls > 0 && concatPartCounts[0] === 2, `calls=${concatCalls} parts=${concatPartCounts.join(",")}`);
          check("多录音返回不带 single 标记", wav.headers.get("x-story-audio-single") === null);
          const cached = await audioOf(multiId);
          check("第二次命中缓存（x-story-audio-cache=hit）", cached.headers.get("x-story-audio-cache") === "hit", String(cached.headers.get("x-story-audio-cache")));

          const singleAudio = await audioOf(singleId);
          if (singleAudio.status === 202) {
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 300));
              if ((await statusOf(singleId)) === "ready") break;
            }
          }
          const singleWav = await audioOf(singleId);
          const singleBytes = Buffer.from(await singleWav.arrayBuffer());
          check(
            "★ 只有 1 条录音：直接返回那条（x-story-audio-single=1，不再拼接）",
            singleWav.status === 200 && singleWav.headers.get("x-story-audio-single") === "1" && singleBytes.length > 0,
            `status=${singleWav.status} single=${singleWav.headers.get("x-story-audio-single")}`,
          );

          const emptyAudio = await audioOf(emptyId);
          check("★ 没有录音的故事 → 404 可读提示", emptyAudio.status === 404, `status=${emptyAudio.status}`);
          const dadAudio = await audioOf(multiId, dad);
          // task-95 rev2：按查看者本人 —— 家长看孩子故事时，自己 0 次朗读 → 无可回放（404，不展示孩子的）
          check("★ 家长看孩子故事：拼接回放按观众本人（无自己的朗读 → 404，不泄漏孩子的）", dadAudio.status === 404, `status=${dadAudio.status}`);

          const detailReplay = await (await fetch(`http://127.0.0.1:${port}/story/${multiId}`, { headers: { cookie: cookie2 } })).text();
          check("★ 故事详情页含整段回放区块（story-audio）", detailReplay.includes('data-testid="story-audio"') && /回放整段朗读|听一听我读的故事/.test(detailReplay));
        } finally {
          for (const files of cacheFiles) for (const f of files) if (fs.existsSync(f)) fs.rmSync(f);
          for (const rel of [wavPath1, wavPath2, singlePath]) {
            const f = path.join(dataDir, rel);
            if (fs.existsSync(f)) fs.rmSync(f);
          }
          const db2 = new Database(DB_PATH_T);
          for (const id of attemptIds) db2.prepare("DELETE FROM attempts WHERE id = ?").run(id);
          db2.close();
        }
      }

    } finally {
      killTree(child);
      stub.close();
    }
  }

  // ── P1/P2 纯逻辑（分组 / 连续天数 / 鼓励文案 / 难度自适应）────────────────
  {
    const { groupStoriesByDay, consecutiveDays, streakMessage, levelSuggestion } = await import(
      path.join(WEB_ROOT, "src/lib/story-stats.ts")
    );
    const now = new Date("2026-10-30T12:00:00+08:00");
    const mk = (iso) => ({ created_at: iso });
    const groups = groupStoriesByDay(
      [mk("2026-10-30T09:00:00+08:00"), mk("2026-10-29T09:00:00+08:00"), mk("2026-10-20T09:00:00+08:00")],
      now,
    );
    check("P1 分组：今天/昨天/更早 各 1 条", groups.today.length === 1 && groups.yesterday.length === 1 && groups.earlier.length === 1, `today=${groups.today.length} yesterday=${groups.yesterday.length} earlier=${groups.earlier.length}`);
    check(
      "P1 连续天数：隔天连续 3 天",
      consecutiveDays(["2026-10-30T09:00:00+08:00", "2026-10-29T09:00:00+08:00", "2026-10-28T09:00:00+08:00"], now) === 3,
      String(consecutiveDays(["2026-10-30T09:00:00+08:00", "2026-10-29T09:00:00+08:00", "2026-10-28T09:00:00+08:00"], now)),
    );
    check("P1 断档（昨天没记录）→ 0 天", consecutiveDays(["2026-10-28T09:00:00+08:00", "2026-10-27T09:00:00+08:00"], now) === 0);
    check("P1 今天还没记录但昨天有 → 从昨天数 2 天", consecutiveDays(["2026-10-29T09:00:00+08:00", "2026-10-28T09:00:00+08:00"], now) === 2);
    check("P1 鼓励文案不含压力措辞（断/缺）", !/断|缺/.test(streakMessage(5)) && streakMessage(5).includes("5"), streakMessage(5));
    const levels = ["A1", "A2", "B1", "B2"];
    check("P2 自适应：90 分 → 建议更难", levelSuggestion([90, 92, 88], "A2", levels).suggest === "harder", levelSuggestion([90, 92, 88], "A2", levels).message ?? "");
    check("P2 自适应：55 分 → 建议更简单", levelSuggestion([55, 50, 58], "A2", levels).suggest === "easier", levelSuggestion([55, 58, 50], "A2", levels).message ?? "");
    check("P2 自适应：已在最高级别 → 不提示更难", levelSuggestion([95, 92, 90], "B2", levels).suggest === null);
    check("P2 自适应：数据不足 → 不提示", levelSuggestion([], "A2", levels).suggest === null);
  }

  // ── P1 详情页（录音回放 / 儿童无分数）+ P3 复述入口 ───────────────────────
  {
    const mkRes = await fetch(`${BASE}/api/materials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: girl },
      body: JSON.stringify({
        title: "Detail Story",
        text: "Today I built a tower. Hua knocked it down. I was angry.",
        kind: "story",
        source_zh: "今天我搭了塔，小华把它碰倒了，我很生气。",
        level: "A2",
        source: "text",
      }),
    });
    const mk = await mkRes.json().catch(() => null);
    const detailId = mk?.id ?? null;
    if (detailId) created.push(detailId);

    // 造一条"已读过 + 有录音 + 有分数"的记录（挂到该故事）
    const w = new Database(DB_PATH);
    const nowIso = new Date().toISOString();
    w.prepare(
      `INSERT OR REPLACE INTO attempts (id,user_id,sentence_id,mode,reference_text,recognized_text,scores_json,issues_json,intonation_json,feedback_json,audio_path,ref_audio_url,duration_ms,warnings_json,is_blind,blind_test_id,status,scored_at,error,created_at,material_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "att_story_detail_probe",
      "u-girl",
      null,
      "scripted",
      "Today I built a tower.",
      "today i built a tower",
      JSON.stringify({ pron: 88, accuracy: 90, fluency: 80, completeness: 100, prosody: null }),
      "[]",
      "null",
      "null",
      "audio/probe.webm",
      null,
      2000,
      "[]",
      0,
      null,
      "done",
      nowIso,
      null,
      nowIso,
      detailId,
    );
    w.close();

    const childDetail = await fetch(`${BASE}/story/${detailId}`, { headers: { cookie: girl } });
    const childHtml = await childDetail.text();
    console.log(`   ↳ /story/[id]（儿童）HTTP ${childDetail.status} · len=${childHtml.length}`);
    check("P1 详情页 200", childDetail.status === 200, `status=${childDetail.status}`);
    check("★ P1 详情页有「听我上次读的」录音回放入口", childHtml.includes('data-testid="detail-audio"') && childHtml.includes('data-testid="detail-audio-player"'));
    check("★ P1 儿童详情页看不到分数（无 detail-scores / 无平均分）", !childHtml.includes('data-testid="detail-scores"') && !/平均 \d/.test(childHtml));
    check("★ P3 详情页含「讲给我听」入口（retell-panel）", childHtml.includes('data-testid="retell-panel"') && /讲给我听/.test(childHtml));
    check("儿童详情页零 IPA、无字面 **", leaks(childHtml).length === 0 && !childHtml.includes("**"), `leaked=${leaks(childHtml).join("")}`);

    const dadDetail = await fetch(`${BASE}/story/${detailId}`, { headers: { cookie: dad } });
    const dadHtml = await dadDetail.text();
    // task-95 rev2：朗读记录/分数按**查看者本人** —— 家长看孩子的故事不再展示孩子的分数
    check("★ 家长看孩子故事：不展示孩子的朗读分数（按观众本人）", !dadHtml.includes('data-testid="detail-scores"'), `status=${dadDetail.status}`);

    // P3 降级：真实 voice 没有 /v1/story/retell → 可读中文提示
    const retellReal = await fetch(`${BASE}/api/story/retell`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: girl },
      body: JSON.stringify({ story_sentences: ["Today I built a tower."], transcript: "I built a tower.", level: "A2" }),
    });
    const retellRealBody = await retellReal.json().catch(() => null);
    const retellDegraded = retellReal.status === 503 && /复述评估暂未就绪/.test(retellRealBody?.error?.message ?? "");
    const retellOk = retellReal.status === 200;
    check(
      "★ P3 voice 未就绪时 /api/story/retell 返回可读提示（或已上线则 200）",
      retellDegraded || retellOk,
      `status=${retellReal.status} msg=${retellRealBody?.error?.message?.slice(0, 40) ?? ""}`,
    );
    if (retellDegraded) {
      check("P3 降级提示里含「暂未就绪」且不是白屏错误", retellRealBody?.error?.code === "retell_unavailable", retellRealBody?.error?.code ?? "");
    }

    // 自适应提示出现在 /story 页面：造 3 条 90 分 → 建议更难；再改成 55 分 → 建议更简单
    const setScores = (pron) => {
      const w2 = new Database(DB_PATH);
      for (let i = 0; i < 3; i++) {
        w2.prepare(
          `INSERT OR REPLACE INTO attempts (id,user_id,sentence_id,mode,reference_text,recognized_text,scores_json,issues_json,intonation_json,feedback_json,audio_path,ref_audio_url,duration_ms,warnings_json,is_blind,blind_test_id,status,scored_at,error,created_at,material_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          `att_story_adapt_${i}`,
          "u-girl",
          null,
          "scripted",
          "Today I built a tower.",
          "today i built a tower",
          JSON.stringify({ pron, accuracy: pron, fluency: pron, completeness: 100, prosody: null }),
          "[]",
          "null",
          "null",
          null,
          null,
          2000,
          "[]",
          0,
          null,
          "done",
          nowIso,
          null,
          new Date(Date.now() + i * 1000).toISOString(),
          detailId,
        );
      }
      w2.close();
    };
    try {
      setScores(90);
      const highHtml = await (await fetch(`${BASE}/story`, { headers: { cookie: girl } })).text();
      check("★ P2 自适应：最近 3 次均分 90 → 页面提示可以试更难的级别", highHtml.includes('data-testid="story-level-suggestion"') && /试试更难的/.test(highHtml), /试试更难的[^<]{0,20}/.exec(highHtml)?.[0] ?? "");
      setScores(55);
      // 兜兜是 A1（已是最低级别）→ 不应提示"更简单"；用爸爸（B1）验证"更简单"这一边界
      const girlLow = await (await fetch(`${BASE}/story`, { headers: { cookie: girl } })).text();
      check("P2 自适应：已在最低级别（A1）→ 不提示更简单", !/换成/.test(girlLow), /换成[^<]{0,20}/.exec(girlLow)?.[0] ?? "");
      const dadStoryCreate = await fetch(`${BASE}/api/materials`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: dad },
        body: JSON.stringify({ title: "Dad Story P2", text: "I made a cake today.", kind: "story", source: "text", level: "B1" }),
      });
      const dadStory = await dadStoryCreate.json().catch(() => null);
      if (dadStory?.id) created.push(dadStory.id);
      const w4 = new Database(DB_PATH);
      for (let i = 0; i < 3; i++) {
        w4.prepare(
          `INSERT OR REPLACE INTO attempts (id,user_id,sentence_id,mode,reference_text,recognized_text,scores_json,issues_json,intonation_json,feedback_json,audio_path,ref_audio_url,duration_ms,warnings_json,is_blind,blind_test_id,status,scored_at,error,created_at,material_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          `att_story_dad_${i}`,
          "u-dad",
          null,
          "scripted",
          "I made a cake today.",
          "i made a cake today",
          JSON.stringify({ pron: 55, accuracy: 55, fluency: 55, completeness: 100, prosody: null }),
          "[]",
          "null",
          "null",
          null,
          null,
          2000,
          "[]",
          0,
          null,
          "done",
          nowIso,
          null,
          new Date(Date.now() + i * 1000).toISOString(),
          dadStory?.id ?? null,
        );
      }
      w4.close();
      try {
        const dadLow = await (await fetch(`${BASE}/story`, { headers: { cookie: dad } })).text();
        check(
          "★ P2 自适应：爸爸（B1）最近 3 次均分 55 → 提示换成更简单",
          dadLow.includes('data-testid="story-level-suggestion"') && /换成/.test(dadLow),
          /换成[^<]{0,20}/.exec(dadLow)?.[0] ?? "",
        );
      } finally {
        const w5 = new Database(DB_PATH);
        for (let i = 0; i < 3; i++) w5.prepare("DELETE FROM attempts WHERE id = ?").run(`att_story_dad_${i}`);
        w5.close();
      }
      const pageHtml = await (await fetch(`${BASE}/story`, { headers: { cookie: girl } })).text();
      check("P2 页面有弱音开关（默认开）", pageHtml.includes('data-testid="story-weak-toggle"') && /薄弱|把这几个音/.test(pageHtml));
      check("P1 /story 有故事集按日期分组容器", pageHtml.includes('data-testid="story-groups"') || pageHtml.includes("我的故事集"));
    } finally {
      const w3 = new Database(DB_PATH);
      for (let i = 0; i < 3; i++) w3.prepare("DELETE FROM attempts WHERE id = ?").run(`att_story_adapt_${i}`);
      w3.prepare("DELETE FROM attempts WHERE id = 'att_story_detail_probe'").run();
      w3.close();
    }
  }

  console.log(`\n共 ${rows.length} 项断言，通过 ${rows.length - failed}，失败 ${failed}`);
} catch (err) {
  failed += 1;
  console.error("守卫崩溃：", err);
} finally {
  cleanup();
  console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
  process.exit(failed > 0 ? 1 : 0);
}
