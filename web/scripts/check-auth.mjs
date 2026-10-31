#!/usr/bin/env node
/**
 * task-60 验收：Bearer Token 认证（移动端）+ Cookie 双模式并存。
 *
 * 断言：
 *  1. POST /api/auth/token 正确密码 → 200（Bearer/access/refresh/expires_in），响应**不含密码/hash**
 *  2. 错误密码 → 401；连续 5 次错 → 第 6 次 429（内存计数，60s）
 *  3. Authorization: Bearer <access> → /api/auth/me、/api/sentences 200
 *  4. **Cookie 回归**：Cookie 登录后 /api/auth/me → 200
 *  5. 伪造/篡改 access → 401；过期 access（AUTH_ACCESS_TTL_S=1）→ 401
 *  6. refresh 轮换：第一次 200 返回新 refresh；**旧 refresh 再用 → 401**；新 refresh 可用
 *  7. revoke 后：refresh → 401；该 refresh 配对的 access → 401；重复 revoke 幂等 204
 *  8. 并发 refresh（同一 refresh 同时两次）→ **只有一次成功**（另一个 401）
 *  9. 迁移 0011 在**有数据**的库上生效；库里只存 sha256（不是明文 token）
 *
 * 用法：BASE_URL=http://127.0.0.1:3030 node scripts/check-auth.mjs
 * （脚本会自己起一个 AUTH_ACCESS_TTL_S=1 的实例来测过期，不影响主实例）
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

/** 杀掉整条进程组：`next start` 是 pnpm 的子进程，只 kill pnpm 会留下孤儿占着端口，
 *  导致后续守卫静默跑到旧实例上（"假失败"）。因此 spawn 时 detached:true，这里杀进程组。 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
}


const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.AUTH_PORT ?? 3030);
const BASE = (process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const UA = "check-auth-guard";

let failed = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  rows.push({ ok: Boolean(cond), name });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const post = async (pathname, body, extraHeaders = {}) => {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 204 无 body */
  }
  return { status: res.status, json, text, headers: res.headers };
};
const get = async (pathname, headers = {}) => {
  const res = await fetch(`${BASE}${pathname}`, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const TEST_STARTED_AT = new Date().toISOString();
const createdFiles = [];
function cleanup() {
  // 清掉本次测试签发的 token 行：直签的带 UA 标记；轮换出来的 user_agent 是 'node'
  // → 用"测试开始时间之后 + 这两类 UA"精确清理，不动任何真实 token
  const db = new Database(DB_PATH);
  const info = db
    .prepare("DELETE FROM auth_tokens WHERE created_at >= ? AND (user_agent = ? OR user_agent = 'node' OR user_agent IS NULL)")
    .run(TEST_STARTED_AT, UA);
  db.close();
  if (Number(info.changes) > 0) console.log(`\n（已清理本次测试签发并残留的 ${info.changes} 条 token）`);
  void createdFiles;
}

async function main() {
  console.log(`=== Bearer Token 认证验收 @ ${BASE} ===`);

  // ── 0) 迁移（有数据的库上）────────────────────────────────────────────────
  const db = new Database(DB_PATH, { readonly: true });
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_tokens'").get();
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='auth_tokens'")
    .all()
    .map((r) => r.name);
  const sessionsCount = db.prepare("SELECT COUNT(*) c FROM sessions").get().c;
  db.close();
  check("迁移 0011：auth_tokens 表存在", Boolean(table?.name), table?.name ?? "(missing)");
  check("索引齐全（user/hash/parent）", ["idx_auth_tokens_user", "idx_auth_tokens_hash", "idx_auth_tokens_parent"].every((i) => indexes.includes(i)), indexes.join(","));
  check("历史 Cookie 会话不受影响（sessions 行仍在）", sessionsCount > 0, `sessions=${sessionsCount}`);

  // ── 1) token 登录 ────────────────────────────────────────────────────────
  const ok = await post("/api/auth/token", { email: "girl@example.com", password: "Girl12345!", user_agent: UA });
  console.log(`   ↳ token 登录：HTTP ${ok.status} · ${JSON.stringify(ok.json).slice(0, 220)}`);
  check("★ 正确密码 → 200 且返回 Bearer token", ok.status === 200 && ok.json?.token_type === "Bearer" && Boolean(ok.json?.access_token) && Boolean(ok.json?.refresh_token), `status=${ok.status}`);
  check("expires_in 存在（AUTH_ACCESS_TTL_S 生效）", typeof ok.json?.expires_in === "number" && ok.json.expires_in > 0, String(ok.json?.expires_in));
  check("★ 响应不含密码/hash", !/password|\\$2[aby]\\$/i.test(ok.text), "no password fields");
  check("响应含用户信息（与 Cookie 登录同结构）", ok.json?.user?.id === "u-girl" && ok.json?.user?.role === "child", JSON.stringify(ok.json?.user ?? {}).slice(0, 100));
  const access = ok.json?.access_token ?? "";
  const refresh = ok.json?.refresh_token ?? "";

  // 库里只存 sha256（不是明文）
  {
    const db2 = new Database(DB_PATH, { readonly: true });
    const row = db2.prepare("SELECT token_hash FROM auth_tokens WHERE user_agent = ? AND kind = 'access' ORDER BY created_at DESC LIMIT 1").get(UA);
    const plain = db2.prepare("SELECT COUNT(*) c FROM auth_tokens WHERE token_hash = ?").get(access).c;
    db2.close();
    check("★ 库里存的是 sha256（64 位十六进制），不是明文 token", /^[0-9a-f]{64}$/.test(row?.token_hash ?? "") && plain === 0, String(row?.token_hash ?? "").slice(0, 16) + "…");
  }

  // 错误密码 → 401
  const bad = await post("/api/auth/token", { email: "mom@example.com", password: "not-the-password", user_agent: UA });
  check("错误密码 → 401", bad.status === 401, `status=${bad.status}`);

  // ── 2) Bearer 访问受保护接口 ─────────────────────────────────────────────
  const bearer = { authorization: `Bearer ${access}` };
  const me = await get("/api/auth/me", bearer);
  check("★ Bearer access → /api/auth/me 200 且是同一用户", me.status === 200 && me.json?.user?.id === "u-girl", `status=${me.status} id=${me.json?.user?.id ?? ""}`);
  const sentences = await get("/api/sentences", bearer);
  check("★ Bearer access → /api/sentences 200", sentences.status === 200 && Array.isArray(sentences.json?.sentences), `status=${sentences.status}`);

  // ── 3) Cookie 回归 ──────────────────────────────────────────────────────
  {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "girl@example.com", password: "Girl12345!" }),
    });
    const raw = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [];
    const cookie = (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
    const meCookie = await get("/api/auth/me", { cookie });
    check("★ Cookie 登录仍然可用（回归）", login.status === 200 && meCookie.status === 200 && meCookie.json?.user?.id === "u-girl", `login=${login.status} me=${meCookie.status}`);
    check("Cookie 与 Bearer 落到同一个 userId", meCookie.json?.user?.id === me.json?.user?.id, `${meCookie.json?.user?.id} == ${me.json?.user?.id}`);
  }

  // ── 4) 伪造 / 过期 ──────────────────────────────────────────────────────
  const forged = await get("/api/sentences", { authorization: `Bearer ${access.slice(0, -4)}AAAA` });
  check("★ 篡改 access → 受保护接口 401", forged.status === 401, `status=${forged.status}`);
  const forged2 = await get("/api/sentences", { authorization: "Bearer not-a-real-token" });
  check("★ 伪造 access → 受保护接口 401", forged2.status === 401, `status=${forged2.status}`);
  const forgedMe = await get("/api/auth/me", { authorization: "Bearer not-a-real-token" });
  check("/api/auth/me 的既有语义：未登录 200 + user=null", forgedMe.status === 200 && forgedMe.json?.user === null, `status=${forgedMe.status}`);
  // 重启实例用 AUTH_ACCESS_TTL_S=1 只用于过期测试？直接用当前实例的 TTL 判断环境
  // 这里启动一个 TTL=1 的独立实例（不影响主实例），验证过期
  {
    const port2 = PORT + 11;
    const child = spawn("pnpm", ["exec", "next", "start", "-p", String(port2)], {
      detached: true,
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        AUTH_ACCESS_TTL_S: "1",
        VOICE_SERVICE_URL: process.env.VOICE_SERVICE_URL ?? "http://127.0.0.1:8100",
      },
      stdio: "ignore",
    });
    try {
      let up = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const r = await fetch(`http://127.0.0.1:${port2}/api/health`, { signal: AbortSignal.timeout(1500) });
          if (r.ok) {
            up = true;
            break;
          }
        } catch {
          /* retry */
        }
      }
      check("TTL=1s 实例启动成功（过期用例）", up);
      if (up) {
        const t = await fetch(`http://127.0.0.1:${port2}/api/auth/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "girl@example.com", password: "Girl12345!", user_agent: UA }),
        });
        const tj = await t.json().catch(() => null);
        check("TTL=1s 实例签发 token（expires_in=1）", tj?.expires_in === 1, String(tj?.expires_in));
        const before = await fetch(`http://127.0.0.1:${port2}/api/sentences`, { headers: { authorization: `Bearer ${tj?.access_token}` } });
        check("过期前受保护接口可用（200）", before.status === 200, `status=${before.status}`);
        await new Promise((r) => setTimeout(r, 1600));
        const after = await fetch(`http://127.0.0.1:${port2}/api/sentences`, { headers: { authorization: `Bearer ${tj?.access_token}` } });
        check("★ 过期 access → 受保护接口 401", after.status === 401, `status=${after.status}`);
      }
    } finally {
      killTree(child);
    }
  }

  // ── 5) refresh 轮换 ─────────────────────────────────────────────────────
  const r1 = await post("/api/auth/refresh", { refresh_token: refresh });
  check("★ refresh 第一次 → 200 且返回新 refresh", r1.status === 200 && Boolean(r1.json?.access_token) && Boolean(r1.json?.refresh_token) && r1.json?.refresh_token !== refresh, `status=${r1.status}`);
  const r1Old = await post("/api/auth/refresh", { refresh_token: refresh });
  check("★ 旧 refresh 再用 → 401（一次性）", r1Old.status === 401, `status=${r1Old.status}`);
  const r1New = await post("/api/auth/refresh", { refresh_token: r1.json?.refresh_token });
  check("新 refresh 可用（继续轮换）", r1New.status === 200, `status=${r1New.status}`);

  // ── 6) revoke（幂等 + 连带 access）─────────────────────────────────────
  const revoke = await post("/api/auth/revoke", { refresh_token: r1New.json?.refresh_token });
  check("★ revoke → 204", revoke.status === 204, `status=${revoke.status}`);
  const revokeAgain = await post("/api/auth/revoke", { refresh_token: r1New.json?.refresh_token });
  check("重复 revoke 幂等 → 204", revokeAgain.status === 204, `status=${revokeAgain.status}`);
  const afterRevoke = await post("/api/auth/refresh", { refresh_token: r1New.json?.refresh_token });
  check("★ revoke 后 refresh → 401", afterRevoke.status === 401, `status=${afterRevoke.status}`);
  const accessAfterRevoke = await get("/api/sentences", { authorization: `Bearer ${r1New.json?.access_token}` });
  check("★ 被吊销 refresh 配对的 access → 受保护接口 401", accessAfterRevoke.status === 401, `status=${accessAfterRevoke.status}`);

  // ── 7) 并发 refresh：只能一次成功 ───────────────────────────────────────
  {
    const login2 = await post("/api/auth/token", { email: "girl@example.com", password: "Girl12345!", user_agent: UA });
    const rt = login2.json?.refresh_token;
    const [a, b] = await Promise.all([
      post("/api/auth/refresh", { refresh_token: rt }),
      post("/api/auth/refresh", { refresh_token: rt }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check(
      "★ 并发 refresh：只有一次成功（另一次 401）",
      statuses[0] === 200 && statuses[1] === 401,
      `statuses=${a.status}/${b.status}`,
    );
  }

  // ── 8) 防爆破：5 次失败 → 第 6 次 429 ───────────────────────────────────
  {
    const email = `nobody-${Date.now()}@example.com`;
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const r = await post("/api/auth/token", { email, password: "wrong-pass", user_agent: UA });
      lastStatus = r.status;
    }
    const sixth = await post("/api/auth/token", { email, password: "wrong-pass", user_agent: UA });
    check("5 次密码错仍返回 401", lastStatus === 401, `5th=${lastStatus}`);
    check("★ 第 6 次 → 429（同 email 60s 内拦截）", sixth.status === 429, `status=${sixth.status} msg=${sixth.json?.error?.message ?? ""}`);
    const correctAfterBlock = await post("/api/auth/token", { email, password: "whatever", user_agent: UA });
    check("被拦截期间继续 429（不泄露密码对错）", correctAfterBlock.status === 429, `status=${correctAfterBlock.status}`);
  }

  console.log(`\n共 ${rows.length} 项断言，通过 ${rows.length - failed}，失败 ${failed}`);
}

try {
  await main();
} catch (err) {
  failed += 1;
  console.error("守卫崩溃：", err);
} finally {
  cleanup();
  console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
  process.exit(failed > 0 ? 1 : 0);
}
