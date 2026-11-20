#!/usr/bin/env node
/** task-115 验收：后台「一键缓存所有音色」（mock TTS 实例，不花钱）。 */
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3055;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = "AdminWarm123!";
let failed = 0;
const check = (n, c, d = "") => { if (!c) failed += 1; console.log(`${c ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); };

// ── mock voice：批量预热 stub（后台任务 1.5s 完成；同参数第二次全 cached）──
let job = null;
let seq = 0;
const seenKeys = new Set();
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), "http://x");
  const send = (status, obj) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (url.pathname === "/v1/health") return send(200, { status: "ok", version: "stub", mode: "mock", providers: {}, capabilities: { phoneme_level: true, tts: true } });
    if (url.pathname === "/v1/warmup/bulk" && req.method === "POST") {
      if (job && job.state === "running") return send(409, { error: { code: "warmup_running", message: "已有任务在跑", detail: { job_id: job.id } } });
      const input = JSON.parse(body || "{}");
      const texts = Array.isArray(input.texts) ? input.texts : [];
      const voices = Array.isArray(input.voices) ? input.voices : [];
      const rates = Array.isArray(input.rates) ? input.rates : [];
      const total = texts.length * Math.max(1, voices.length) * Math.max(1, rates.length);
      const key = JSON.stringify({ texts, voices, rates });
      const cached = seenKeys.has(key);
      const now = new Date().toISOString();
      job = {
        id: `warm_${++seq}`,
        state: "running",
        total,
        done: 0,
        generated: 0,
        cached: 0,
        failed: 0,
        skipped_duplicates: 0,
        chars_generated: 0,
        key,
        finishAt: Date.now() + 1500,
        cachedKey: cached,
      };
      return send(200, { job_id: job.id, total, state: "running", started_at: now, skipped_duplicates: 0, concurrency: 2, warnings: [] });
    }
    if (url.pathname === "/v1/warmup/bulk/status" && req.method === "GET") {
      if (!job) return send(200, { job_id: null, state: "idle", total: 0, done: 0, generated: 0, cached: 0, failed: 0, skipped_duplicates: 0, chars_generated: 0 });
      if (job.state === "running" && Date.now() >= job.finishAt) {
        job.state = "done";
        job.done = job.total;
        if (job.cachedKey) { job.cached = job.total; job.generated = 0; } else { job.generated = job.total; seenKeys.add(job.key); }
        job.chars_generated = job.generated * 20;
      }
      return send(200, { job_id: job.id, state: job.state, total: job.total, done: job.done, generated: job.generated, cached: job.cached, failed: job.failed, skipped_duplicates: job.skipped_duplicates, chars_generated: job.chars_generated, started_at: new Date().toISOString(), finished_at: job.state === "done" ? new Date().toISOString() : null, error: null });
    }
    if (url.pathname === "/v1/warmup/bulk/cancel" && req.method === "POST") {
      if (job && job.state === "running") job.state = "cancelled";
      return send(200, { job_id: job?.id ?? null, state: job?.state ?? "idle" });
    }
    send(404, { error: { code: "not_found", message: "stub: no route" } });
  });
});

async function loginFamily() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dad@example.com", password: "Dad12345!" }) });
  const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
}
async function loginAdmin() {
  const r = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: ADMIN_PASSWORD }) });
  const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  return { status: r.status, cookie: (raw.find((c) => c.startsWith("ec_admin=")) ?? "").split(";")[0] };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(cookie, ms = 12000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    const res = await fetch(`${BASE}/api/admin/tts-warmup`, { headers: { cookie } });
    const body = await res.json().catch(() => null);
    last = body?.status ?? null;
    if (last?.state === "done" || last?.state === "failed" || last?.state === "cancelled") return last;
    await sleep(400);
  }
  return last;
}
const startBody = (texts) => ({ texts, voices: ["en-US-JennyNeural", "zh-CN-XiaoxiaoNeural"], rates: ["normal"] });

async function main() {
  console.log(`=== 后台一键预热验收 @ ${BASE}（mock voice）===`);
  const family = await loginFamily();
  check("家庭账号访问 /api/admin/tts-warmup → 401", (await fetch(`${BASE}/api/admin/tts-warmup`, { headers: { cookie: family } })).status === 401);
  const admin = await loginAdmin();
  check("管理员登录成功", admin.status === 200 && Boolean(admin.cookie));

  const metaRes = await fetch(`${BASE}/api/admin/tts-warmup`, { headers: { cookie: admin.cookie } });
  const meta = await metaRes.json().catch(() => null);
  check("★ 管理员 GET 估算 200", metaRes.status === 200, `status=${metaRes.status}`);
  const c = meta?.sentences?.count ?? 0;
  const v = (meta?.voices ?? []).length;
  const r = (meta?.rates ?? []).length;
  check("估算公式：items = 句数 × 音色 × 语速", meta?.estimate?.items === c * v * r && c > 0 && v === 9 && r === 2, `count=${c} voices=${v} rates=${r} items=${meta?.estimate?.items}`);
  check("估算 chars = Σlen × 音色 × 语速", meta?.estimate?.chars === (meta?.sentences?.chars ?? 0) * v * r);
  const expectedCost = Math.round(((meta?.sentences?.chars ?? 0) * v * r / 1000) * 0.12 * 100) / 100;
  check("★ 估算成本按 ¥0.12/千字符", Math.abs((meta?.estimate?.cost_cny ?? 0) - expectedCost) <= 0.02, `cost=${meta?.estimate?.cost_cny} expected≈${expectedCost}`);
  check("prices 含 tts_warmup_per_1k_chars=0.12", meta?.prices?.tts_warmup_per_1k_chars === 0.12, JSON.stringify(meta?.prices));

  // 小样本 first run → done
  const sample = ["Hello there.", "你好呀。"];
  const start1 = await fetch(`${BASE}/api/admin/tts-warmup`, { method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie }, body: JSON.stringify(startBody(sample)) });
  const start1Body = await start1.json().catch(() => null);
  check("★ 小样本启动 → 201 + job_id + total=4", start1.status === 201 && Boolean(start1Body?.job_id) && start1Body?.total === 4, JSON.stringify(start1Body).slice(0, 120));
  const done1 = await waitDone(admin.cookie);
  check("★ 第一次预热完成 done == generated+cached+failed", done1?.state === "done" && done1?.done === done1?.generated + done1?.cached + done1?.failed && done1?.generated === 4, JSON.stringify(done1));
  // 第二次同参数 → 全 cached
  const start2 = await fetch(`${BASE}/api/admin/tts-warmup`, { method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie }, body: JSON.stringify(startBody(sample)) });
  check("第二次同参数启动成功", start2.status === 201);
  const done2 = await waitDone(admin.cookie);
  check("★ 第二次预热：cached=total、generated=0（预热后秒出）", done2?.state === "done" && done2?.cached === 4 && done2?.generated === 0, JSON.stringify(done2));

  // 409：运行中再次启动
  const sampleB = ["One more sentence."];
  const s1 = await fetch(`${BASE}/api/admin/tts-warmup`, { method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie }, body: JSON.stringify(startBody(sampleB)) });
  const s2 = await fetch(`${BASE}/api/admin/tts-warmup`, { method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie }, body: JSON.stringify(startBody(["Another one."])) });
  const s2Body = await s2.json().catch(() => null);
  check("★ 运行中再次启动 → 409 warmup_running", s1.status === 201 && s2.status === 409 && s2Body?.error?.code === "warmup_running", `${s2.status}/${s2Body?.error?.code}`);
  const cancel = await fetch(`${BASE}/api/admin/tts-warmup/cancel`, { method: "POST", headers: { cookie: admin.cookie } });
  const cancelBody = await cancel.json().catch(() => null);
  check("★ 取消预热 → 200 state=cancelled", cancel.status === 200 && cancelBody?.state === "cancelled", JSON.stringify(cancelBody));
  const afterCancel = await waitDone(admin.cookie, 5000);
  check("取消后状态为 cancelled", afterCancel?.state === "cancelled", JSON.stringify(afterCancel?.state));

  // 页面 SSR
  const page = await fetch(`${BASE}/admin`, { headers: { cookie: admin.cookie } });
  const html = await page.text();
  check("★ /admin SSR 含 admin-warmup 预热卡", page.status === 200 && html.includes('data-testid="admin-warmup"') && /音色缓存预热/.test(html));
  const noAuth = await fetch(`${BASE}/admin`, { redirect: "manual" });
  check("无 admin cookie 访问 /admin → 跳登录", noAuth.status >= 300 && noAuth.status < 400);
}

try {
  await new Promise((r) => stub.listen(8150, "127.0.0.1", r));
  const child = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
    detached: true,
    cwd: WEB_ROOT,
    env: { ...process.env, ADMIN_PASSWORD, VOICE_SERVICE_URL: "http://127.0.0.1:8150" },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok) { up = true; break; } } catch { /* retry */ }
    }
    check("mock-voice web 实例启动成功（3055）", up);
    if (up) await main();
    else failed += 1;
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ }
  }
} catch (e) { failed += 1; console.error("守卫崩溃：", e); }
finally { stub.close(); console.log(failed === 0 ? "\n结论：全部通过 ✅" : "\n结论：存在失败 ❌"); process.exit(failed > 0 ? 1 : 0); }
