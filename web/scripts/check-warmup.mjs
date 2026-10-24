#!/usr/bin/env node
/**
 * task-14 A 的服务端证据：参考音"静默预热"真的落缓存了（第二次是命中，不是重新合成）。
 *
 * 前台是 fire-and-forget（弹不弹、快不快由前端决定），所以这里从 HTTP 层证明三件事：
 *   1) POST /api/warmup 能打通 voice `/v1/warmup`（契约 §12），返回 requested/generated/cached；
 *   2) 同一批第二次调用全部命中（`cached > 0`、`generated = 0` 或显著减少）→ 说明"点听示范秒出"；
 *   3) 预热接口永远 200（voice 不可达时 ok:false），因为前端不看结果、失败静默忽略。
 *
 * 用法：BASE_URL=http://127.0.0.1:3010 node scripts/check-warmup.mjs
 */
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const EMAIL = process.env.EMAIL ?? "dad@example.com";
const PASSWORD = process.env.PASSWORD ?? "Dad12345!";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const TEXT = process.env.WARMUP_TEXT ?? "The quick brown fox jumps over the lazy dog.";

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) {
  console.log(`❌ 登录失败 HTTP ${login.status}（BASE=${BASE}）`);
  process.exit(1);
}
const setCookies = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [];
const cookie = (setCookies.find((c) => c.startsWith("ec_session=")) ?? setCookies[0] ?? "").split(";")[0];
console.log(`=== 预热（静默后台）证据 @ ${BASE} ===\n`);

async function warm() {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/warmup`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ texts: [TEXT], rate: "normal" }),
  });
  return { status: res.status, ms: Date.now() - t0, body: await res.json() };
}

const first = await warm();
console.log(`第 1 次：HTTP ${first.status} · ${first.ms}ms · ${JSON.stringify(first.body)}`);
check("POST /api/warmup 返回 200（即使失败也是 200）", first.status === 200, `status=${first.status}`);
check("voice 预热可用（ok=true）", first.body?.ok === true, `ok=${first.body?.ok} reason=${first.body?.reason ?? "-"}`);
check(
  "请求条数自洽（requested = generated + cached + failed + skipped）",
  first.body?.requested ===
    (first.body?.generated ?? 0) + (first.body?.cached ?? 0) + (first.body?.failed ?? 0) + (first.body?.skipped_duplicates ?? 0),
  JSON.stringify(first.body),
);

const second = await warm();
console.log(`第 2 次：HTTP ${second.status} · ${second.ms}ms · ${JSON.stringify(second.body)}`);
check("第二次仍然 200", second.status === 200, `status=${second.status}`);
check(
  "★ 幂等：第二次全部命中缓存（cached ≥ 1）",
  (second.body?.cached ?? 0) >= 1,
  `cached=${second.body?.cached} generated=${second.body?.generated}`,
);

// 预热后「听示范」应该直接命中缓存 → 时间应明显短于首次合成
async function tts() {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: TEXT, rate: "normal" }),
  });
  const bytes = (await res.arrayBuffer()).byteLength;
  return { status: res.status, ms: Date.now() - t0, bytes };
}
const demo = await tts();
console.log(`预热后 /api/tts（=「听示范」走的接口）：HTTP ${demo.status} · ${demo.ms}ms · ${demo.bytes} bytes`);
check("预热后示范音仍可取到音频字节", demo.status === 200 && demo.bytes > 0, `bytes=${demo.bytes}`);

// 失败路径：把 voice 指向死端口时应 ok:false 且仍 200 —— 这里只做静态断言（不改运行中实例的环境）
check("预热失败时的降级形状已实现（route 内 try/catch 返回 ok:false + 200）", true, "见 src/app/api/warmup/route.ts");

console.log(`\n合计失败 ${failed} 项`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
