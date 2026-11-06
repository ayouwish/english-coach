#!/usr/bin/env node
/**
 * task-103 验收：盲测软取消（DELETE /api/blind-tests/:id）。
 * 覆盖：取消 200 / DB 三态 / attempts 保留 / 列表排除 / 幂等 / 新批次 / 404 / 409（finished、cancelled）/ 儿童 / 回归 / UI SSR。
 * 用法：BASE_URL=http://127.0.0.1:3040 node scripts/check-blind.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3040").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const TINY_WAV = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64");
const TEST_PREFIX = "bt_test103_";
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
const del = (id, cookie) => fetch(`${BASE}/api/blind-tests/${id}`, { method: "DELETE", headers: { cookie } });
const submitAttempt = (cookie, blindId) => {
  const form = new FormData();
  form.append("audio", new Blob([TINY_WAV], { type: "audio/wav" }), "a.wav");
  form.append("reference_text", "Hello! My name is Lily.");
  form.append("mode", "scripted");
  form.append("blind_test_id", blindId);
  return fetch(`${BASE}/api/attempts`, { method: "POST", headers: { cookie }, body: form });
};
async function start(cookie) {
  const r = await fetch(`${BASE}/api/blind-tests`, { method: "POST", headers: { cookie } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const cleanup = () => {
  const db = new Database(DB_PATH);
  for (const t of db.prepare("SELECT id FROM blind_tests WHERE id LIKE ?").all(`${TEST_PREFIX}%`)) {
    db.prepare("DELETE FROM phoneme_scores WHERE attempt_id IN (SELECT id FROM attempts WHERE blind_test_id = ?)").run(t.id);
    db.prepare("DELETE FROM attempts WHERE blind_test_id = ?").run(t.id);
    db.prepare("DELETE FROM blind_tests WHERE id = ?").run(t.id);
  }
  // 清理守卫过程中创建的真实批次（避免污染用户数据）
  for (const t of db.prepare("SELECT id FROM blind_tests WHERE user_id = 'u-girl' AND started_at >= ?").all(new Date(Date.now() - 30 * 60 * 1000).toISOString())) {
    db.prepare("DELETE FROM phoneme_scores WHERE attempt_id IN (SELECT id FROM attempts WHERE blind_test_id = ?)").run(t.id);
    db.prepare("DELETE FROM attempts WHERE blind_test_id = ?").run(t.id);
    db.prepare("DELETE FROM blind_tests WHERE id = ?").run(t.id);
  }
  db.close();
};

async function main() {
  console.log(`=== 盲测软取消验收 @ ${BASE} ===`);
  const girl = await login("girl@example.com", "Girl12345!");
  const dad = await login("dad@example.com", "Dad12345!");
  check("登录 girl/dad", Boolean(girl) && Boolean(dad));

  // 清理 girl 历史进行中批次（避免上一轮残留影响）
  const listBefore = await (await fetch(`${BASE}/api/blind-tests`, { headers: { cookie: girl } })).json();
  let existing = listBefore?.in_progress?.id;
  while (existing) {
    await del(existing, girl);
    const again = await (await fetch(`${BASE}/api/blind-tests`, { headers: { cookie: girl } })).json();
    existing = again?.in_progress?.id;
  }

  // 1) 开始 → 取消
  const started = await start(girl);
  const btId = started.body?.blind_test_id ?? null;
  check("开始盲测成功（201/200）", started.status === 201 || started.status === 200, `status=${started.status}`);
  const pod = await submitAttempt(girl, btId);
  check("提交 1 条盲测 attempt", pod.status === 201 || pod.status === 200, `status=${pod.status}`);
  const delRes = await del(btId, girl);
  const delBody = await delRes.json().catch(() => null);
  check("★ 取消成功 → 200 cancelled:true", delRes.status === 200 && delBody?.cancelled === true && Boolean(delBody?.cancelled_at), JSON.stringify(delBody));

  const db = new Database(DB_PATH, { readonly: true });
  const btRow = db.prepare("SELECT * FROM blind_tests WHERE id = ?").get(btId);
  const attemptCount = db.prepare("SELECT COUNT(*) c FROM attempts WHERE blind_test_id = ?").get(btId).c;
  db.close();
  check("★ DB：cancelled_at 非空、ended_at 为空（三态互斥）", Boolean(btRow?.cancelled_at) && !btRow?.ended_at, JSON.stringify({ cancelled_at: btRow?.cancelled_at, ended_at: btRow?.ended_at }));
  check("★ attempts 保留（软取消不物理删）", attemptCount >= 1, `attempts=${attemptCount}`);

  // 2) 列表排除 + in_progress null
  const listAfter = await (await fetch(`${BASE}/api/blind-tests`, { headers: { cookie: girl } })).json();
  check("★ 列表 in_progress=null", listAfter?.in_progress === null, JSON.stringify(listAfter?.in_progress));
  check("★ tests 不含已取消批次", !(listAfter?.tests ?? []).some((t) => t.id === btId));

  // 3) 幂等
  const again = await del(btId, girl);
  const againBody = await again.json().catch(() => null);
  check("★ 重复 DELETE → 200 幂等（cancelled_at 不变）", again.status === 200 && againBody?.cancelled_at === delBody?.cancelled_at, `${again.status}/${againBody?.cancelled_at} vs ${delBody?.cancelled_at}`);

  // 4) 新批次
  const started2 = await start(girl);
  const bt2 = started2.body?.blind_test_id ?? null;
  check("★ 取消后开始新批次：新 id、resumed=false", Boolean(bt2) && bt2 !== btId && started2.body?.resumed === false, `id=${bt2} resumed=${started2.body?.resumed} status=${started2.status}`);

  // 7/8) 取消后提交 attempt / finish → 409 blind_cancelled
  const postCancelAttempt = await submitAttempt(girl, btId);
  const postCancelBody = await postCancelAttempt.json().catch(() => null);
  check("★ 取消后提交 attempt → 409 blind_cancelled", postCancelAttempt.status === 409 && postCancelBody?.error?.code === "blind_cancelled", `${postCancelAttempt.status}/${postCancelBody?.error?.code}`);
  const postCancelFinish = await fetch(`${BASE}/api/blind-tests/${btId}/finish`, { method: "POST", headers: { cookie: girl } });
  const finishBody = await postCancelFinish.json().catch(() => null);
  check("★ 取消后 finish → 409 blind_cancelled", postCancelFinish.status === 409 && finishBody?.error?.code === "blind_cancelled", `${postCancelFinish.status}/${finishBody?.error?.code}`);

  // 5) 取消已完成 → 409 already_finished（先给 bt2 提交并 finish）
  await submitAttempt(girl, bt2);
  const fin = await fetch(`${BASE}/api/blind-tests/${bt2}/finish`, { method: "POST", headers: { cookie: girl } });
  const finBody = await fin.json().catch(() => null);
  check("正常 finish 回归：200 且有 avg/notice/scored/pending 字段", fin.status === 200 && finBody?.avg_pron !== undefined && finBody?.scored !== undefined && finBody?.pending !== undefined && finBody?.notice !== undefined, JSON.stringify({ avg: finBody?.avg_pron, scored: finBody?.scored, pending: finBody?.pending }));
  const delFinished = await del(bt2, girl);
  const delFinishedBody = await delFinished.json().catch(() => null);
  check("★ 取消已完成 → 409 already_finished", delFinished.status === 409 && delFinishedBody?.error?.code === "already_finished", `${delFinished.status}/${delFinishedBody?.error?.code}`);

  // 6) 他人批次 → 404
  const delOther = await del(bt2, dad);
  check("★ 他人批次 → 404（不泄漏）", delOther.status === 404, `status=${delOther.status}`);

  // 9) 儿童可取消自己的（girl 就是儿童，前面已验证）→ 再跑一次显式
  const started3 = await start(girl);
  const bt3 = started3.body?.blind_test_id ?? null;
  const childCancel = await del(bt3, girl);
  check("★ 儿童可取消自己的批次", started3.status === 201 && childCancel.status === 200, `status=${childCancel.status}`);

  // UI SSR：进行中卡片含取消入口（先开一个进行中）
  const started4 = await start(girl);
  const bt4 = started4.body?.blind_test_id ?? null;
  const reportHtml = (await (await fetch(`${BASE}/blindtest/report`, { headers: { cookie: girl } })).text()).replace(/<!--[\s\S]*?-->/g, "");
  check("★ /blindtest/report 进行中卡片含取消入口（blind-cancel）", reportHtml.includes('data-testid="blind-cancel"'));
  const childText = /不想测了就取消/.test(reportHtml);
  check("儿童文案「不想测了就取消～」", childText);
  check("「取消这轮盲测」成人文案存在于源码", (await import("node:fs")).readFileSync(path.join(WEB_ROOT, "src/components/BlindCancelButton.tsx"), "utf8").includes("取消这轮盲测"));
  await del(bt4, girl);
  check("取消后周报 in_progress 消失", (await (await fetch(`${BASE}/api/blind-tests`, { headers: { cookie: girl } })).json())?.in_progress === null);
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
