#!/usr/bin/env node
/**
 * task-29「书页材料库」验收守卫（9 条）。
 *
 * 1 创建（带真 JPEG 的 b64）→ 201；列表可见；详情文本正确
 * 2 GET /[id]/image → 200 / image/jpeg / **字节与上传完全一致**
 * 3 图片确实落在 DATA_DIR/materials/ 下
 * 4 重命名 / 编辑文本 → 生效且 sentence_count 重算
 * 5 删除 → 行消失 **且图片文件被删掉**
 * 6 儿童删**别人**的材料 → 403；删自己创建的 → 200
 * 7 GET /api/materials 未登录 → 401
 * 8 路径穿越 → 4xx（不能读到库文件）
 * 9 儿童 /flow HTML 零 IPA、无字面 `**`（且含「我的书页」入口 + 新隐私文案）
 *
 * 用法：BASE_URL=http://127.0.0.1:3020 node scripts/check-materials.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3020").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const DATA_DIR = process.env.DATA_DIR ?? path.join(WEB_ROOT, "data");
const IPA_CHARS = ["θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ɑ", "ɒ", "ɛ", "ˈ", "ˌ"];
const FIXTURE = path.resolve(WEB_ROOT, "..", "tests", "fixtures", "ocr-page.jpg");

let failed = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  rows.push({ ok: Boolean(cond), name });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

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
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

const cleanupIds = [];
function cleanup() {
  if (cleanupIds.length === 0) return;
  const db = new Database(DB_PATH);
  const get = db.prepare("SELECT image_path FROM reading_materials WHERE id = ?");
  const del = db.prepare("DELETE FROM reading_materials WHERE id = ?");
  for (const id of cleanupIds) {
    const row = get.get(id);
    if (row?.image_path) {
      const abs = path.resolve(DATA_DIR, row.image_path);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
    del.run(id);
  }
  db.close();
  console.log(`\n（已清理本次测试创建的 ${cleanupIds.length} 条书页）`);
}

try {
  console.log(`=== 书页材料库（task-29）验收 @ ${BASE} ===`);
  if (!fs.existsSync(FIXTURE)) throw new Error(`缺少 OCR fixture：${FIXTURE}`);
  const jpeg = fs.readFileSync(FIXTURE);
  const imageB64 = jpeg.toString("base64");
  console.log(`fixture: ${FIXTURE}（${(jpeg.length / 1024).toFixed(0)}KB，真实 JPEG）`);

  const girl = await login("girl@example.com", "Girl12345!");
  const dad = await login("dad@example.com", "Dad12345!");

  // ── 1) 创建 + 列表 + 详情 ────────────────────────────────────────────────
  const TEXT = "Hello! My name is Lily. I can see a big tree.";
  const created = await api("/api/materials", {
    cookie: girl,
    method: "POST",
    body: { title: "测试书页 A", text: TEXT, image_b64: imageB64, source: "photo" },
  });
  const id = created.json?.id ?? null;
  if (id) cleanupIds.push(id);
  check("① 创建（带真 JPEG b64）→ 201", created.status === 201 && Boolean(id), `status=${created.status} id=${id}`);
  check("创建响应里 has_image = true", created.json?.has_image === true, `has_image=${created.json?.has_image}`);

  const list = await api("/api/materials?limit=50", { cookie: dad });
  const inList = (list.json?.items ?? []).find((x) => x.id === id);
  check("① 列表能看到（家庭共享：家长也能看到女儿存的）", Boolean(inList), `count=${(list.json?.items ?? []).length}`);
  check("列表字段齐全（title/sentence_count/has_image/source/created_at）", Boolean(inList?.title && typeof inList?.sentence_count === "number" && inList?.has_image === true && inList?.source), JSON.stringify(inList ?? {}).slice(0, 160));
  check("① 句数按标点算出 = 3", inList?.sentence_count === 3, `sentence_count=${inList?.sentence_count}`);

  const detail = await api(`/api/materials/${id}`, { cookie: girl });
  check("① 详情文本正确", detail.status === 200 && detail.json?.text === TEXT, `status=${detail.status}`);
  check("详情带 image_url", Boolean(detail.json?.image_url), detail.json?.image_url ?? "");

  // ── 2) 图片字节一致 ──────────────────────────────────────────────────────
  const imgRes = await fetch(`${BASE}/api/materials/${id}/image`, { headers: { cookie: girl } });
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());
  check("② GET /[id]/image → 200", imgRes.status === 200, `status=${imgRes.status}`);
  check("② Content-Type = image/jpeg", (imgRes.headers.get("content-type") ?? "").includes("image/jpeg"), imgRes.headers.get("content-type") ?? "");
  check(
    "② ★ 返回字节与上传的完全一致",
    imgBytes.length === jpeg.length && imgBytes.equals(jpeg),
    `uploaded=${jpeg.length}B served=${imgBytes.length}B`,
  );
  check("② 缓存策略 private", /private/.test(imgRes.headers.get("cache-control") ?? ""), imgRes.headers.get("cache-control") ?? "");

  // ── 3) 图片落盘位置 ──────────────────────────────────────────────────────
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT image_path FROM reading_materials WHERE id = ?").get(id);
  db.close();
  const absPath = row?.image_path ? path.resolve(DATA_DIR, row.image_path) : null;
  check("③ 图片落在 DATA_DIR/materials/ 下", Boolean(absPath && absPath.startsWith(path.join(DATA_DIR, "materials"))), row?.image_path ?? "");
  check("③ 文件真实存在", Boolean(absPath && fs.existsSync(absPath)), absPath ?? "");

  // ── 4) 重命名 / 编辑文本（句数重算）──────────────────────────────────────
  const renamed = await api(`/api/materials/${id}`, { cookie: girl, method: "PATCH", body: { title: "重命名后的书页" } });
  check("④ 重命名 → 200", renamed.status === 200 && renamed.json?.material?.title === "重命名后的书页", `title=${renamed.json?.material?.title}`);
  const edited = await api(`/api/materials/${id}`, {
    cookie: girl,
    method: "PATCH",
    body: { text: "One sentence. Two sentences! Three? Four." },
  });
  check("④ 编辑文本 → 200", edited.status === 200, `status=${edited.status}`);
  check("④ ★ sentence_count 重算正确 = 4", edited.json?.material?.sentence_count === 4, `sentence_count=${edited.json?.material?.sentence_count}`);
  const verify = await api(`/api/materials/${id}`, { cookie: girl });
  check("④ 文本已生效", verify.json?.text === "One sentence. Two sentences! Three? Four.", verify.json?.text ?? "");

  // ── 6) 权限：儿童删别人的 403；删自己的 200 ───────────────────────────────
  const dadMade = await api("/api/materials", {
    cookie: dad,
    method: "POST",
    body: { title: "爸爸的书页", text: "This is dad's page. It has two sentences." },
  });
  const dadId = dadMade.json?.id ?? null;
  if (dadId) cleanupIds.push(dadId);
  check("（准备）家长创建一条材料", dadMade.status === 201, `status=${dadMade.status}`);
  const girlDeletesDad = await api(`/api/materials/${dadId}`, { cookie: girl, method: "DELETE" });
  check("⑥ ★ 儿童删别人的材料 → 403", girlDeletesDad.status === 403, `status=${girlDeletesDad.status}`);
  const dadStillThere = await api(`/api/materials/${dadId}`, { cookie: dad });
  check("⑥ 被拒绝后材料仍在", dadStillThere.status === 200);

  // ── 5) 删除自己创建的 → 行消失 + 图片文件删除 ────────────────────────────
  const delOwn = await api(`/api/materials/${id}`, { cookie: girl, method: "DELETE" });
  check("⑥ 儿童删自己创建的 → 200", delOwn.status === 200, `status=${delOwn.status}`);
  const afterDel = await api(`/api/materials/${id}`, { cookie: girl });
  check("⑤ 删除后详情 404（行已消失）", afterDel.status === 404, `status=${afterDel.status}`);
  check("⑤ ★ 图片文件也被删掉", Boolean(absPath && !fs.existsSync(absPath)), absPath ?? "");
  const idx = cleanupIds.indexOf(id);
  if (idx >= 0) cleanupIds.splice(idx, 1);

  // ── 7) 未登录 → 401 ──────────────────────────────────────────────────────
  const anon = await api("/api/materials");
  check("⑦ 未登录 GET /api/materials → 401", anon.status === 401, `status=${anon.status}`);

  // ── 8) 路径穿越 ──────────────────────────────────────────────────────────
  const t1 = await api("/api/materials/..%2f..%2fapp.db", { cookie: girl });
  const t2 = await api("/api/materials/%2e%2e%2f%2e%2e%2fapp.db", { cookie: girl });
  const t3 = await api("/api/materials/..%2f..%2fapp.db/image", { cookie: girl });
  const all4xx = [t1, t2, t3].every((r) => r.status >= 400 && r.status < 500);
  check(
    "⑧ ★ 路径穿越全部 4xx（读不到库文件）",
    all4xx,
    `statuses=${[t1.status, t2.status, t3.status].join("/")}`,
  );
  check("⑧ 穿越响应里没有 SQLite 文件头", ![t1.text, t2.text, t3.text].some((t) => t.includes("SQLite format 3")), "");

  // ── 9) 儿童 /flow：零 IPA、无字面 **、新入口与隐私文案 ───────────────────
  const flowRes = await fetch(`${BASE}/flow`, { headers: { cookie: girl } });
  const flowHtml = await flowRes.text();
  const visible = flowHtml.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--\s*-->/g, "");
  const leaked = IPA_CHARS.filter((c) => flowHtml.includes(c));
  check("⑨ 儿童 /flow 200", flowRes.status === 200, `status=${flowRes.status}`);
  check("⑨ ★ 儿童 /flow 零 IPA", leaked.length === 0, `leaked=${leaked.join("")}`);
  check("⑨ ★ /flow 无字面 **", !visible.includes("**"));
  check("⑨ 有「我的书页」入口", flowHtml.includes('data-testid="flow-mode-materials"') && flowHtml.includes("我的书页"));
  check(
    "⑨ 新隐私文案（照片会保存到自己的 NAS / 会上传 AI 服务）",
    flowHtml.includes("你自己的 NAS 上") && flowHtml.includes("DeepSeek") && !flowHtml.includes("不会保存在服务器上"),
  );

  const passed = rows.length - failed;
  console.log(`\n共 ${rows.length} 项断言，通过 ${passed}，失败 ${failed}`);
} catch (err) {
  failed += 1;
  console.error("守卫崩溃：", err);
} finally {
  cleanup();
  const ok = failed === 0;
  console.log(ok ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
  process.exit(ok ? 0 : 1);
}
