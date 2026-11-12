#!/usr/bin/env node
/** task-110 验收：独立后台管理员认证 + 独立成本看板（/admin）。 */
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3053;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const ADMIN_PASSWORD = "AdminTest123!";
const TS = Date.now();
let failed = 0;
const check = (n, c, d = "") => { if (!c) failed += 1; console.log(`${c ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); };
const cleanup = () => {
  const db = new Database(DB_PATH);
  db.prepare("DELETE FROM cost_events WHERE id LIKE 'ce_test110_%'").run();
  db.close();
};
async function familyLogin() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dad@example.com", password: "Dad12345!" }) });
  const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  return { cookie: (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0] };
}
async function adminLogin(password) {
  const r = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  return { status: r.status, body: await r.json().catch(() => null), cookie: (raw.find((c) => c.startsWith("ec_admin=")) ?? "").split(";")[0], raw };
}
async function main() {
  console.log(`=== 独立后台管理员验收 @ ${BASE} ===`);
  const db = new Database(DB_PATH);
  const ins = db.prepare("INSERT INTO cost_events (id, family_id, user_id, kind, provider, model, units_json, cost_micro_cny, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const now = new Date().toISOString();
  ins.run(`ce_test110_a_${TS}`, "fam_default", "u-dad", "llm", "deepseek", "deepseek-chat", JSON.stringify({ llm_prompt_tokens: 1000, llm_completion_tokens: 100, llm_total_tokens: 1100 }), 1_200_000, "{}", now);
  ins.run(`ce_test110_b_${TS}`, "fam_default", "u-mom", "image", "zhipu", "glm-image", JSON.stringify({ images: 1 }), 100_000, "{}", now);
  ins.run(`ce_test110_c_${TS}`, "fam_default", null, "tts", "azure", null, "not-json", 10_000, "{}", now);
  ins.run(`ce_test110_old_${TS}`, "fam_default", null, "asr", "azure", null, JSON.stringify({ asr_seconds: 30 }), 50_000, "{}", "2025-05-10T00:00:00.000Z");
  db.close();

  // ① 正确登录（先于限速测试；成功会清空失败计数）
  const ok = await adminLogin(ADMIN_PASSWORD);
  check("★ 正确管理密码 → 200 + HttpOnly ec_admin cookie", ok.status === 200 && Boolean(ok.cookie) && ok.raw.some((c) => c.includes("ec_admin=") && /HttpOnly/i.test(c)), `status=${ok.status}`);
  const adminCookie = ok.cookie;
  // ② 限速：连续 5 次失败后第 6 次 429
  const wrong = await adminLogin("wrong-password");
  check("★ 管理密码错误 → 401", wrong.status === 401, `status=${wrong.status}`);
  for (let i = 0; i < 4; i++) await adminLogin("wrong-password");
  const limited = await adminLogin("wrong-password");
  check("连续 6 次失败 → 429（5 次/60s 限速）", limited.status === 429, `status=${limited.status}`);
  check("管理员 cookie 不是家庭 session", adminCookie.startsWith("ec_admin="));

  // ② API：管理员 200 + 聚合 + 容错；家庭账号 401
  const res = await fetch(`${BASE}/api/admin/costs`, { headers: { cookie: adminCookie } });
  const data = await res.json().catch(() => null);
  check("★ 管理员 GET /api/admin/costs → 200", res.status === 200, `status=${res.status}`);
  check("★ totals 含成本/LLM tokens/图片/调用（手算）", (data?.totals?.cost_cny ?? 0) >= 1.31 && (data?.totals?.llm_total_tokens ?? 0) >= 1100 && (data?.totals?.image_count ?? 0) >= 1 && (data?.totals?.calls ?? 0) >= 3, JSON.stringify(data?.totals));
  check("非法 units_json 容错（事件仍计数）", (data?.recent_events ?? []).some((e) => e.kind === "tts") || (data?.totals?.calls ?? 0) >= 3);
  check("by_family/by_day/recent 结构", Array.isArray(data?.by_family) && data.by_family.length >= 1 && Array.isArray(data?.by_day) && Array.isArray(data?.recent_events));
  const old = await (await fetch(`${BASE}/api/admin/costs?month=2025-05`, { headers: { cookie: adminCookie } })).json();
  check("★ 月份筛选：2025-05 只有旧事件", old?.month === "2025-05" && (old?.totals?.asr_seconds ?? 0) >= 30 && (old?.totals?.calls ?? 0) === 1, JSON.stringify(old?.totals));
  const family = await familyLogin();
  check("★ 家庭账号访问 /api/admin/* → 401", (await fetch(`${BASE}/api/admin/costs`, { headers: { cookie: family.cookie } })).status === 401);
  check("无 cookie 访问 /api/admin/* → 401", (await fetch(`${BASE}/api/admin/costs`)).status === 401);

  // ③ 页面：未登录跳登录、管理员 sSSR、/admin/costs 重定向、独立导航
  const noAuth = await fetch(`${BASE}/admin`, { redirect: "manual" });
  check("★ /admin 未登录 → 跳 /admin/login", noAuth.status >= 300 && noAuth.status < 400 && (noAuth.headers.get("location") ?? "").includes("/admin/login"), `status=${noAuth.status} loc=${noAuth.headers.get("location")}`);
  const loginPage = await (await fetch(`${BASE}/admin/login`)).text();
  check("★ 独立登录页含 admin-login-form", loginPage.includes('data-testid="admin-login-form"') && !loginPage.includes("ec-btn-primary\">登录"));
  const adminPage = await fetch(`${BASE}/admin`, { headers: { cookie: adminCookie } });
  const html = await adminPage.text();
  check("★ /admin 管理员 SSR：总计/家庭表/按天/最近事件", adminPage.status === 200 && html.includes('data-testid="admin-page"') && html.includes('data-testid="admin-total"') && html.includes('data-testid="admin-family-row"') && html.includes('data-testid="admin-days"') && html.includes('data-testid="admin-recent"'));
  check(
    "★ /admin 独立布局：无家庭导航（无 <nav / 家庭功能链接）",
    !/<nav[\s>]/.test(html) && !/href="\/(practice|flow|story|blindtest|parent)"/.test(html),
  );
  const costsRedirect = await fetch(`${BASE}/admin/costs`, { redirect: "manual", headers: { cookie: adminCookie } });
  check("★ /admin/costs → 重定向 /admin", costsRedirect.status >= 300 && costsRedirect.status < 400 && (costsRedirect.headers.get("location") ?? "").endsWith("/admin"), `status=${costsRedirect.status} loc=${costsRedirect.headers.get("location")}`);
  const parentHtml = await (await fetch(`${BASE}/parent`, { headers: { cookie: family.cookie } })).text();
  check("★ /parent 已移除管理员看板入口", !parentHtml.includes('data-testid="admin-costs-link"') && !/管理员成本看板/.test(parentHtml));
  const logout = await fetch(`${BASE}/api/admin/logout`, { method: "POST", headers: { cookie: adminCookie } });
  check("POST /api/admin/logout → 200", logout.status === 200);
}
try {
  const child = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
    detached: true,
    cwd: WEB_ROOT,
    env: { ...process.env, ADMIN_PASSWORD, VOICE_SERVICE_URL: process.env.VOICE_SERVICE_URL ?? "http://127.0.0.1:8100" },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok) { up = true; break; } } catch { /* retry */ }
    }
    check("独立后台实例启动成功（3053, ADMIN_PASSWORD 已设置）", up);
    if (up) await main();
    else failed += 1;
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ }
  }
} catch (e) { failed += 1; console.error("守卫崩溃：", e); }
finally { cleanup(); console.log(failed === 0 ? "\n结论：全部通过 ✅" : "\n结论：存在失败 ❌"); process.exit(failed > 0 ? 1 : 0); }
