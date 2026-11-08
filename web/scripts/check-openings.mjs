#!/usr/bin/env node
/**
 * task-104 验收：对话开场白中文翻译（文本映射全覆盖 + 运行时 + 自定义场景）。
 * 用法：BASE_URL=http://127.0.0.1:3040 node scripts/check-openings.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3040").replace(/\/$/, "");
let failed = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const { OPENING_ZH_BY_TEXT, openingZhFor } = await import(path.join(WEB_ROOT, "src/lib/opening-zh.ts"));

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
}
const getJson = async (p, cookie) => (await fetch(`${BASE}${p}`, { headers: { cookie } })).json();
async function createSession(cookie, scenarioId) {
  const res = await fetch(`${BASE}/api/chat/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ scenario_id: scenarioId }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  console.log(`=== 开场白中文覆盖验收 @ ${BASE} ===`);
  // ① 静态：scenarios.json 全部 base + variations 开场白都在映射里
  const scenarios = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "src/data/scenarios.json"), "utf8")).scenarios;
  const expected = [];
  for (const sc of scenarios) {
    expected.push(sc.opening_line);
    for (const v of sc.variations ?? []) expected.push(v.opening_line);
  }
  const missing = expected.filter((t) => !OPENING_ZH_BY_TEXT[t]);
  const extra = Object.keys(OPENING_ZH_BY_TEXT).filter((t) => !expected.includes(t));
  console.log(`   ↳ scenarios=${scenarios.length} 开场白总数=${expected.length} 映射=${Object.keys(OPENING_ZH_BY_TEXT).length}`);
  check(`★ 静态覆盖 76/76（实际 ${expected.length} 条）`, expected.length === 76 && missing.length === 0, `missing=${missing.length}`);
  check("静态无多余映射（0 extra）", extra.length === 0, `extra=${extra.slice(0, 3).join(" | ")}`);
  check("历史兜底：openingZhFor(未知文本, self_intro) 返回旧 id 映射", openingZhFor("unknown text", "self_intro") === "嗨！我是 Sam。你叫什么名字？");
  check("映射值均非空中文", Object.values(OPENING_ZH_BY_TEXT).every((v) => typeof v === "string" && v.trim().length > 0));

  const girl = await login("girl@example.com", "Girl12345!");
  check("girl 登录", Boolean(girl));

  // ② 运行时：同一场景开 ≥12 次会话，第一条 assistant 的 text_zh 非空且等于映射
  const scenarioId = "self_intro";
  const seen = new Set();
  let failures = 0;
  let sessions = 0;
  for (let i = 0; i < 14; i++) {
    const s = await createSession(girl, scenarioId);
    if (s.status !== 201) {
      failures += 1;
      continue;
    }
    sessions += 1;
    const sid = s.body?.session_id;
    const msgs = await getJson(`/api/chat/sessions/${sid}/messages`, girl);
    const first = (msgs?.messages ?? []).find((m) => m.role === "assistant");
    const text = first?.text ?? "";
    const zh = first?.text_zh ?? "";
    seen.add(zh);
    if (!zh || zh !== OPENING_ZH_BY_TEXT[text]) failures += 1;
    // 响应里的 scenario.opening_zh 也应非空
    if (s.body?.scenario && !s.body.scenario.opening_zh) failures += 1;
  }
  check("★ 运行时 12+ 次会话首句 text_zh 全非空且等于映射", sessions >= 12 && failures === 0, `sessions=${sessions} failures=${failures} distinct_zh=${seen.size}`);
  check("覆盖到多个变体（≥2 种中文开场白）", seen.size >= 2, `distinct=${seen.size}`);

  // ③ 自定义场景：带 opening_zh → 会话首句 text_zh 等于它
  const custom = await fetch(`${BASE}/api/chat/scenarios`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: girl },
    body: JSON.stringify({
      title: "Opening Zh Test",
      title_zh: "中文开场白测试",
      setting_zh: "测试自定义场景中文开场白",
      role_prompt: "You are a friendly shopkeeper who sells toys to children.",
      opening_line: "Hi there! What toy would you like today?",
      opening_zh: "你好呀！今天想买什么玩具？",
      level: "A1",
      audience: "child",
    }),
  });
  const customBody = await custom.json().catch(() => null);
  const customId = customBody?.id ?? null;
  check("自定义场景创建成功（带 opening_zh）", custom.status === 201 && Boolean(customId), `status=${custom.status}`);
  if (customId) {
    const s = await createSession(girl, customId);
    check("自定义场景开会话成功（200/201）", s.status === 200 || s.status === 201, `status=${s.status}`);
    const msgs = await getJson(`/api/chat/sessions/${s.body?.session_id}/messages`, girl);
    const first = (msgs?.messages ?? []).find((m) => m.role === "assistant");
    check("★ 自定义场景首句 text_zh = 自填中文", first?.text_zh === "你好呀！今天想买什么玩具？", JSON.stringify(first?.text_zh));
  }
  // 清理：删除自定义场景（会话保留不碍事；避免污染）
  if (customId) await fetch(`${BASE}/api/chat/scenarios/${customId}`, { method: "DELETE", headers: { cookie: girl } }).catch(() => undefined);
}

try {
  await main();
} catch (err) {
  failed += 1;
  console.error("守卫崩溃：", err);
} finally {
  console.log(failed === 0 ? "\n结论：全部通过 ✅" : "\n结论：存在失败 ❌");
  process.exit(failed > 0 ? 1 : 0);
}
