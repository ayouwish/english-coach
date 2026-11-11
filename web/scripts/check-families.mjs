#!/usr/bin/env node
/**
 * task-98 验收：多家庭隔离（family scoping）。
 *
 * 断言：
 *  1. 迁移后所有用户/材料都有 family_id；默认家庭存在（老账号回归）
 *  2. 注册两个家庭 A/B：材料列表互不可见；跨家庭 GET/PATCH/DELETE/image/audio/status/retell/illustrate → 404（不泄漏）
 *  3. 家庭成员：A 看不到 B 成员；跨家庭改资料/重置密码 → 404
 *  4. 家长汇总：只统计本家庭；不出现别家成员
 *  5. 建议：A 的家长只看本家庭建议；跨家庭改状态 → 404
 *  6. 老家庭回归：dad/mom/girl 仍同一家庭、互相能看到英文正文
 *
 * 用法：BASE_URL=http://127.0.0.1:3040 node scripts/check-families.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3040").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const TS = Date.now();

let failed = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
}

async function register(body) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0],
  };
}

const cleanup = () => {
  const db = new Database(DB_PATH);
  const emails = [
    `famA${TS}@test.local`.toLowerCase(),
    `famB${TS}@test.local`.toLowerCase(),
    `famA2${TS}@test.local`.toLowerCase(),
    `bchild${TS}@family.local`.toLowerCase(),
    `famC1${TS}@test.local`.toLowerCase(),
    `famC2${TS}@test.local`.toLowerCase(),
    `famC3${TS}@test.local`.toLowerCase(),
    `famC4${TS}@test.local`.toLowerCase(),
    `famB2${TS}@test.local`.toLowerCase(),
    `newfam${TS}@test.local`.toLowerCase(),
  ];
  const ids = db.prepare(`SELECT id FROM users WHERE email IN (${emails.map(() => "?").join(",")})`).all(...emails).map((r) => r.id);
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE user_id IN (${marks}))`).run(...ids);
    db.prepare(`DELETE FROM chat_sessions WHERE user_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM suggestions WHERE user_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM reading_materials WHERE created_by IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM users WHERE id IN (${marks})`).run(...ids);
  }
  db.prepare("DELETE FROM families WHERE name LIKE '隔离测试%' OR name LIKE '新家庭测试%'").run();
  db.prepare("DELETE FROM family_invites WHERE created_at >= ?").run(new Date(TS - 60000).toISOString());
  db.prepare("UPDATE families SET family_invite_quota = 100, is_admin = 1 WHERE id = 'fam_default'").run();
  db.close();
};

async function main() {
  console.log(`=== 多家庭隔离验收 @ ${BASE} ===`);
  const db = new Database(DB_PATH, { readonly: true });
  const famCol = db.prepare("PRAGMA table_info(users)").all().find((c) => c.name === "family_id");
  const matsWithoutFamily = db.prepare("SELECT COUNT(*) c FROM reading_materials WHERE family_id IS NULL OR family_id=''").get().c;
  db.close();
  check("users.family_id NOT NULL（迁移 0021）", famCol?.notnull === 1);
  check("所有材料都有 family_id（回填完成）", matsWithoutFamily === 0, `缺=${matsWithoutFamily}`);

  // ── A/B 两个家庭（task-105：管理员家庭生成「新家庭邀请码」→ 凭码创建新家庭）──
  const dadLogin = await login("dad@example.com", "Dad12345!");
  const mkInvite = async () => {
    const r = await fetch(`${BASE}/api/family/family-invites`, { method: "POST", headers: { cookie: dadLogin } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const invA = await mkInvite();
  const invB = await mkInvite();
  check("★ 管理员家庭生成新家庭邀请码（quota 递减）", invA.status === 201 && Boolean(invA.body?.code) && invA.body?.quota_remaining < 100, JSON.stringify({ a: invA.body?.code, q: invA.body?.quota_remaining, b: invB.status }));
  const A = await register({ family_name: `隔离测试A${TS}`, display_name: "A家长", email: `famA${TS}@test.local`.toLowerCase(), password: "Passw0rd!", new_family_code: invA.body?.code });
  const B = await register({ family_name: `隔离测试B${TS}`, display_name: "B家长", email: `famB${TS}@test.local`.toLowerCase(), password: "Passw0rd!", new_family_code: invB.body?.code });
  check("★ 注册两个家庭成功（均 parent）", A.status === 201 && B.status === 201 && A.cookie && B.cookie, `${A.status}/${B.status}`);
  const famA = A.body?.user?.familyId;
  const famB = B.body?.user?.familyId;
  check("两家庭 family_id 不同", Boolean(famA) && Boolean(famB) && famA !== famB);

  // 邀请加入第二家长（同一家庭）
  const inviteA = await (await fetch(`${BASE}/api/family/invite`, { headers: { cookie: A.cookie } })).json();
  const A2 = await register({ invite_code: inviteA.invite_code, display_name: "A二家长", email: `famA2${TS}@test.local`.toLowerCase(), password: "Passw0rd!" });
  check("★ 凭邀请码加入同一家庭", A2.status === 201 && A2.body?.user?.familyId === famA, `family=${A2.body?.user?.familyId}`);

  // ── 材料跨家庭 ─────────────────────────────────────────────────────────────
  const mk = await fetch(`${BASE}/api/materials`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.cookie },
    body: JSON.stringify({ title: `隔离故事A ${TS}`, text: "This is a private story for family A.", kind: "story", level: "A2", source: "text" }),
  });
  const mat = await mk.json().catch(() => null);
  const mid = mat?.id ?? null;
  check("A 家庭创建故事成功", mk.status === 201 && Boolean(mid), `status=${mk.status}`);

  const listA = await (await fetch(`${BASE}/api/materials?kind=story&limit=100`, { headers: { cookie: A.cookie } })).json();
  const listB = await (await fetch(`${BASE}/api/materials?kind=story&limit=100`, { headers: { cookie: B.cookie } })).json();
  check("★ A 的列表含自己的故事", (listA?.items ?? []).some((x) => x.id === mid));
  check("★ B 的列表看不到 A 的故事", !(listB?.items ?? []).some((x) => x.id === mid));
  check("★ B 打开 A 的故事 → 404", (await fetch(`${BASE}/api/materials/${mid}`, { headers: { cookie: B.cookie } })).status === 404);
  check("★ B 取 A 的故事图片 → 404", (await fetch(`${BASE}/api/materials/${mid}/image`, { headers: { cookie: B.cookie } })).status === 404);
  check("★ B 改 A 的故事 → 404", (await fetch(`${BASE}/api/materials/${mid}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: B.cookie }, body: JSON.stringify({ title: "hack" }) })).status === 404);
  check("★ B 删 A 的故事 → 404", (await fetch(`${BASE}/api/materials/${mid}`, { method: "DELETE", headers: { cookie: B.cookie } })).status === 404);
  check("★ B 看 A 的故事详情页 → 不可见（找不到这个故事）", /找不到这个故事/.test(await (await fetch(`${BASE}/story/${mid}`, { headers: { cookie: B.cookie } })).text()));
  check("★ B 打印 A 的故事 → 404", (await fetch(`${BASE}/story/${mid}/print`, { headers: { cookie: B.cookie } })).status === 404);
  check("★ B 取 A 故事拼接状态 → 404", (await fetch(`${BASE}/api/story/${mid}/audio/status`, { headers: { cookie: B.cookie } })).status === 404);
  check("★ B 对 A 故事发起复述 → 404", (await fetch(`${BASE}/api/story/retell`, { method: "POST", headers: { "content-type": "application/json", cookie: B.cookie }, body: JSON.stringify({ material_id: mid, story_sentences: ["hello"], transcript: "hello world" }) })).status === 404);
  check("★ B 给 A 故事画插画 → 404", (await fetch(`${BASE}/api/story/${mid}/illustrate`, { method: "POST", headers: { "content-type": "application/json", cookie: B.cookie }, body: "{}" })).status === 404);
  check("A 自己仍能读自己的故事（回归）", (await fetch(`${BASE}/api/materials/${mid}`, { headers: { cookie: A.cookie } })).status === 200);

  // B 家庭孩子（家长创建）跨家庭访问 → 404
  const mkChild = async (parentCookie, login) =>
    fetch(`${BASE}/api/family/members`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: parentCookie },
      body: JSON.stringify({ display_name: login, login, password: "Passw0rd!", role: "child", cefr_level: "A1" }),
    });
  await mkChild(B.cookie, `bchild${TS}`);
  const bChild = await login(`bchild${TS}@family.local`, "Passw0rd!");
  check("B 家庭创建孩子并登录成功", Boolean(bChild));
  const bChildMat = await fetch(`${BASE}/api/materials/${mid}`, { headers: { cookie: bChild } });
  check("★ B 家孩子跨家庭读 A 材料 → 404", bChildMat.status === 404, `status=${bChildMat.status}`);
  const bChildPrint = await fetch(`${BASE}/story/${mid}/print`, { headers: { cookie: bChild } });
  check("★ B 家孩子跨家庭打印 A 故事 → 404", bChildPrint.status === 404, `status=${bChildPrint.status}`);

  // 对话会话按本人：B 打不开 A 的会话
  const sess = await fetch(`${BASE}/api/chat/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.cookie },
    body: JSON.stringify({ scenario_id: "adult_coffee_order" }),
  });
  const sessBody = await sess.json().catch(() => null);
  const sessId = sessBody?.session_id ?? null;
  check("A 创建对话会话成功", sess.status === 201 && Boolean(sessId), `status=${sess.status}`);
  const bSess = await fetch(`${BASE}/api/chat/sessions/${sessId}`, { headers: { cookie: B.cookie } });
  check("★ B 打不开 A 的对话会话 → 404（本人隔离）", bSess.status === 404, `status=${bSess.status}`);
  const bMsgs = await fetch(`${BASE}/api/chat/sessions/${sessId}/messages`, { headers: { cookie: B.cookie } });
  check("★ B 读不到 A 的对话消息 → 404", bMsgs.status === 404, `status=${bMsgs.status}`);

  // 录音按本人：B 看不到 A 的录音列表
  const TINY = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64");
  const rf = new FormData();
  rf.append("audio", new Blob([TINY], { type: "audio/wav" }), "a.wav");
  const recRes = await fetch(`${BASE}/api/story/recordings`, { method: "POST", headers: { cookie: A.cookie }, body: rf });
  const rec = await recRes.json().catch(() => null);
  const recId = rec?.id ?? null;
  if (recId) {
    const bList = await (await fetch(`${BASE}/api/story/recordings`, { headers: { cookie: B.cookie } })).json();
    check("★ B 的录音列表不含 A 的录音（本人隔离）", !(bList?.items ?? []).some((x) => x.id === recId));
    check("★ B 听 A 的录音 → 404", (await fetch(`${BASE}/api/story/recordings/${recId}/audio`, { headers: { cookie: B.cookie } })).status === 404);
    const d = new Database(DB_PATH);
    const row = d.prepare("SELECT audio_path FROM story_recordings WHERE id = ?").get(recId);
    if (row?.audio_path) {
      const abs = path.join(WEB_ROOT, "data", row.audio_path);
      const fsMod = await import("node:fs");
      if (fsMod.existsSync(abs)) fsMod.rmSync(abs);
    }
    d.prepare("DELETE FROM story_recordings WHERE id = ?").run(recId);
    d.close();
  }
  check("A2（同家庭）也能读（英文正文家庭可见）", (await fetch(`${BASE}/api/materials/${mid}`, { headers: { cookie: A2.cookie } })).status === 200);

  // ── 家庭成员跨家庭 ─────────────────────────────────────────────────────────
  const membersA = await (await fetch(`${BASE}/api/family/members`, { headers: { cookie: A.cookie } })).json();
  const membersB = await (await fetch(`${BASE}/api/family/members`, { headers: { cookie: B.cookie } })).json();
  check("★ 家庭 A 成员=2（创建者+受邀）", membersA?.count === 2, `count=${membersA?.count}`);
  check("★ 家庭 B 成员=2（家长+孩子），不含 A 成员", membersB?.count === 2 && !(membersB?.items ?? []).some((m) => m.email.includes("fama")), `count=${membersB?.count}`);
  const victim = (membersA?.items ?? [])[0]?.id;
  check("★ B 改 A 家庭成员资料 → 404", (await fetch(`${BASE}/api/family/members/${victim}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: B.cookie }, body: JSON.stringify({ display_name: "hack" }) })).status === 404);
  check("★ B 重置 A 成员密码 → 404", (await fetch(`${BASE}/api/family/members/${victim}/password`, { method: "POST", headers: { "content-type": "application/json", cookie: B.cookie }, body: JSON.stringify({ new_password: "Hacked123!" }) })).status === 404);

  // ── 家长汇总 ───────────────────────────────────────────────────────────────
  const sumA = await (await fetch(`${BASE}/api/parent/summary`, { headers: { cookie: A.cookie } })).json();
  const sumB = await (await fetch(`${BASE}/api/parent/summary`, { headers: { cookie: B.cookie } })).json();
  check("★ 家长汇总只含本家庭成员（A=2 / B=2）", sumA?.members?.length === 2 && sumB?.members?.length === 2, `${sumA?.members?.length}/${sumB?.members?.length}`);
  check("★ 汇总不出现别家成员", !JSON.stringify(sumA).includes("B家长") && !JSON.stringify(sumB).includes("A家长"));

  // ── 建议 ───────────────────────────────────────────────────────────────────
  const sug = await fetch(`${BASE}/api/suggestions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.cookie },
    body: JSON.stringify({ category: "feature", content: "家庭A的私有建议内容" }),
  });
  const sugBody = await sug.json().catch(() => null);
  const sugId = sugBody?.id ?? null;
  check("A 家长提交建议成功", sug.status === 201 && Boolean(sugId), `status=${sug.status}`);
  const sugListA = await (await fetch(`${BASE}/api/suggestions`, { headers: { cookie: A.cookie } })).json();
  const sugListB = await (await fetch(`${BASE}/api/suggestions`, { headers: { cookie: B.cookie } })).json();
  check("★ 建议列表按家庭隔离（A 有 / B 没有）", (sugListA?.items ?? []).some((s) => s.id === sugId) && !(sugListB?.items ?? []).some((s) => s.id === sugId));
  check("★ B 改 A 的建议状态 → 404", (await fetch(`${BASE}/api/suggestions/${sugId}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: B.cookie }, body: JSON.stringify({ status: "resolved" }) })).status === 404);
  check("★ B 导出建议不含 A 内容", !(await (await fetch(`${BASE}/api/suggestions/export?format=md`, { headers: { cookie: B.cookie } })).text()).includes("家庭A的私有建议内容"));

  // ── 老家庭回归 ─────────────────────────────────────────────────────────────
  const dad = await login("dad@example.com", "Dad12345!");
  const girl = await login("girl@example.com", "Girl12345!");
  const oldMembers = await (await fetch(`${BASE}/api/family/members`, { headers: { cookie: dad } })).json();
  check("★ 老家庭（dad/mom/girl）仍是同一家庭、成员=3", oldMembers?.count === 3, `count=${oldMembers?.count}`);
  const girlMk = await fetch(`${BASE}/api/materials`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: girl },
    body: JSON.stringify({ title: `老家庭故事 ${TS}`, text: "I played with my friend today.", kind: "story", level: "A2", source: "text" }),
  });
  const gmat = await girlMk.json().catch(() => null);
  const gmid = gmat?.id ?? null;
  check("老家庭内 dad 能看 girl 的英文正文（回归）", (await fetch(`${BASE}/api/materials/${gmid}`, { headers: { cookie: dad } })).status === 200);

  // ── task-99：一次性邀请码 + 家长上限 3 + ALLOW_SELF_SIGNUP ─────────────────
  const invC0 = await mkInvite();
  const C1 = await register({ family_name: `隔离测试C${TS}`, display_name: "C1", email: `famC1${TS}@test.local`.toLowerCase(), password: "Passw0rd!", new_family_code: invC0.body?.code });
  check("C 家庭创建成功", C1.status === 201);
  const invC = await (await fetch(`${BASE}/api/family/invite`, { headers: { cookie: C1.cookie } })).json();
  check("★ 邀请码信息含 parents_count/limit 与一次性状态", invC?.parents_count === 1 && invC?.parents_limit === 3 && invC?.invite_used === false, JSON.stringify(invC));
  const C2 = await register({ invite_code: invC.invite_code, display_name: "C2", email: `famC2${TS}@test.local`.toLowerCase(), password: "Passw0rd!" });
  check("★ 邀请码加入成功（家长 2/3）", C2.status === 201 && C2.body?.user?.familyId === C1.body?.user?.familyId);
  {
    const d = new Database(DB_PATH, { readonly: true });
    const fam = d.prepare("SELECT invite_used, invite_used_by, invite_used_at FROM families WHERE id = ?").get(C1.body?.user?.familyId);
    d.close();
    check("★ 邀请码使用记录：invite_used=1 + used_by=加入者 + used_at", fam?.invite_used === 1 && fam?.invite_used_by === C2.body?.user?.id && Boolean(fam?.invite_used_at), JSON.stringify(fam));
  }
  const invSrc = (await import("node:fs")).readFileSync(path.join(WEB_ROOT, "src/components/FamilyInviteCard.tsx"), "utf8");
  check("★ 家长面板邀请卡：显示 家长账号 N/3 + 一次性状态 + 满员禁用重置", /家长账号/.test(invSrc) && /parents_limit/.test(invSrc) && /atParentLimit/.test(invSrc) && /disabled=\{busy \|\| atParentLimit\}/.test(invSrc));
  const reuse = await register({ invite_code: invC.invite_code, display_name: "复用", email: `famC4${TS}@test.local`.toLowerCase(), password: "Passw0rd!" });
  check("★ 同一邀请码再用一次 → 400（一次性）", reuse.status === 400, `status=${reuse.status}`);
  const invC2 = await (await fetch(`${BASE}/api/family/invite`, { headers: { cookie: C1.cookie } })).json();
  check("已用邀请码状态 invite_used=true、家长 2/3", invC2?.invite_used === true && invC2?.parents_count === 2, JSON.stringify(invC2));
  const rotC = await (await fetch(`${BASE}/api/family/invite/rotate`, { method: "POST", headers: { cookie: C1.cookie } })).json();
  const C3 = await register({ invite_code: rotC.invite_code, display_name: "C3", email: `famC3${TS}@test.local`.toLowerCase(), password: "Passw0rd!" });
  check("★ rotate 后新码可用（家长 3/3）", C3.status === 201 && C3.body?.user?.familyId === C1.body?.user?.familyId);
  const rotC2 = await (await fetch(`${BASE}/api/family/invite/rotate`, { method: "POST", headers: { cookie: C1.cookie } })).json();
  const over = await register({ invite_code: rotC2.invite_code, display_name: "C4", email: `famC4${TS}@test.local`.toLowerCase(), password: "Passw0rd!" });
  check("★ 第 4 个家长 → 409 parent_limit_reached", over.status === 409 && over.body?.error?.code === "parent_limit_reached", `status=${over.status} code=${over.body?.error?.code}`);

  const healthMain = await (await fetch(`${BASE}/api/health`)).json();
  check("★ /api/health.features.self_signup=false（task-105 默认关闭开放注册）", healthMain?.features?.self_signup === false);

  // ALLOW_SELF_SIGNUP=0 的实例（3051）：只禁"创建家庭"，凭邀请码加入仍允许
  const child = spawn("pnpm", ["exec", "next", "start", "-p", "3051"], {
    detached: true,
    cwd: WEB_ROOT,
    env: { ...process.env, ALLOW_SELF_SIGNUP: "0" },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        if ((await fetch("http://127.0.0.1:3051/api/health", { signal: AbortSignal.timeout(1500) })).ok) {
          up = true;
          break;
        }
      } catch {
        /* retry */
      }
    }
    check("受限实例 3051 启动成功", up);
    if (up) {
      const h = await (await fetch("http://127.0.0.1:3051/api/health")).json();
      check("★ ALLOW_SELF_SIGNUP=0：health.features.self_signup=false", h?.features?.self_signup === false);
      const noSelf = await fetch("http://127.0.0.1:3051/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ family_name: "不该成功", display_name: "X", email: `x${TS}@test.local`.toLowerCase(), password: "Passw0rd!" }),
      });
      const noSelfBody = await noSelf.json().catch(() => null);
      check("★ 关闭态：创建新家庭 → 403 signup_disabled", noSelf.status === 403 && noSelfBody?.error?.code === "signup_disabled", `status=${noSelf.status}`);
      const page = await (await fetch("http://127.0.0.1:3051/register")).text();
      check(
        "★ 关闭态 /register 有说明 + 只保留邀请码加入（无创建家庭入口）",
        page.includes('data-testid="register-signup-disabled"') &&
          /公开注册已关闭/.test(page) &&
          page.includes('data-testid="register-mode-join"') &&
          !page.includes('data-testid="register-mode-create"'),
      );
      // 凭邀请码加入仍允许（用 B 家庭的新码）
      const rotB = await (await fetch(`${BASE}/api/family/invite/rotate`, { method: "POST", headers: { cookie: B.cookie } })).json();
      const joinClosed = await fetch("http://127.0.0.1:3051/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite_code: rotB.invite_code, display_name: "B2", email: `famB2${TS}@test.local`.toLowerCase(), password: "Passw0rd!" }),
      });
      check("★ 关闭态：凭邀请码加入仍 201", joinClosed.status === 201, `status=${joinClosed.status}`);
    }
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }

  // ── task-105：新家庭邀请名额制 ─────────────────────────────────────────────
  {
    const list = await (await fetch(`${BASE}/api/family/family-invites`, { headers: { cookie: dadLogin } })).json();
    check("★ 管理员 GET 邀请码列表（quota_remaining<100、含已生成码）", list?.is_admin === true && typeof list?.quota_remaining === "number" && list.quota_remaining < 100 && (list.invites ?? []).some((i) => i.code === invA.body?.code));
    const nonAdmin = await fetch(`${BASE}/api/family/family-invites`, { method: "POST", headers: { cookie: B.cookie } });
    const nonAdminBody = await nonAdmin.json().catch(() => null);
    check("★ 非管理员家庭生成 → 403 no_family_quota", nonAdmin.status === 403 && nonAdminBody?.error?.code === "no_family_quota", `${nonAdmin.status}/${nonAdminBody?.error?.code}`);
    const noCode = await register({ family_name: `无码家庭${TS}`, display_name: "无码", email: `nocode${TS}@test.local`.toLowerCase(), password: "Passw0rd!" });
    check("★ 默认关闭开放注册：无码创建家庭 → 403 signup_disabled", noCode.status === 403 && noCode.body?.error?.code === "signup_disabled", `${noCode.status}/${noCode.body?.error?.code}`);
    const reuse = await register({ family_name: `复用家庭${TS}`, display_name: "复用", email: `reuse${TS}@test.local`.toLowerCase(), password: "Passw0rd!", new_family_code: invA.body?.code });
    check("★ 新家庭邀请码一次性：同码再用 → 400", reuse.status === 400, `status=${reuse.status}`);
    // 管理员名额设为 0 → 403（运维脚本）
    const dbq = new Database(DB_PATH);
    dbq.prepare("UPDATE families SET family_invite_quota = 0 WHERE id = 'fam_default'").run();
    dbq.close();
    const noQuota = await fetch(`${BASE}/api/family/family-invites`, { method: "POST", headers: { cookie: dadLogin } });
    const noQuotaBody = await noQuota.json().catch(() => null);
    check("★ 名额=0 时管理员生成 → 403 no_family_quota", noQuota.status === 403 && noQuotaBody?.error?.code === "no_family_quota", `${noQuota.status}`);
    const dbq2 = new Database(DB_PATH);
    dbq2.prepare("UPDATE families SET family_invite_quota = 100 WHERE id = 'fam_default'").run();
    dbq2.close();
    const parentPage = await (await fetch(`${BASE}/parent`, { headers: { cookie: dadLogin } })).text();
    check("★ /parent 含「邀请新家庭」卡片与剩余名额（SSR）", parentPage.includes('data-testid="new-family-invite-card"') && /邀请新家庭/.test(parentPage));
    // task-106 rev2：newfamily 表单必须同时有「邀请码 + 家庭名称」；E2E 走 new_family_code
    const regSrc = (await import("node:fs")).readFileSync(path.join(WEB_ROOT, "src/app/register/RegisterForm.tsx"), "utf8");
    check(
      "★ newfamily 表单含邀请码+家庭名称两个输入（源码）",
      /mode !== "create" \? \([\s\S]{0,600}?data-testid="register-invite-code"/.test(regSrc) &&
        /mode !== "join" \? \([\s\S]{0,600}?data-testid="register-family-name"/.test(regSrc) &&
        /new_family_code: inviteCode/.test(regSrc) &&
        /mode === "newfamily" && !inviteCode\.trim\(\)/.test(regSrc),
    );
    const invNew = await mkInvite();
    const newFam = await register({
      family_name: `新家庭测试${TS}`,
      display_name: "新家庭爸",
      email: `newfam${TS}@test.local`.toLowerCase(),
      password: "Passw0rd!",
      new_family_code: invNew.body?.code,
    });
    check(
      "★ newfamily 模式（new_family_code+family_name）→ 201 全新家庭",
      newFam.status === 201 && Boolean(newFam.body?.user?.familyId) && newFam.body?.user?.familyId !== "fam_default",
      `${newFam.status}/${newFam.body?.user?.familyId}`,
    );
    const reuseNewFam = await register({
      family_name: `新家庭测试复用${TS}`,
      display_name: "复用",
      email: `newfamreuse${TS}@test.local`.toLowerCase(),
      password: "Passw0rd!",
      new_family_code: invNew.body?.code,
    });
    check("★ 同码再用 → 400", reuseNewFam.status === 400, `status=${reuseNewFam.status}`);
    const regPage = await (await fetch(`${BASE}/register`)).text();
    check("★ /register 默认显示「受邀创建新家庭」且无「创建家庭」", regPage.includes('data-testid="register-mode-newfamily"') && !regPage.includes('data-testid="register-mode-create"'));
    const bParent = await (await fetch(`${BASE}/parent`, { headers: { cookie: B.cookie } })).text();
    const nfSrc = (await import("node:fs")).readFileSync(path.join(WEB_ROOT, "src/components/NewFamilyInviteCard.tsx"), "utf8");
    check("非管理员 /parent 含邀请新家庭卡 + 卡片显示名额 0 / 联系管理员", bParent.includes('data-testid="new-family-invite-card"') && /名额 0 · 联系管理员/.test(nfSrc));
  }

  if (gmid) {
    const d = new Database(DB_PATH);
    d.prepare("DELETE FROM reading_materials WHERE id = ?").run(gmid);
    d.close();
  }
}

try {
  await main();
} catch (err) {
  failed += 1;
  console.error("守卫崩溃：", err);
} finally {
  cleanup();
  console.log(failed === 0 ? "\n结论：全部通过 ✅" : `\n结论：存在失败 ❌`);
  process.exit(failed > 0 ? 1 : 0);
}
