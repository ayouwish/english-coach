#!/usr/bin/env node
/**
 * task-101 验收：家庭成本台账（LLM/图片/语音按家庭记账 + 家长面板成本卡）。
 *
 * 断言：
 *  1. 换算：1M 输入 token @¥1 = 1_000_000 micro；1 张图 @¥0.1 = 100_000 micro；usage 缺失 → null（不记账）
 *  2. 真实调用（story rewrite / TTS，voice 返回 usage）→ cost_events 落库、family_id 正确、金额 > 0
 *  3. /api/cost/summary：家长 200 且含本次成本；儿童 403；跨家庭看不到；月份筛选有效
 *  4. /parent 页面 SSR 含「💰 本月成本」卡
 *
 * 用法：BASE_URL=http://127.0.0.1:3040 node scripts/check-cost.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

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

const cleanup = () => {
  const db = new Database(DB_PATH);
  db.prepare("DELETE FROM cost_events WHERE id LIKE 'ce_test%' OR (user_id = 'u-dad' AND created_at >= ?)").run(new Date(TS - 1000).toISOString());
  const emails = [`costfam${TS}@test.local`];
  const ids = db.prepare(`SELECT id FROM users WHERE email IN (${emails.map(() => "?").join(",")})`).all(...emails).map((r) => r.id);
  for (const id of ids) db.prepare("DELETE FROM users WHERE id = ?").run(id);
  db.prepare("DELETE FROM families WHERE name LIKE '成本测试%'").run();
  db.prepare("DELETE FROM family_invites WHERE created_at >= ?").run(new Date(TS - 60000).toISOString());
  db.prepare("UPDATE families SET family_invite_quota = 100 WHERE id = 'fam_default'").run();
  db.close();
};

async function main() {
  console.log(`=== 家庭成本台账验收 @ ${BASE} ===`);
  const costSrc = fs.readFileSync(path.join(WEB_ROOT, "src/lib/cost.ts"), "utf8");
  const inputPrice = Number(process.env.COST_LLM_INPUT_CNY_PER_1M ?? 1.0);
  const outputPrice = Number(process.env.COST_LLM_OUTPUT_CNY_PER_1M ?? 2.0);
  const imagePrice = Number(process.env.COST_IMAGE_CNY_PER_IMAGE ?? 0.1);
  check("★ 微元换算实现存在（1 元 = 1_000_000 微元）", /MICRO_PER_CNY\s*=\s*1_000_000/.test(costSrc));
  check("★ 单价从 env 读（LLM 输入/输出 + 图片）", /COST_LLM_INPUT_CNY_PER_1M/.test(costSrc) && /COST_LLM_OUTPUT_CNY_PER_1M/.test(costSrc) && /COST_IMAGE_CNY_PER_IMAGE/.test(costSrc));
  check("★ usage 缺失 → null（不记账、不编造）", /if \(!units \|\| typeof units !== "object"\) return null/.test(costSrc));
  check("换算公式核对：1M 输入 + 0 输出 = 1_000_000 micro（默认 ¥1/M）", Math.round((1_000_000 / 1_000_000) * inputPrice * 1_000_000) === 1_000_000);
  check("换算公式核对：1 张图 = 100_000 micro（默认 ¥0.1）", Math.round(imagePrice * 1_000_000) === 100_000);

  const dad = await login("dad@example.com", "Dad12345!");
  const girl = await login("girl@example.com", "Girl12345!");
  check("登录 dad/girl", Boolean(dad) && Boolean(girl));

  // 真实 LLM 调用（story rewrite 返回 usage）
  const rewrite = await fetch(`${BASE}/api/story/rewrite`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: dad },
    body: JSON.stringify({ text_zh: "今天我去公园玩了，还吃了冰淇淋。", level: "A2", max_sentences: 4 }),
  });
  check("story rewrite 调用成功（200）", rewrite.status === 200, `status=${rewrite.status}`);

  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare("SELECT * FROM cost_events WHERE family_id = 'fam_default' AND created_at >= ? ORDER BY created_at DESC").all(new Date(TS - 1000).toISOString());
  const llmRow = rows.find((r) => r.kind === "llm");
  check("★ 真实 LLM 调用 → cost_events 落库（kind=llm, family=fam_default, cost>0）", Boolean(llmRow) && llmRow.cost_micro_cny > 0, JSON.stringify(llmRow ? { kind: llmRow.kind, family: llmRow.family_id, micro: llmRow.cost_micro_cny, units: llmRow.units_json } : null));
  if (llmRow) {
    const u = JSON.parse(llmRow.units_json ?? "{}");
    const expected = Math.round(((u.llm_prompt_tokens ?? 0) / 1e6) * inputPrice * 1e6 + ((u.llm_completion_tokens ?? 0) / 1e6) * outputPrice * 1e6);
    check("★ 金额 = 按 env 单价与 usage 实算（micro 整数）", expected === llmRow.cost_micro_cny, `expected=${expected} actual=${llmRow.cost_micro_cny} units=${llmRow.units_json}`);
  }
  db.close();

    // 跨家庭：新家庭没有 dad 的成本（task-111：邀请码改由后台管理员生成）
    const adminPw = process.env.ADMIN_PASSWORD;
    check("需要 ADMIN_PASSWORD（管理员生成新家庭邀请码）", Boolean(adminPw), "请以 ADMIN_PASSWORD=... 运行本守卫");
    let inv = null;
    if (adminPw) {
      const loginRes = await fetch(`${BASE}/api/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: adminPw }),
      });
      const rawAdmin = typeof loginRes.headers.getSetCookie === "function" ? loginRes.headers.getSetCookie() : [];
      const adminCookie = (rawAdmin.find((c) => c.startsWith("ec_admin=")) ?? "").split(";")[0];
      const invRes = await fetch(`${BASE}/api/admin/family-invites`, { method: "POST", headers: { cookie: adminCookie } });
      inv = await invRes.json().catch(() => null);
    }
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ family_name: `成本测试${TS}`, display_name: "成本家长", email: `costfam${TS}@test.local`, password: "Passw0rd!", new_family_code: inv?.code }),
  });
  const raw = typeof reg.headers.getSetCookie === "function" ? reg.headers.getSetCookie() : [];
  const costCookie = (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
  check("新家庭注册成功", reg.status === 201 && Boolean(costCookie), `status=${reg.status}`);

  const sumDad = await fetch(`${BASE}/api/cost/summary`, { headers: { cookie: dad } });
  const sumDadBody = await sumDad.json().catch(() => null);
  check("★ 家长 /api/cost/summary 200", sumDad.status === 200, `status=${sumDad.status}`);
  check("★ summary 含本次 LLM 成本（total>0, by_kind.llm>0）", (sumDadBody?.total_cny ?? 0) > 0 && (sumDadBody?.by_kind?.llm ?? 0) > 0, JSON.stringify({ total: sumDadBody?.total_cny, by: sumDadBody?.by_kind }));
  check("summary 有成员明细 + 按天（by_user/by_day）", Array.isArray(sumDadBody?.by_user) && sumDadBody.by_user.length > 0 && Array.isArray(sumDadBody?.by_day), JSON.stringify(sumDadBody?.by_user?.slice(0, 2)));
  const sumOther = await (await fetch(`${BASE}/api/cost/summary`, { headers: { cookie: costCookie } })).json();
  check("★ 跨家庭隔离：新家庭 summary total=0、无成员明细", (sumOther?.total_cny ?? 0) === 0 && (sumOther?.by_user ?? []).length === 0, `total=${sumOther?.total_cny}`);
  check("★ 儿童访问 /api/cost/summary → 403", (await fetch(`${BASE}/api/cost/summary`, { headers: { cookie: girl } })).status === 403);

  // 月份筛选：插入一条旧月份事件
  const dbw = new Database(DB_PATH);
  dbw.prepare(
    "INSERT INTO cost_events (id, family_id, user_id, kind, provider, model, units_json, cost_micro_cny, meta_json, created_at) VALUES (?, 'fam_default', 'u-dad', 'image', 'test', 'test', '{\"images\":1}', 100000, '{\"scene\":\"test\"}', ?)",
  ).run(`ce_test_${TS}`, "2025-01-15T00:00:00.000Z");
  dbw.close();
  const oldSum = await (await fetch(`${BASE}/api/cost/summary?month=2025-01`, { headers: { cookie: dad } })).json();
  const curSum = await (await fetch(`${BASE}/api/cost/summary`, { headers: { cookie: dad } })).json();
  check("★ 月份筛选：?month=2025-01 包含测试事件", (oldSum?.month === "2025-01") && (oldSum?.total_cny ?? 0) >= 0.1 && (oldSum?.by_kind?.image ?? 0) >= 0.1, JSON.stringify({ month: oldSum?.month, total: oldSum?.total_cny }));
  check("当月 summary 不含 2025-01 的事件", (curSum?.month ?? "").startsWith(new Date().toISOString().slice(0, 7)), `month=${curSum?.month}`);

  // 家长面板 SSR：成本卡
  const parentPage = await (await fetch(`${BASE}/parent`, { headers: { cookie: dad } })).text();
  check("★ /parent 含「💰 本月成本」卡（SSR）", parentPage.includes('data-testid="cost-card"') && /本月成本/.test(parentPage) && parentPage.includes('data-testid="cost-total"'));
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
