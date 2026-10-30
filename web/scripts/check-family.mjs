#!/usr/bin/env node
/**
 * task-54 验收：家庭成员管理（创建账号 / 不同水平）+ C1 + 故事集「只看我的」。
 *
 * 断言：
 *  1. 儿童 GET/POST /api/family/members → 403
 *  2. 家长创建成员（login 简称 → 自动补 @family.local）→ 201；**新账号能登录**
 *  3. 重复 login → 409；密码 <8 → 400；非法 role/cefr_level → 400
 *  4. PATCH 成员英语水平 → 生效；重置密码 → 旧密码失效、新密码可登录
 *  5. 不能修改自己的 role → 400
 *  6. CEFR_LEVELS 含 C1；故事改写传 C1 不被 web 校验拒绝
 *  7. /parent 有家庭成员面板；儿童 /parent → 403；/story 有「只看我的」；儿童页面零 IPA、无 **
 *
 * 用法：BASE_URL=http://127.0.0.1:3025 node scripts/check-family.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3025").replace(/\/$/, "");
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
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    cookie: (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0],
    body: await res.json().catch(() => null),
  };
}

async function api(pathname, { cookie, method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const createdIds = [];
function cleanup() {
  if (createdIds.length === 0) return;
  const db = new Database(DB_PATH);
  for (const id of createdIds) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM attempts WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }
  db.close();
  console.log(`\n（已清理本次创建的 ${createdIds.length} 个成员账号）`);
}

try {
  console.log(`=== 家庭成员管理验收 @ ${BASE} ===`);
  const dad = await login("dad@example.com", "Dad12345!");
  const girl = await login("girl@example.com", "Girl12345!");
  check("种子账号仍可登录（未被破坏）", dad.status === 200 && girl.status === 200, `dad=${dad.status} girl=${girl.status}`);
  const dadId = dad.body?.user?.id ?? "u-dad";

  // ── 1) 儿童 403 ──────────────────────────────────────────────────────────
  const childGet = await api("/api/family/members", { cookie: girl.cookie });
  check("★ 儿童 GET /api/family/members → 403", childGet.status === 403, `status=${childGet.status}`);
  const childPost = await api("/api/family/members", {
    cookie: girl.cookie,
    method: "POST",
    body: { display_name: "偷偷建", login: "hack", password: "12345678", role: "child", cefr_level: "A1" },
  });
  check("★ 儿童 POST /api/family/members → 403", childPost.status === 403, `status=${childPost.status}`);

  // ── 2) 家长创建成员 + 新账号能登录 ────────────────────────────────────────
  const loginName = `fam${Date.now().toString().slice(-6)}`;
  const create = await api("/api/family/members", {
    cookie: dad.cookie,
    method: "POST",
    body: {
      display_name: "测试爷爷",
      login: loginName,
      password: "Gramps123!",
      role: "parent",
      cefr_level: "B2",
      birth_year: 1955,
      avatar: "👴",
      daily_limit_minutes: 30,
      allow_free_chat: true,
    },
  });
  const member = create.body?.member ?? null;
  if (member?.id) createdIds.push(member.id);
  console.log(`   ↳ 创建成员：HTTP ${create.status} · ${JSON.stringify(member).slice(0, 200)}`);
  check("★ 家长创建成员 → 201", create.status === 201 && Boolean(member?.id), `status=${create.status}`);
  check("★ login 简称自动补全为 @family.local", member?.email === `${loginName}@family.local`, member?.email ?? "");
  check("创建后字段正确（昵称/角色/水平/时长/头像）", member?.display_name === "测试爷爷" && member?.role === "parent" && member?.cefr_level === "B2" && member?.daily_limit_minutes === 30 && member?.avatar === "👴", JSON.stringify(member ?? {}).slice(0, 160));
  check("响应里绝不包含密码/hash", !/password/i.test(JSON.stringify(member ?? {})) && !/\\$2[aby]\\$/.test(JSON.stringify(member ?? {})), "no password fields");
  const newLogin = await login(`${loginName}@family.local`, "Gramps123!");
  check("★ 新账号能登录成功", newLogin.status === 200 && newLogin.body?.user?.displayName === "测试爷爷", `status=${newLogin.status}`);

  // ── 3) 校验：重复 login 409 / 密码短 400 / 非法枚举 400 ────────────────────
  const dup = await api("/api/family/members", {
    cookie: dad.cookie,
    method: "POST",
    body: { display_name: "重复", login: loginName, password: "Whatever123", role: "child", cefr_level: "A1" },
  });
  check("★ 重复 login → 409", dup.status === 409, `status=${dup.status} msg=${dup.body?.error?.message?.slice(0, 40)}`);
  const shortPwd = await api("/api/family/members", {
    cookie: dad.cookie,
    method: "POST",
    body: { display_name: "短密码", login: `${loginName}x`, password: "1234", role: "child", cefr_level: "A1" },
  });
  check("密码 <8 位 → 400", shortPwd.status === 400, `status=${shortPwd.status}`);
  const badRole = await api("/api/family/members", {
    cookie: dad.cookie,
    method: "POST",
    body: { display_name: "坏角色", login: `${loginName}y`, password: "GoodPass123", role: "admin", cefr_level: "A1" },
  });
  check("非法 role → 400", badRole.status === 400, `status=${badRole.status}`);
  const badCefr = await api("/api/family/members", {
    cookie: dad.cookie,
    method: "POST",
    body: { display_name: "坏水平", login: `${loginName}z`, password: "GoodPass123", role: "child", cefr_level: "Z9" },
  });
  check("非法 cefr_level → 400", badCefr.status === 400, `status=${badCefr.status}`);

  // ── 4) PATCH 水平 + 重置密码 ─────────────────────────────────────────────
  const patch = await api(`/api/family/members/${member.id}`, {
    cookie: dad.cookie,
    method: "PATCH",
    body: { cefr_level: "C1", daily_limit_minutes: 45 },
  });
  check("★ PATCH 英语水平 C1 → 生效", patch.status === 200 && patch.body?.member?.cefr_level === "C1", `status=${patch.status} cefr=${patch.body?.member?.cefr_level}`);
  check("PATCH 每日时长同步生效", patch.body?.member?.daily_limit_minutes === 45, String(patch.body?.member?.daily_limit_minutes));
  const fetched = await api("/api/family/members", { cookie: dad.cookie });
  const listed = (fetched.body?.items ?? []).find((m) => m.id === member.id);
  check("成员列表里能看到（含 stats）", Boolean(listed) && typeof listed?.stats?.attempts === "number", `count=${(fetched.body?.items ?? []).length}`);

  const reset = await api(`/api/family/members/${member.id}/password`, {
    cookie: dad.cookie,
    method: "POST",
    body: { new_password: "NewGramps456!" },
  });
  check("家长重置成员密码 → 200", reset.status === 200, `status=${reset.status}`);
  const oldPwd = await login(`${loginName}@family.local`, "Gramps123!");
  const newPwd = await login(`${loginName}@family.local`, "NewGramps456!");
  check("★ 重置后旧密码失效", oldPwd.status === 401, `status=${oldPwd.status}`);
  check("★ 重置后新密码可登录", newPwd.status === 200, `status=${newPwd.status}`);

  // ── 5) 不能修改自己的 role ────────────────────────────────────────────────
  const selfRole = await api(`/api/family/members/${dadId}`, {
    cookie: dad.cookie,
    method: "PATCH",
    body: { role: "child" },
  });
  check("★ 不能修改自己的角色 → 400", selfRole.status === 400 && /角色/.test(selfRole.body?.error?.message ?? ""), `status=${selfRole.status} msg=${selfRole.body?.error?.message?.slice(0, 40)}`);
  const dadAfter = await api("/api/family/members", { cookie: dad.cookie });
  const dadRow = (dadAfter.body?.items ?? []).find((m) => m.id === dadId);
  check("自己的角色没有被改（仍是 parent）", dadRow?.role === "parent", dadRow?.role ?? "");

  // ── 6) C1：源码 + 接口 ───────────────────────────────────────────────────
  {
    const levelsSrc = fs.readFileSync(path.join(WEB_ROOT, "src/lib/levels.ts"), "utf8");
    check("★ CEFR_LEVELS 含 C1（源码）", /CEFR_LEVELS = \[[^\]]*"C1"/.test(levelsSrc), (levelsSrc.match(/CEFR_LEVELS = \[[^\]]*\]/) ?? [""])[0]);
    const rewrite = await api("/api/story/rewrite", {
      cookie: dad.cookie,
      method: "POST",
      body: { text_zh: "今天我给自己煮了一杯咖啡。", level: "C1" },
    });
    const levelRejected = rewrite.status === 400 && /难度必须/.test(rewrite.body?.error?.message ?? "");
    check(
      "★ 故事改写传 C1 不被 web 校验拒绝（voice 侧 C1 由 task-55 支持；200/502/503 均可）",
      !levelRejected,
      `status=${rewrite.status} code=${rewrite.body?.error?.code ?? ""}`,
    );
    const badLevel = await api("/api/story/rewrite", {
      cookie: dad.cookie,
      method: "POST",
      body: { text_zh: "今天我很开心", level: "Z9" },
    });
    check("非法 level 仍被拒（400）", badLevel.status === 400, `status=${badLevel.status}`);
  }

  // ── 7) 页面：/parent 面板、儿童 403、/story 筛选、零 IPA ──────────────────
  const parentPage = await fetch(`${BASE}/parent`, { headers: { cookie: dad.cookie } });
  const parentHtml = await parentPage.text();
  check("/parent 200（家长）", parentPage.status === 200, `status=${parentPage.status}`);
  check("★ /parent 有家庭成员面板（family-members-panel + 添加成员）", parentHtml.includes('data-testid="family-members-panel"') && parentHtml.includes("添加成员"));
  const childParent = await fetch(`${BASE}/parent`, { headers: { cookie: girl.cookie }, redirect: "manual" });
  check("儿童 /parent → 403", childParent.status === 403, `status=${childParent.status}`);

  const storyPage = await fetch(`${BASE}/story`, { headers: { cookie: girl.cookie } });
  const storyHtml = await storyPage.text();
  check("★ /story 有「只看我的」筛选", storyHtml.includes('data-testid="story-scope-mine"') && /只看我的/.test(storyHtml));
  check("★ /story 有「全家」筛选", storyHtml.includes('data-testid="story-scope-family"') && /全家/.test(storyHtml));
  check("儿童 /story 零 IPA、无字面 **", leaks(storyHtml).length === 0 && !storyHtml.includes("**"), `leaked=${leaks(storyHtml).join("")}`);

  console.log(`\n共 ${rows.length} 项断言，通过 ${rows.length - failed}，失败 ${failed}`);
} catch (err) {
  failed += 1;
  console.error("守卫崩溃：", err);
} finally {
  cleanup();
  console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
  process.exit(failed > 0 ? 1 : 0);
}
