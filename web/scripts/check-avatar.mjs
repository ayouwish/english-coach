#!/usr/bin/env node
/**
 * task-64 验收：虚拟形象改为**预置形象选择题**（8 角色 × 5 风格，不上传照片）。
 *
 * 断言：
 *  1. GET /api/avatar/presets → 200，含 5 风格 + 8 角色；图片路径可访问（200 image/png）
 *  2. 儿童/家长 `POST /api/avatar {preset_id,style}` → **200 且 <1s（不生成图片）**；GET /api/avatar 一致
 *  3. 非法 preset_id/style → 400；`style=realistic|photo|写实` → **400**（硬拒绝写实）
 *  4. 旧 multipart 照片上传 → **403 policy_disabled**
 *  5. /settings HTML：**不含拍照/上传入口**、含「不用上传照片，选一个就好」+ 风格卡片 + 角色网格
 *  6. 选完形象后 illustrate outbound 带该角色的 character_desc / avatar_style（假 voice 断言）
 *  7. 迁移 0013 在有数据的库上执行、历史行 NULL；DELETE 清空但不删预置静态图；PATCH 描述仍可用
 *
 * 用法：node scripts/check-avatar.mjs（脚本自己起 stub voice + 独立 web 实例）
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.AVATAR_PORT ?? 3037);
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
const postJson = async (pathname, body, cookie) => {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, ms: Date.now() - t0, json: await res.json().catch(() => null) };
};

const createdStories = [];
function cleanup() {
  const db = new Database(DB_PATH);
  for (const id of createdStories) db.prepare("DELETE FROM reading_materials WHERE id = ?").run(id);
  for (const uid of ["u-girl", "u-dad"]) {
    db.prepare(
      "UPDATE users SET avatar_preset_id=NULL, avatar_image_path=NULL, avatar_style=NULL, avatar_desc=NULL, avatar_prompt=NULL, avatar_updated_at=NULL WHERE id = ?",
    ).run(uid);
  }
  db.close();
}

async function main() {
  console.log(`=== 预置形象选择题验收 @ ${BASE} ===`);

  // ── 0) 迁移（有数据）────────────────────────────────────────────────────
  {
    const db = new Database(DB_PATH, { readonly: true });
    const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    const users = db.prepare("SELECT COUNT(*) c FROM users").get().c;
    const nullPresets = db.prepare("SELECT COUNT(*) c FROM users WHERE avatar_preset_id IS NULL").get().c;
    db.close();
    check("迁移 0013：users 有 avatar_preset_id", cols.includes("avatar_preset_id"), cols.filter((c) => c.includes("preset")).join(","));
    check("历史行 avatar_preset_id 为 NULL（未破坏数据）", nullPresets === users, `${nullPresets}/${users}`);
  }

  // ── 1) 预置库 + 图片可访问 ───────────────────────────────────────────────
  const anonPresets = await getJson("/api/avatar/presets");
  check("★ 未登录 GET /api/avatar/presets → 401", anonPresets.status === 401, `status=${anonPresets.status}`);
  const girlCookie = await login("girl@example.com", "Girl12345!");
  const dadCookie = await login("dad@example.com", "Dad12345!");
  check("stub 实例可登录（儿童 + 家长）", Boolean(girlCookie) && Boolean(dadCookie));

  const presets = await getJson("/api/avatar/presets", girlCookie);
  console.log(`   ↳ presets：HTTP ${presets.status} · styles=${presets.json?.styles?.length} characters=${presets.json?.characters?.length} placeholder=${presets.json?.placeholder}`);
  check("★ GET /api/avatar/presets → 200", presets.status === 200, `status=${presets.status}`);
  check("★ 含 5 种风格", (presets.json?.styles ?? []).length === 5, JSON.stringify((presets.json?.styles ?? []).map((s) => s.label_zh)));
  {
    const chars = presets.json?.characters ?? [];
    check("★ 含 12 个角色（8 儿童 + 4 成人）", chars.length === 12, `count=${chars.length}`);
    const childCount = chars.filter((c) => c.audience === "child").length;
    const adultCount = chars.filter((c) => c.audience === "adult").length;
    check("★ audience 分组正确（8 child / 4 adult）", childCount === 8 && adultCount === 4, `child=${childCount} adult=${adultCount}`);
    check("每个角色 5 张图（按风格）", chars.every((c) => Object.keys(c.images ?? {}).length === 5));
    check("角色含中文名 label_zh", chars.every((c) => Boolean(c.label_zh)));
  }
  check("占位图标记可读（placeholder 明确）", typeof presets.json?.placeholder === "boolean", String(presets.json?.placeholder));
  const c1 = presets.json?.characters?.find((c) => c.id === "c1");
  const imgPath = c1?.images?.watercolor ?? "";
  const imgRes = await fetch(`${BASE}${imgPath}`, { headers: { cookie: girlCookie } });
  check("★ 预置图静态可访问（200 image/png）", imgRes.status === 200 && (imgRes.headers.get("content-type") ?? "").includes("image/png"), `${imgPath} status=${imgRes.status}`);

  // ── 1b) voice 不可用时回退 bundled manifest（离线兜底）─────────────────
  {
    const deadPort = PORT + 10;
    const dead = spawn("pnpm", ["exec", "next", "start", "-p", String(deadPort)], {
      cwd: WEB_ROOT,
      env: { ...process.env, VOICE_SERVICE_URL: "http://127.0.0.1:9" },
      stdio: "ignore",
    });
    try {
      let up = false;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const r = await fetch(`http://127.0.0.1:${deadPort}/api/health`, { signal: AbortSignal.timeout(1500) });
          if (r.ok) {
            up = true;
            break;
          }
        } catch {
          /* retry */
        }
      }
      const res = await fetch(`http://127.0.0.1:${deadPort}/api/avatar/presets`, { headers: { cookie: girlCookie } });
      const body = await res.json().catch(() => null);
      console.log(`   ↳ voice 不可用实例：HTTP ${res.status} · characters=${body?.characters?.length}`);
      check(
        "★ voice 不可用时回退 bundled manifest（仍 200 且 12 角色）",
        up && res.status === 200 && (body?.characters ?? []).length === 12,
        `up=${up} status=${res.status} count=${(body?.characters ?? []).length}`,
      );
    } finally {
      dead.kill("SIGTERM");
    }
  }

  // ── 2) 选择立即生效（<1s，无生成）──────────────────────────────────────
  const choose = await postJson("/api/avatar", { preset_id: "c3", style: "cartoon" }, girlCookie);
  console.log(`   ↳ POST /api/avatar {preset_id:c3, style:cartoon}：HTTP ${choose.status} · ${choose.ms}ms · ${JSON.stringify(choose.json).slice(0, 200)}`);
  check("★ 儿童选择预置形象 → 200", choose.status === 200 && Boolean(choose.json?.avatar_url), `status=${choose.status}`);
  check("★ 立即生效（<1000ms，不生成图片）", choose.ms < 1000, `${choose.ms}ms`);
  check("返回 preset_id / style / character_desc", choose.json?.preset_id === "c3" && choose.json?.style === "cartoon" && Boolean(choose.json?.character_desc), JSON.stringify({ p: choose.json?.preset_id, s: choose.json?.style }).slice(0, 80));
  check("avatar_url 指向静态预置图（不经 voice）", String(choose.json?.avatar_url ?? "").startsWith("/avatars/presets/"), String(choose.json?.avatar_url ?? "").slice(0, 80));

  const state = await getJson("/api/avatar", girlCookie);
  check("★ GET /api/avatar 与选择一致", state.json?.preset_id === "c3" && state.json?.style === "cartoon" && state.json?.avatar_url === choose.json?.avatar_url, JSON.stringify(state.json ?? {}).slice(0, 160));
  const dbRow = (() => {
    const db = new Database(DB_PATH, { readonly: true });
    const r = db.prepare("SELECT avatar_preset_id, avatar_style, avatar_image_path, avatar_desc FROM users WHERE id='u-girl'").get();
    db.close();
    return r;
  })();
  check("★ 库里写入 preset/style/静态图路径/角色描述", dbRow?.avatar_preset_id === "c3" && dbRow?.avatar_style === "cartoon" && String(dbRow?.avatar_image_path ?? "").startsWith("avatars/presets/") && Boolean(dbRow?.avatar_desc), JSON.stringify(dbRow ?? {}).slice(0, 140));

  // 家长也能选（换风格）
  const dadChoose = await postJson("/api/avatar", { preset_id: "c5", style: "pixel" }, dadCookie);
  check("家长也能选择（pixel 风格）", dadChoose.status === 200 && dadChoose.json?.style === "pixel", `status=${dadChoose.status}`);
  // ★ 家长选成人角色（c9–c12）
  const dadAdult = await postJson("/api/avatar", { preset_id: "c10", style: "clay" }, dadCookie);
  check("★ 家长能选成人角色 c10 → 200", dadAdult.status === 200 && dadAdult.json?.preset_id === "c10", `status=${dadAdult.status} preset=${dadAdult.json?.preset_id}`);
  const dadState = await getJson("/api/avatar", dadCookie);
  check("★ GET 与家长选择一致（c10/clay）", dadState.json?.preset_id === "c10" && dadState.json?.style === "clay", JSON.stringify(dadState.json ?? {}).slice(0, 120));

  // ── 3) 合法性与写实硬拒绝 ───────────────────────────────────────────────
  const badPreset = await postJson("/api/avatar", { preset_id: "nope", style: "cartoon" }, girlCookie);
  check("非法 preset_id → 400", badPreset.status === 400, `status=${badPreset.status}`);
  const badStyle = await postJson("/api/avatar", { preset_id: "c1", style: "oil-painting" }, girlCookie);
  check("非法 style → 400", badStyle.status === 400, `status=${badStyle.status}`);
  for (const s of ["realistic", "photo", "写实"]) {
    const r = await postJson("/api/avatar", { preset_id: "c1", style: s }, girlCookie);
    check(`★ style=${s} → 400（隐私策略硬拒绝写实）`, r.status === 400, `status=${r.status}`);
  }

  // ── 4) 旧的 multipart 照片上传 → 403 policy_disabled ────────────────────
  {
    const form = new FormData();
    form.append("photo", new Blob([TINY_PNG], { type: "image/png" }), "me.png");
    form.append("style", "cartoon");
    const res = await fetch(`${BASE}/api/avatar`, { method: "POST", headers: { cookie: girlCookie }, body: form });
    const body = await res.json().catch(() => null);
    console.log(`   ↳ 旧照片上传：HTTP ${res.status} · ${JSON.stringify(body)}`);
    check("★ 旧 multipart 照片上传 → 403 policy_disabled", res.status === 403 && body?.error?.code === "policy_disabled", `status=${res.status} code=${body?.error?.code}`);
  }

  // ── 5) 页面：无拍照/上传入口 + 风格卡片 + 角色网格 ──────────────────────
  {
    const settingsRes = await fetch(`${BASE}/settings`, { headers: { cookie: girlCookie } });
    const html = await settingsRes.text();
    check("/settings 200", settingsRes.status === 200, `status=${settingsRes.status}`);
    check("★ 顶部写「不用上传照片，选一个就好」", html.includes("不用上传照片，选一个就好") && html.includes('data-testid="avatar-no-photo-note"'));
    check(
      "★ 页面不含照片上传入口（无 file input / 无上传按钮；只保留「不用上传照片」说明）",
      !/type="file"/.test(html) && !/avatar-pick|重新选照片|选择照片/.test(html) && /不用上传照片/.test(html),
    );
    check("★ 含 5 个风格卡片", ["watercolor", "cartoon", "pixel", "papercut", "clay"].every((s) => html.includes(`data-testid="avatar-style-${s}"`)));
    check(
      "★ 儿童页面默认分组 = 给小朋友的（c1–c8 可见）",
      ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"].every((c) => html.includes(`data-testid="avatar-preset-${c}"`)),
    );
    check("儿童默认不展示成人角色卡片（c9–c12 不在默认组）", !["c9", "c10", "c11", "c12"].some((c) => html.includes(`data-testid="avatar-preset-${c}"`)));
    check("★ 有分组切换 tab（给小朋友的 / 给爸爸妈妈的）", html.includes('data-testid="avatar-audience-child"') && html.includes('data-testid="avatar-audience-adult"'));
    check("儿童页面零 IPA、无字面 **", leaks(html).length === 0 && !html.includes("**"), `leaked=${leaks(html).join("")}`);
    const dadSettings = await (await fetch(`${BASE}/settings`, { headers: { cookie: dadCookie } })).text();
    check(
      "★ 家长页面默认分组 = 给爸爸妈妈的（c9–c12 可见）",
      ["c9", "c10", "c11", "c12"].every((c) => dadSettings.includes(`data-testid="avatar-preset-${c}"`)),
    );
    check("家长默认不展示儿童角色卡片（c1–c8 不在默认组）", !/data-testid="avatar-preset-c[1-8]"/.test(dadSettings));
    const chatHtml = await (await fetch(`${BASE}/chat`, { headers: { cookie: girlCookie } })).text();
    check("★ 导航栏显示预置头像（静态图 URL）", chatHtml.includes('data-testid="nav-avatar"') && chatHtml.includes("/avatars/presets/"));
  }

  // ── 6) 插画 outbound 带该角色的 character_desc / avatar_style ──────────
  {
    const mk = await fetch(`${BASE}/api/materials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: girlCookie },
      body: JSON.stringify({
        title: "Preset Ref Story",
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
    check("插画生成成功（假 voice）", illus.status === 200 && Boolean(illusBody?.image_url), `status=${illus.status}`);
    const captured = globalThis.__AVATAR_CAPTURED ?? [];
    const last = [...captured].reverse().find((c) => String(c.url).startsWith("/v1/image/illustrate"));
    const body = last?.body ?? "";
    check("★ illustrate outbound 带预置角色 character_desc", /"character_desc":"[^"]+"/.test(body), (body.match(/"character_desc":"[^"]*"/) ?? ["(未捕获)"])[0].slice(0, 90));
    check("★ illustrate outbound 带 avatar_style（character_style=cartoon）", /"character_style":"cartoon"/.test(body), (body.match(/"character_style":"[^"]*"/) ?? ["(未捕获)"])[0]);
    const detail = await (await fetch(`${BASE}/story/${sid}`, { headers: { cookie: girlCookie } })).text();
    check("故事详情页提示词块 + 反馈按钮仍在", detail.includes('data-testid="image-prompt-block"') && detail.includes('data-testid="prompt-feedback"'));
  }

  // ── 7) PATCH 描述 + DELETE 清空（不删预置静态图）───────────────────────
  {
    const patch = await fetch(`${BASE}/api/avatar`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: girlCookie },
      body: JSON.stringify({ character_desc: "7 岁女孩，短发，戴红框眼镜 <b>x</b>" }),
    });
    const pb = await patch.json().catch(() => null);
    check("PATCH character_desc → 生效 + 清洗尖括号", patch.status === 200 && /戴红框眼镜/.test(pb?.character_desc ?? "") && !/[<>]/.test(pb?.character_desc ?? ""), String(pb?.character_desc ?? "").slice(0, 60));
    const presetFile = path.join(WEB_ROOT, "public", "avatars", "presets", "c3-cartoon.png");
    const del = await fetch(`${BASE}/api/avatar`, { method: "DELETE", headers: { cookie: girlCookie } });
    check("DELETE → 200", del.status === 200, `status=${del.status}`);
    const after = await getJson("/api/avatar", girlCookie);
    check("★ 清空后 GET 返回 null", after.json?.avatar_url === null && after.json?.preset_id === null, JSON.stringify(after.json ?? {}).slice(0, 100));
    check("★ 预置静态图**不删**（公共资源）", fs.existsSync(presetFile), presetFile.replace(WEB_ROOT, "…"));
  }

  console.log(`\n共 ${rows.length} 项断言，通过 ${rows.length - failed}，失败 ${failed}`);
}

// ── stub voice：illustrate / health（预置库来自仓库文件，不需要 voice）──────
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
      send(200, { status: "ok", version: "stub", mode: "mock", providers: {}, capabilities: { phoneme_level: true, intonation_curve: true, image: true, image_avatar: false, avatar_presets: true } });
      return;
    }
    if (String(req.url).startsWith("/v1/image/illustrate")) {
      send(200, {
        image_b64: TINY_PNG.toString("base64"),
        mime: "image/png",
        prompt_used: "watercolor illustration with character: a boy wearing round glasses",
        character_used: true,
        provider: "stub",
        model: "glm-image",
        size: "1280x1280",
        elapsed_ms: 8400,
        warnings: [],
      });
      return;
    }
    if (String(req.url).startsWith("/v1/image/avatar")) {
      send(403, { error: { code: "policy_disabled", message: "照片生成形象已关闭" } });
      return;
    }
    send(404, { error: { code: "not_found", message: "stub: no route" } });
  });
});

try {
  await new Promise((r) => stub.listen(8139, "127.0.0.1", r));
  const child = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
    cwd: WEB_ROOT,
    env: { ...process.env, VOICE_SERVICE_URL: "http://127.0.0.1:8139" },
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
