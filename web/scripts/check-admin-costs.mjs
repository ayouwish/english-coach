#!/usr/bin/env node
/** task-108 验收：管理员成本看板（权限/跨家庭聚合/月份/容错/页面）。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3040").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const TS = Date.now();
const TEST_FAMILY = `fam_test108_${TS}`;
let failed = 0;
const check = (n, c, d = "") => { if (!c) failed += 1; console.log(`${c ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); };
async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
}
const cleanup = () => {
  const db = new Database(DB_PATH);
  db.prepare("DELETE FROM cost_events WHERE id LIKE 'ce_test108_%'").run();
  db.prepare("DELETE FROM users WHERE email LIKE ?").run(`acost${TS}%@test.local`);
  db.prepare("DELETE FROM families WHERE id = ? OR name LIKE ?").run(TEST_FAMILY, `成本看板测试${TS}%`);
  db.prepare("DELETE FROM family_invites WHERE created_at >= ?").run(new Date(TS - 60000).toISOString());
  db.prepare("UPDATE families SET family_invite_quota = 100 WHERE id = 'fam_default'").run();
  db.close();
};
async function main() {
  console.log(`=== 管理员成本看板验收 @ ${BASE} ===`);
  const dad = await login("dad@example.com", "Dad12345!");
  const girl = await login("girl@example.com", "Girl12345!");
  check("登录 dad/girl", Boolean(dad) && Boolean(girl));

  // 造两个家庭的数据：fam_default + 测试家庭
  const db = new Database(DB_PATH);
  db.prepare("INSERT OR IGNORE INTO families (id, name, invite_code, invite_used, created_by, created_at) VALUES (?, ?, ?, 0, NULL, ?)").run(TEST_FAMILY, `成本看板测试${TS}`, `T108${String(TS).slice(-4)}`, new Date().toISOString());
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO cost_events (id, family_id, user_id, kind, provider, model, units_json, cost_micro_cny, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.run(`ce_test108_a_${TS}`, "fam_default", "u-dad", "llm", "deepseek", "deepseek-chat", JSON.stringify({ llm_prompt_tokens: 1_000_000, llm_completion_tokens: 0, llm_total_tokens: 1_000_000 }), 2_000_000, "{}", now);
  ins.run(`ce_test108_b_${TS}`, TEST_FAMILY, null, "image", "zhipu", "glm-image", JSON.stringify({ images: 2 }), 200_000, "{}", now);
  ins.run(`ce_test108_c_${TS}`, TEST_FAMILY, null, "tts", "azure", null, "not-json", 50_000, "{}", now);
  ins.run(`ce_test108_old_${TS}`, TEST_FAMILY, null, "asr", "azure", null, JSON.stringify({ asr_seconds: 30 }), 100_000, "{}", "2025-03-15T00:00:00.000Z");
  db.close();

  const res = await fetch(`${BASE}/api/admin/costs`, { headers: { cookie: dad } });
  const data = await res.json().catch(() => null);
  check("★ 管理员 GET /api/admin/costs → 200", res.status === 200, `status=${res.status}`);
  check("★ totals：成本/LLM tokens/图片/调用", (data?.totals?.cost_cny ?? 0) >= 2.25 && (data?.totals?.llm_total_tokens ?? 0) >= 1_000_000 && (data?.totals?.image_count ?? 0) >= 2 && (data?.totals?.calls ?? 0) >= 3, JSON.stringify(data?.totals));
  check("★ by_family 含两个家庭且按成本降序", (data?.by_family ?? []).length >= 2 && data.by_family[0].cost_cny >= data.by_family[1].cost_cny && data.by_family.some((f) => f.family_id === TEST_FAMILY), (data?.by_family ?? []).map((f) => `${f.family_name}:${f.cost_cny}`).join(","));
  check("by_family 含成员数/图片/TTS/ASR", (data?.by_family ?? []).every((f) => typeof f.members === "number" && typeof f.image_count === "number" && typeof f.tts_chars === "number" && typeof f.asr_seconds === "number"));
  check("★ 非法 units_json 容错（tts 事件仍计数，不崩）", (data?.recent_events ?? []).some((e) => e.kind === "tts") || (data?.totals?.calls ?? 0) >= 3);
  check("by_day + recent_events 含家庭名", (data?.by_day ?? []).length >= 1 && (data?.recent_events ?? []).some((e) => String(e.family_name ?? "").includes("成本看板测试")));
  check("recent_events ≤50", (data?.recent_events ?? []).length <= 50);

  // 月份筛选
  const old = await (await fetch(`${BASE}/api/admin/costs?month=2025-03`, { headers: { cookie: dad } })).json();
  check("★ ?month=2025-03 → 仅旧事件（ASR 30 秒）", old?.month === "2025-03" && (old?.totals?.asr_seconds ?? 0) >= 30 && (old?.totals?.calls ?? 0) >= 1, JSON.stringify(old?.totals));
  const empty = await (await fetch(`${BASE}/api/admin/costs?month=2024-01`, { headers: { cookie: dad } })).json();
  check("空月份 → totals 全 0", (empty?.totals?.calls ?? 0) === 0);

  // 权限
  check("★ 儿童 → 403", (await fetch(`${BASE}/api/admin/costs`, { headers: { cookie: girl } })).status === 403);
  const inv = await (await fetch(`${BASE}/api/family/family-invites`, { method: "POST", headers: { cookie: dad } })).json();
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ family_name: `成本看板测试${TS}B`, display_name: "看板B", email: `acost${TS}b@test.local`, password: "Passw0rd!", new_family_code: inv?.code }),
  });
  const raw = typeof reg.headers.getSetCookie === "function" ? reg.headers.getSetCookie() : [];
  const bCookie = (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
  check("★ 非管理员家庭家长 → 403", reg.status === 201 && (await fetch(`${BASE}/api/admin/costs`, { headers: { cookie: bCookie } })).status === 403, `reg=${reg.status}`);

  // 页面 SSR + /parent 入口
  const page = await (await fetch(`${BASE}/admin/costs`, { headers: { cookie: dad } })).text();
  check("★ /admin/costs SSR：总计/家庭表/按天/最近事件", page.includes('data-testid="admin-costs-page"') && page.includes('data-testid="admin-costs-total"') && page.includes('data-testid="admin-costs-family-row"') && page.includes('data-testid="admin-costs-days"') && page.includes('data-testid="admin-costs-recent"'));
  check("页面含测试家庭名", /成本看板测试/.test(page));
  const childPage = await fetch(`${BASE}/admin/costs`, { headers: { cookie: girl } });
  check("儿童访问页面 → 403", childPage.status === 403, `status=${childPage.status}`);
  const parentHtml = await (await fetch(`${BASE}/parent`, { headers: { cookie: dad } })).text();
  const bParentHtml = await (await fetch(`${BASE}/parent`, { headers: { cookie: bCookie } })).text();
  check("★ /parent 管理员有 admin-costs-link；非管理员没有", parentHtml.includes('data-testid="admin-costs-link"') && !bParentHtml.includes('data-testid="admin-costs-link"'));
}
try { await main(); } catch (e) { failed += 1; console.error("守卫崩溃：", e); }
finally { cleanup(); console.log(failed === 0 ? "\n结论：全部通过 ✅" : "\n结论：存在失败 ❌"); process.exit(failed > 0 ? 1 : 0); }
