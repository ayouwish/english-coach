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
    check("★ P1 家长详情页能看到分数（detail-scores）", dadHtml.includes('data-testid="detail-scores"'), `status=${dadDetail.status}`);

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
