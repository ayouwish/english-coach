#!/usr/bin/env node
/**
 * task-59 验收：自助修改密码（当前会话保留 / 其他会话失效 / 只影响本人）。
 * 用法：BASE_URL=http://127.0.0.1:3040 node scripts/check-password.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3040").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const TS = Date.now();
const LOGIN = `pwtest${TS}`;
const OLD = "OldPassw0rd!";
const NEW = "NewPassw0rd!";
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
  return { status: res.status, cookie: (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0] };
}
const changePw = (cookie, body) =>
  fetch(`${BASE}/api/auth/password`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const me = async (cookie) => {
  const res = await fetch(`${BASE}/api/auth/me`, { headers: cookie ? { cookie } : {} });
  const body = await res.json().catch(() => null);
  return { status: res.status, userId: body?.user?.id ?? null };
};
const cleanup = () => {
  const db = new Database(DB_PATH);
  const rows = db.prepare("SELECT id FROM users WHERE email = ?").all(`${LOGIN}@family.local`.toLowerCase());
  for (const r of rows) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(r.id);
    db.prepare("DELETE FROM user_prefs WHERE user_id = ?").run(r.id);
    db.prepare("DELETE FROM audit_log WHERE actor_user_id = ?").run(r.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(r.id);
  }
  db.close();
};

async function main() {
  console.log(`=== 自助修改密码验收 @ ${BASE} ===`);
  const dad = await login("dad@example.com", "Dad12345!");
  const girl = await login("girl@example.com", "Girl12345!");
  check("登录 dad/girl", Boolean(dad.cookie) && Boolean(girl.cookie));

  // 家长在家庭内创建临时成员（不污染种子账号）
  const mk = await fetch(`${BASE}/api/family/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: dad.cookie },
    body: JSON.stringify({ display_name: "改密测试", login: LOGIN, password: OLD, role: "child", cefr_level: "A1" }),
  });
  const mkBody = await mk.json().catch(() => null);
  const memberEmail = mkBody?.member?.email ?? `${LOGIN}@family.local`.toLowerCase();
  check("家长创建临时成员", mk.status === 201 && Boolean(mkBody?.member?.id), `status=${mk.status}`);

  const s1 = await login(memberEmail, OLD);
  const s2 = await login(memberEmail, OLD);
  check("临时成员两次登录成功（两个会话）", s1.status === 200 && s2.status === 200 && s1.cookie !== s2.cookie);

  // 未登录 → 401
  check("未登录改密 → 401", (await changePw(null, { current_password: OLD, new_password: NEW })).status === 401);
  // 当前密码错 → 401
  const wrong = await changePw(s1.cookie, { current_password: "WrongPass1!", new_password: NEW });
  check("★ 当前密码错 → 401", wrong.status === 401, `status=${wrong.status}`);
  // 新密码太短 → 400
  check("★ 新密码 <8 → 400", (await changePw(s1.cookie, { current_password: OLD, new_password: "short" })).status === 400);
  // 新旧相同 → 400
  check("★ 新旧相同 → 400", (await changePw(s1.cookie, { current_password: OLD, new_password: OLD })).status === 400);

  // 正确修改（用 s1 会话）
  const ok = await changePw(s1.cookie, { current_password: OLD, new_password: NEW });
  const okText = await ok.text();
  check("★ 正确修改 → 200 {ok:true}", ok.status === 200 && /"ok":true/.test(okText), `status=${ok.status} body=${okText.slice(0, 80)}`);
  check("★ 响应不含 password/hash", !/password/i.test(okText) && !/password_hash/i.test(okText), okText.slice(0, 120));

  // 当前会话仍有效；s2 其他会话失效
  const me1 = await me(s1.cookie);
  const me2 = await me(s2.cookie);
  check("★ 当前会话保持有效（/api/auth/me 返回本人）", me1.status === 200 && Boolean(me1.userId), JSON.stringify(me1));
  check("★ 其他会话已失效（旧 cookie 返回 user:null）", me2.status === 200 && me2.userId === null, JSON.stringify(me2));

  // 旧密码 401 / 新密码 200
  check("★ 旧密码登录 → 401", (await login(memberEmail, OLD)).status === 401);
  const newLogin = await login(memberEmail, NEW);
  check("★ 新密码登录 → 200", newLogin.status === 200);

  // 不影响本人以外（girl 会话仍有效）
  check("★ 只影响本人：girl 的会话仍有效", Boolean((await me(girl.cookie)).userId));

  // /settings 表单（儿童 / 成人）
  const girlSettings = await (await fetch(`${BASE}/settings`, { headers: { cookie: girl.cookie } })).text();
  check("★ /settings 含修改密码表单（password-change-form + 三个输入）", girlSettings.includes('data-testid="password-change-section"') && girlSettings.includes('data-testid="password-current"') && girlSettings.includes('data-testid="password-new"') && girlSettings.includes('data-testid="password-confirm"'));
  check("儿童文案「改成新的秘密口令」", /改成新的秘密口令/.test(girlSettings));
  const dadSettings = await (await fetch(`${BASE}/settings`, { headers: { cookie: dad.cookie } })).text();
  check("成人文案「修改密码」存在", /修改密码/.test(dadSettings));
}

try {
  await main();
} catch (err) {
  failed += 1;
  console.error("守卫崩溃：", err);
} finally {
  cleanup();
  console.log(failed === 0 ? "\n结论：全部通过 ✅" : "\n结论：存在失败 ❌");
  process.exit(failed > 0 ? 1 : 0);
}
