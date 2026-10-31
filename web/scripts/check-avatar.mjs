#!/usr/bin/env node
/**
 * task-62 验收：虚拟形象（拍照/上传 + 5 风格 + 角色卡）+ 插画参考形象 + 提示词可见/反馈。
 *
 * 断言：
 *  1. 未登录 GET/POST /api/avatar → 401；非图片 → 4xx；超大 → 413
 *  2. 假 voice 成功 → 写文件 + users 列更新 + GET /api/avatar 返回（响应不含 voice key）
 *  3. 儿童也能上传自己的形象（允许）
 *  4. PATCH character_desc → 生效 + 清洗（去 <> 尖括号）；超长/非法字段 → 400
 *  5. DELETE → 文件删除 + 列 NULL + GET 返回 null
 *  6. illustrate 转发确实带 character_desc / character_style（假 voice 断言 outbound）
 *  7. 故事详情页含「生成用的提示词」块 + 反馈按钮（prompt-feedback）；儿童零 IPA/无 **
 *  8. 导航栏出现虚拟形象头像（nav-avatar）；迁移 0012 在有数据的库上、历史行 NULL
 *
 * 用法：BASE_URL=http://127.0.0.1:3034 node scripts/check-avatar.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.AVATAR_PORT ?? 3034);
const BASE = (process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const IPAS = ["θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ɑ", "ɒ", "ɛ", "ˈ", "ˌ"];
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let failed = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  rows.push({ ok: Boolean(cond), name });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const leaks = (t) => IPAS.filter((c) => t.includes(c));

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

const createdStories = [];
function cleanup() {
  const db = new Database(DB_PATH);
  for (const id of createdStories) db.prepare("DELETE FROM reading_materials WHERE id = ?").run(id);
  // 清掉测试用户的虚拟形象（文件 + 列）
  for (const uid of ["u-girl", "u-dad"]) {
    const row = db.prepare("SELECT avatar_image_path FROM users WHERE id = ?").get(uid);
    if (row?.avatar_image_path) {
      const abs = path.resolve(WEB_ROOT, "data", row.avatar_image_path);
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch {
        /* ignore */
      }
    }
    db.prepare(
      "UPDATE users SET avatar_image_path=NULL, avatar_style=NULL, avatar_desc=NULL, avatar_prompt=NULL, avatar_updated_at=NULL WHERE id = ?",
    ).run(uid);
  }
  db.close();
}

async function main() {
  console.log(`=== 虚拟形象验收 @ ${BASE} ===`);

  // ── 0) 迁移（有数据）────────────────────────────────────────────────────
  {
    const db = new Database(DB_PATH, { readonly: true });
    const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    const nullAvatar = db.prepare("SELECT COUNT(*) c FROM users WHERE avatar_image_path IS NULL").get().c;
    const users = db.prepare("SELECT COUNT(*) c FROM users").get().c;
    db.close();
    check("迁移 0012：users 有 5 个 avatar_* 列", ["avatar_image_path", "avatar_style", "avatar_desc", "avatar_prompt", "avatar_updated_at"].every((c) => cols.includes(c)), cols.filter((c) => c.startsWith("avatar_")).join(","));
    check("历史行 avatar_image_path 为 NULL（未破坏数据）", nullAvatar === users, `${nullAvatar}/${users}`);
  }

  // ── 1) 未登录 / 非图片 / 超大 ────────────────────────────────────────────
  const anonGet = await getJson("/api/avatar");
  check("★ 未登录 GET /api/avatar → 401", anonGet.status === 401, `status=${anonGet.status}`);
  const anonPost = await fetch(`${BASE}/api/avatar`, { method: "POST", body: new FormData() });
  check("★ 未登录 POST /api/avatar → 401", anonPost.status === 401, `status=${anonPost.status}`);

  const girlCookie = await login("girl@example.com", "Girl12345!");
  const dadCookie = await login("dad@example.com", "Dad12345!");
  check("stub 实例可登录（儿童 + 家长）", Boolean(girlCookie) && Boolean(dadCookie));

  const postAvatar = async (cookie, file, style, type, name) => {
    const form = new FormData();
    form.append("photo", new Blob([file], { type }), name);
    form.append("style", style);
    const res = await fetch(`${BASE}/api/avatar`, { method: "POST", headers: { cookie }, body: form });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const fakeJpg = Buffer.from("this is not really an image", "utf8");
  const notImage = await postAvatar(girlCookie, fakeJpg, "watercolor", "image/jpeg", "fake.jpg");
  check("★ 非图片内容 → 4xx（magic bytes 校验）", notImage.status >= 400 && notImage.status < 500, `status=${notImage.status} msg=${notImage.body?.error?.message?.slice(0, 40)}`);
  const bigPng = Buffer.alloc(11 * 1024 * 1024, 1);
  const tooBig = await postAvatar(girlCookie, bigPng, "watercolor", "image/png", "big.png");
  check("超大照片（>10MB）→ 413", tooBig.status === 413, `status=${tooBig.status}`);
  const badStyle = await postAvatar(girlCookie, TINY_PNG, "oil-painting", "image/png", "a.png");
  check("非法风格 → 400", badStyle.status === 400, `status=${badStyle.status}`);

  // ── 2) 儿童也能生成（假 voice 成功）──────────────────────────────────────
  const ok = await postAvatar(girlCookie, TINY_PNG, "cartoon", "image/png", "me.png");
  console.log(`   ↳ POST /api/avatar（儿童）：HTTP ${ok.status} · ${JSON.stringify(ok.body).slice(0, 220)}`);
  check("★ 儿童生成虚拟形象 → 200", ok.status === 200 && Boolean(ok.body?.avatar_url), `status=${ok.status}`);
  check("返回风格/角色卡/提示词", ok.body?.style === "cartoon" && Boolean(ok.body?.character_desc) && Boolean(ok.body?.prompt_used), JSON.stringify(ok.body?.character_desc ?? "").slice(0, 80));
  check("响应不含 voice 原始 key（image_b64 等）", !("image_b64" in (ok.body ?? {})) && !/image_b64/.test(JSON.stringify(ok.body ?? {})), Object.keys(ok.body ?? {}).join(","));

  const avatarFile = (() => {
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare("SELECT avatar_image_path FROM users WHERE id = 'u-girl'").get();
    db.close();
    return row?.avatar_image_path ?? null;
  })();
  check("★ 图片落盘到 DATA_DIR/avatars/ 下", Boolean(avatarFile && avatarFile.startsWith("avatars/") && fs.existsSync(path.join(WEB_ROOT, "data", avatarFile))), avatarFile ?? "");
  const imgRes = await fetch(`${BASE}/api/avatar/image`, { headers: { cookie: girlCookie } });
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());
  check("★ GET /api/avatar/image → 200 image/png 且字节一致", imgRes.status === 200 && (imgRes.headers.get("content-type") ?? "").includes("image/png") && imgBytes.equals(TINY_PNG), `status=${imgRes.status} ${imgBytes.length}B`);

  const state = await getJson("/api/avatar", girlCookie);
  check("★ GET /api/avatar 返回当前形象（style/desc/prompt）", state.status === 200 && state.json?.style === "cartoon" && Boolean(state.json?.character_desc) && Boolean(state.json?.prompt_used), JSON.stringify(state.json ?? {}).slice(0, 160));

  // ── 3) PATCH character_desc（只有它可改）────────────────────────────────
  const patchOk = await fetch(`${BASE}/api/avatar`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: girlCookie },
    body: JSON.stringify({ character_desc: "我女儿，短发，戴红框眼镜 <script>alert(1)</script>" }),
  });
  const patchBody = await patchOk.json().catch(() => null);
  check("★ PATCH character_desc → 生效", patchOk.status === 200 && /戴红框眼镜/.test(patchBody?.character_desc ?? ""), JSON.stringify(patchBody?.character_desc ?? "").slice(0, 80));
  check("★ 注入字符被清洗（不含尖括号）", !/[<>]/.test(patchBody?.character_desc ?? ""), patchBody?.character_desc ?? "");
  const patchOther = await fetch(`${BASE}/api/avatar`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: girlCookie },
    body: JSON.stringify({ style: "pixel" }),
  });
  check("★ PATCH 只允许 character_desc（改 style → 400）", patchOther.status === 400, `status=${patchOther.status}`);
  const patchLong = await fetch(`${BASE}/api/avatar`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: girlCookie },
    body: JSON.stringify({ character_desc: "长".repeat(2001) }),
  });
  check("超长 character_desc → 400", patchLong.status === 400, `status=${patchLong.status}`);

  // ── 4) illustrate 带虚拟形象参考（假 voice 断言 outbound）───────────────
  {
    const mk = await fetch(`${BASE}/api/materials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: girlCookie },
      body: JSON.stringify({
        title: "Avatar Ref Story",
        text: "Today I played with my friend. We built a sandcastle.",
        kind: "story",
        level: "A2",
        source: "text",
      }),
    });
    const mat = await mk.json().catch(() => null);
    const sid = mat?.id ?? null;
    if (sid) createdStories.push(sid);
    const illus = await fetch(`${BASE}/api/story/${sid}/illustrate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: girlCookie },
      body: JSON.stringify({ force: false }),
    });
    const illusBody = await illus.json().catch(() => null);
    console.log(`   ↳ illustrate：HTTP ${illus.status} · ${JSON.stringify(illusBody).slice(0, 200)}`);
    check("★ 插画生成成功（假 voice）", illus.status === 200 && Boolean(illusBody?.image_url), `status=${illus.status}`);
    check("★ 提示词回传（供页面展示/反馈）", typeof illusBody?.prompt_used === "string" && illusBody.prompt_used.length > 0, String(illusBody?.prompt_used ?? "").slice(0, 80));
    check("响应标注是否用了虚拟形象", typeof illusBody?.character_used === "boolean", String(illusBody?.character_used));
    // outbound（stub 捕获的 /v1/image/illustrate body）
    const captured = globalThis.__AVATAR_CAPTURED ?? [];
    const last = [...captured].reverse().find((c) => String(c.url).startsWith("/v1/image/illustrate"));
    const body = last?.body ?? "";
    check("★ illustrate outbound 带 character_desc（虚拟形象角色卡）", /"character_desc":"[^"]+"/.test(body), (body.match(/"character_desc":"[^"]*"/) ?? ["(未捕获)"])[0].slice(0, 100));
    check("★ illustrate outbound 带 character_style", /"character_style":"[^"]+"/.test(body), (body.match(/"character_style":"[^"]*"/) ?? ["(未捕获)"])[0]);

    // ── 5) 故事详情页：提示词块 + 反馈按钮 + 儿童零 IPA ──────────────────
    const detail = await fetch(`${BASE}/story/${sid}`, { headers: { cookie: girlCookie } });
    const html = await detail.text();
    check("故事详情页 200", detail.status === 200, `status=${detail.status}`);
    check("★ 含「生成用的提示词」折叠块", html.includes('data-testid="image-prompt-block"') && /生成用的提示词/.test(html));
    check("★ 含提示词反馈按钮（复用提建议弹窗）", html.includes('data-testid="prompt-feedback"') && /这个提示词有点问题/.test(html));
    check("儿童详情页零 IPA、无字面 **", leaks(html).length === 0 && !html.includes("**"), `leaked=${leaks(html).join("")}`);
  }

  // ── 6) DELETE 清空 ─────────────────────────────────────────────────────
  {
    const del = await fetch(`${BASE}/api/avatar`, { method: "DELETE", headers: { cookie: girlCookie } });
    check("★ DELETE /api/avatar → 200", del.status === 200, `status=${del.status}`);
    const after = await getJson("/api/avatar", girlCookie);
    check("★ 清空后 GET 返回 null 形象", after.status === 200 && after.json?.avatar_url === null && after.json?.style === null, JSON.stringify(after.json ?? {}).slice(0, 100));
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare("SELECT avatar_image_path, avatar_style, avatar_desc, avatar_prompt FROM users WHERE id = 'u-girl'").get();
    db.close();
    check("★ 清空后列全部 NULL", !row?.avatar_image_path && !row?.avatar_style && !row?.avatar_desc && !row?.avatar_prompt, JSON.stringify(row ?? {}));
    check("★ 清空后图片文件被删除", !avatarFile || !fs.existsSync(path.join(WEB_ROOT, "data", avatarFile)), avatarFile ?? "");
  }

  // ── 7) 导航栏头像（设置后出现）─────────────────────────────────────────
  {
    // 用爸爸再生成一个，验证 nav-avatar 在 SSR HTML 里出现
    const dadOk = await postAvatar(dadCookie, TINY_PNG, "watercolor", "image/png", "dad.png");
    check("家长生成虚拟形象 → 200", dadOk.status === 200, `status=${dadOk.status}`);
    const chat = await (await fetch(`${BASE}/chat`, { headers: { cookie: dadCookie } })).text();
    check("★ 导航栏用户区显示虚拟形象头像（nav-avatar）", chat.includes('data-testid="nav-avatar"') && /\/api\/avatar\/image/.test(chat));
    const settings = await (await fetch(`${BASE}/settings`, { headers: { cookie: dadCookie } })).text();
    check("★ /settings 含「我的虚拟形象」区块（5 个风格卡片）", settings.includes('data-testid="avatar-section"') && ["watercolor", "cartoon", "pixel", "papercut", "clay"].every((s) => settings.includes(`data-testid="avatar-style-${s}"`)));
    const dadView = await getJson("/api/avatar", dadCookie);
    check("爸爸的形象独立（与女儿互不影响）", dadView.json?.style === "watercolor", String(dadView.json?.style));
  }

  console.log(`\n共 ${rows.length} 项断言，通过 ${rows.length - failed}，失败 ${failed}`);
}

// ── stub voice：avatar / illustrate / health ────────────────────────────────
const captured = [];
globalThis.__AVATAR_CAPTURED = captured;
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    captured.push({ url: String(req.url), body });
    const send = (status, obj) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };
    if (String(req.url).startsWith("/v1/health")) {
      send(200, { status: "ok", version: "stub", mode: "mock", providers: {}, capabilities: { phoneme_level: true, intonation_curve: true, ocr: false } });
      return;
    }
    if (String(req.url).startsWith("/v1/image/avatar")) {
      send(200, {
        image_b64: TINY_PNG.toString("base64"),
        mime: "image/png",
        prompt_used: "watercolor portrait of a 7-year-old girl with short hair and red glasses",
        character_desc: "7 岁女孩，短发，戴红框眼镜",
        style: "cartoon",
        provider: "stub",
      });
      return;
    }
    if (String(req.url).startsWith("/v1/image/illustrate")) {
      send(200, {
        image_b64: TINY_PNG.toString("base64"),
        mime: "image/png",
        prompt_used: "watercolor illustration of a child building a sandcastle, character: 7 岁女孩，短发，戴红框眼镜",
        character_used: true,
        provider: "stub",
        model: "glm-image",
        size: "1280x1280",
        elapsed_ms: 8400,
        warnings: [],
      });
      return;
    }
    send(404, { error: { code: "not_found", message: "stub: no route" } });
  });
});

try {
  await new Promise((r) => stub.listen(8138, "127.0.0.1", r));
  const child = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
    cwd: WEB_ROOT,
    env: { ...process.env, VOICE_SERVICE_URL: "http://127.0.0.1:8138" },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* retry */
      }
    }
    check("stub-voice web 实例启动成功", up);
    if (up) await main();
    else failed += 1;
  } finally {
    child.kill("SIGTERM");
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
