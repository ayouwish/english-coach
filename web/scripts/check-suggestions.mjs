#!/usr/bin/env node
/**
 * task-23「提建议」验收守卫。
 *
 * 断言（对应 task-23 §E）：
 *   1. 儿童提交含 IPA 的建议 → 201，且**响应与库中都不含 IPA**（儿童可见载荷零 IPA）
 *   2. 儿童 GET /api/suggestions → 403
 *   3. 家长 GET → 能看到刚提交那条，字段齐全
 *   4. 超长 / 非法 category / 空内容 → 4xx
 *   5. /suggestions 页面 HTML 无字面 **
 * 额外：PATCH 标记已读/已解决、导出 Markdown（Content-Type + 内容）、
 *       儿童可见页面不回显建议正文、迁移在「已有数据的库」上已生效。
 *
 * 用法：BASE_URL=http://127.0.0.1:3020 node scripts/check-suggestions.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3020").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const IPA_CHARS = ["θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ɑ", "ɒ", "ɛ", "ˈ", "ˌ"];

let failed = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  rows.push({ ok: Boolean(cond), name });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const leaksIn = (text) => IPA_CHARS.filter((c) => text.includes(c));

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`登录失败 ${email}: ${res.status}`);
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (raw.find((c) => c.startsWith("ec_session=")) ?? raw[0] ?? "").split(";")[0];
}

async function api(pathname, { cookie, method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, text, json };
}

const created = [];
function cleanup() {
  if (created.length === 0) return;
  const db = new Database(DB_PATH);
  const del = db.prepare("DELETE FROM suggestions WHERE id = ?");
  for (const id of created) del.run(id);
  db.close();
  console.log(`\n（已清理本次测试插入的 ${created.length} 条建议，不留脏数据）`);
}

try {
  console.log(`=== 「提建议」验收守卫 @ ${BASE} ===`);
  const girl = await login("girl@example.com", "Girl12345!");
  const dad = await login("dad@example.com", "Dad12345!");

  // ── 0) 迁移在有数据的库上已生效 ────────────────────────────────────────────
  const db = new Database(DB_PATH, { readonly: true });
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suggestions'").get();
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='suggestions'")
    .all()
    .map((r) => r.name);
  const counts = {
    users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    attempts: db.prepare("SELECT COUNT(*) c FROM attempts").get().c,
  };
  db.close();
  check("迁移 0005 已生效：suggestions 表存在", Boolean(table?.name), table?.name ?? "(missing)");
  check("索引齐全", indexes.includes("idx_suggestions_created"), indexes.join(","));
  check(
    "已有数据的库上迁移安全（既有表仍有数据、未被重建）",
    counts.users >= 3 && counts.attempts > 0,
    `users=${counts.users} attempts=${counts.attempts}`,
  );

  // ── 1) 儿童提交含 IPA 的建议 → 201 且响应/库里都无 IPA ─────────────────────
  const ipaContent = "我想说：θ 这个音好难，ð 也是，还有 ʃ 和 ʊ，能不能多练？";
  const childPost = await api("/api/suggestions", {
    cookie: girl,
    method: "POST",
    body: { category: "content", content: ipaContent, page: "/practice" },
  });
  check("儿童提交建议 → 201", childPost.status === 201, `status=${childPost.status} body=${childPost.text.slice(0, 80)}`);
  const childId = childPost.json?.id ?? null;
  if (childId) created.push(childId);
  check("★ 响应里不含 IPA", leaksIn(childPost.text).length === 0, `leaked=${leaksIn(childPost.text).join("")}`);
  const db2 = new Database(DB_PATH, { readonly: true });
  const stored = childId
    ? db2.prepare("SELECT user_role, page, category, content, status, created_at, context_json FROM suggestions WHERE id = ?").get(childId)
    : null;
  db2.close();
  check("★ 库里那条儿童建议不含 IPA", Boolean(stored) && leaksIn(stored.content).length === 0, `content=${JSON.stringify(stored?.content)}`);
  check(
    "服务端自己采集了 user_role/page/category/status/context",
    stored?.user_role === "child" &&
      stored?.page === "/practice" &&
      stored?.category === "content" &&
      stored?.status === "open" &&
      typeof stored?.context_json === "string" &&
      stored.context_json.includes("app_version"),
    JSON.stringify({ role: stored?.user_role, page: stored?.page, cat: stored?.category }),
  );

  // ── 2) 儿童 GET → 403 ────────────────────────────────────────────────────
  const childGet = await api("/api/suggestions", { cookie: girl });
  check("★ 儿童 GET /api/suggestions → 403", childGet.status === 403, `status=${childGet.status} code=${childGet.json?.error?.code ?? ""}`);
  const childPage = await fetch(`${BASE}/suggestions`, { headers: { cookie: girl }, redirect: "manual" });
  check("儿童访问 /suggestions 页面 → HTTP 403", childPage.status === 403, `status=${childPage.status}`);

  // ── 3) 家长 GET 看得到、字段齐全 ─────────────────────────────────────────
  const dadGet = await api("/api/suggestions?limit=50", { cookie: dad });
  const item = (dadGet.json?.items ?? []).find((s) => s.id === childId);
  check("家长 GET → 200", dadGet.status === 200, `status=${dadGet.status}`);
  check("★ 家长能看到刚提交那条", Boolean(item), `total=${dadGet.json?.total}`);
  check(
    "字段齐全（角色/页面/分类/正文/状态/时间/上下文）",
    Boolean(item?.user_role && item?.page && item?.category && item?.content && item?.status && item?.created_at && item?.context),
    JSON.stringify({ ...item, content: item?.content?.slice(0, 20) }).slice(0, 200),
  );
  check("状态计数可用", typeof dadGet.json?.counts?.open === "number", JSON.stringify(dadGet.json?.counts));

  // ── 4) 校验：超长 / 非法分类 / 空内容 ────────────────────────────────────
  const tooLong = await api("/api/suggestions", {
    cookie: girl,
    method: "POST",
    body: { category: "other", content: "好".repeat(2001) },
  });
  check("超长内容（2001 字）→ 4xx", tooLong.status >= 400 && tooLong.status < 500, `status=${tooLong.status}`);
  const badCat = await api("/api/suggestions", {
    cookie: girl,
    method: "POST",
    body: { category: "not-a-category", content: "测试" },
  });
  check("非法 category → 400", badCat.status === 400, `status=${badCat.status}`);
  const empty = await api("/api/suggestions", { cookie: girl, method: "POST", body: { category: "other", content: "   " } });
  check("空内容 → 400", empty.status === 400, `status=${empty.status}`);
  const noAuth = await api("/api/suggestions", { method: "POST", body: { category: "other", content: "未登录" } });
  check("未登录提交 → 401", noAuth.status === 401, `status=${noAuth.status}`);

  // ── 5) 家长页面 + 标记 + 导出 ───────────────────────────────────────────
  const pageRes = await fetch(`${BASE}/suggestions`, { headers: { cookie: dad } });
  const pageHtml = await pageRes.text();
  const visibleHtml = pageHtml.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--\s*-->/g, "");
  check("家长 /suggestions 200", pageRes.status === 200, `status=${pageRes.status}`);
  check("★ 页面 HTML 无字面 **", !visibleHtml.includes("**"));
  check("页面渲染出建议条目", pageHtml.includes('data-testid="suggestion-item"'));
  check("有导出入口（下载 .md / 复制 Markdown）", pageHtml.includes('data-testid="download-md"') && pageHtml.includes('data-testid="copy-markdown"'));

  if (childId) {
    const patch = await api(`/api/suggestions/${childId}`, { cookie: dad, method: "PATCH", body: { status: "resolved" } });
    check("家长标记已解决 → 200", patch.status === 200 && patch.json?.status === "resolved", `status=${patch.status}`);
  }
  const childPatch = childId
    ? await api(`/api/suggestions/${childId}`, { cookie: girl, method: "PATCH", body: { status: "read" } })
    : { status: 0 };
  check("儿童标记（PATCH）→ 403", childPatch.status === 403, `status=${childPatch.status}`);

  const exportRes = await fetch(`${BASE}/api/suggestions/export?format=md`, { headers: { cookie: dad } });
  const exportText = await exportRes.text();
  check("导出 Markdown → 200 text/markdown", exportRes.status === 200 && /text\/markdown/.test(exportRes.headers.get("content-type") ?? ""), exportRes.headers.get("content-type") ?? "");
  check(
    "导出 Markdown 含标题与那条建议（且儿童正文已去 IPA）",
    exportText.includes("# English Coach") &&
      exportText.includes("能不能多练") &&
      !exportText.includes("θ"),
    `len=${exportText.length}`,
  );
  check("导出为附件下载", /attachment; filename=/.test(exportRes.headers.get("content-disposition") ?? ""), exportRes.headers.get("content-disposition") ?? "");
  const childExport = await fetch(`${BASE}/api/suggestions/export?format=md`, { headers: { cookie: girl } });
  check("儿童导出 → 403", childExport.status === 403, `status=${childExport.status}`);

  // ── 6) 儿童可见页面不回显建议正文 ────────────────────────────────────────
  const childChat = (await (await fetch(`${BASE}/chat`, { headers: { cookie: girl } })).text()).replace(/<!--\s*-->/g, "");
  check(
    "★ 儿童可见页面不回显建议正文（防 XSS/IPA 二次泄漏）",
    !childChat.includes("能不能多练") && leaksIn(childChat).length === 0,
  );

  const passed = rows.length - failed;
  console.log(`\n共 ${rows.length} 项断言，通过 ${passed}，失败 ${failed}`);
} finally {
  cleanup();
  console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
  process.exit(failed > 0 ? 1 : 0);
}
