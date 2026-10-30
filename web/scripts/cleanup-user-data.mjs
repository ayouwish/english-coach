#!/usr/bin/env node
/**
 * 按「账号 + 时间点」清理测试数据（task-58）
 *
 * 场景：某个账号曾经被拿来做测试，堆了一堆不该属于它的错题/录音/对话。现在要**安全地**清掉，
 *       但必须：① 先自动备份；② 默认只统计（dry-run）；③ 必须显式 --yes 才真删；
 *              ④ 只影响目标账号、只影响时间点**之前**的数据；⑤ 幂等（重跑 0 删除）。
 *
 * 用法：
 *   node scripts/cleanup-user-data.mjs --db /data/app.db \
 *        --user girl@example.com --before 2026-10-30T13:30:00Z            # 统计（等同于 --dry-run）
 *   node scripts/cleanup-user-data.mjs ... --yes                            # 真删（先自动备份）
 *   node scripts/cleanup-user-data.mjs ... --yes --keep-mastery             # 保留 phoneme_mastery
 *
 * 参数：
 *   --db <path>          数据库路径。默认 $DB_PATH，否则 $DATA_DIR/app.db，否则 ./data/app.db（会打印解析后的绝对路径）
 *   --user <email>       目标账号邮箱（**必须精确匹配到一个账号**，找不到就报错退出，绝不做"模糊匹配"）
 *   --before <ISO8601>   删除该时间点**之前**的数据。**必须带时区**（`Z` 或 `+08:00`），
 *                        否则静默按容器本地时区解释 → 可能删错窗口，因此这里直接报错并给出换算示例。
 *   --data-dir <dir>     音频/图片的根目录（DB 里存的是相对路径）。默认 = `--db` 所在目录
 *                        （容器内 `/data/app.db` → `/data`，本地 `web/data/app.db` → `web/data`）
 *   --dry-run            只统计，不修改任何东西（**默认行为**）
 *   --yes                确认执行（与 --dry-run 互斥）
 *   --keep-mastery       保留 phoneme_mastery（默认会删该账号的掌握度聚合行，见下）
 *   --json               以 JSON 输出（便于脚本消费）
 *   -h, --help           看这份说明
 *
 * 删除范围（子表先删、主表后删，全部在一个事务里）：
 *   phoneme_scores    ← attempt_id ∈ 目标 attempts
 *   attempts          ← user_id + created_at < before      （同时收集磁盘 audio_path）
 *   chat_messages     ← chat_session_id ∈ 目标 chat_sessions（同时收集磁盘 audio_path）
 *   chat_sessions     ← user_id + started_at < before
 *   story_retells     ← user_id + created_at < before
 *   practice_sessions ← user_id + started_at < before
 *   srs_cards         ← user_id + created_at < before
 *   blind_tests       ← user_id + started_at < before      （有 user_id 列，直接按账号过滤）
 *   reading_materials ← created_by + created_at < before   （同时删除磁盘图片 image_path）
 *   phoneme_mastery   ← 该账号全部行（**没有时间维度**，无法按 cutoff 部分保留；--keep-mastery 可保留）
 *
 * 明确**不删**：audit_log（审计）、sessions（登录态）、user_prefs（偏好设置）、suggestions（意见反馈）、
 *             sentences / chat_scenarios（语料与场景，全局共享）。
 *
 * 关于 phoneme_mastery 的诚实说明：实现是**按次增量更新**（attempt-service.ts 里读旧值 + 累加），
 *   仓库里**没有**"从 attempts 全量重算掌握度"的代码。所以删掉它之后，历史掌握度统计会归零，
 *   之后随新练习逐步累积，**不会**按剩余历史 attempts 自动重建。
 *   —— 这也正是默认就删它的原因：删掉 = 干净起步；保留 = 里面仍含被删测试数据的贡献（数字偏高）。
 *
 * 安全设计：
 *   · 默认 dry-run；`--yes` 才写。两者同时给 → 报错。
 *   · 备份用 `VACUUM INTO`（一致性快照，不是 cp），**在删除之前**完成并校验（quick_check + attempts 行数比对）；
 *     备份失败 → 立即中止，一行都不删。
 *   · 文件删除只在 DB 事务**提交之后**做（避免"库回滚了、文件没了"）。
 *   · 删除文件前校验路径必须落在 `--data-dir` 内（防 DB 里出现 `../../` 删到别处）；越界只告警不删。
 *   · 没有任何可删项时**不创建备份**、直接返回 0（幂等，重跑不会堆备份文件）。
 *
 * 退出码：0 成功 ｜ 2 参数错误 ｜ 3 账号不存在/有歧义 ｜ 4 备份失败 ｜ 5 数据库错误
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const EXIT = { OK: 0, USAGE: 2, NO_USER: 3, BACKUP: 4, DB: 5 };
const CHUNK = 400; // SQLite 变量上限保守值，分批处理 IN (...)

// ─────────────────────────────────────────────────────────────── 小工具

function die(msg, code = EXIT.USAGE) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(code);
}

/** 中文字符按 2 列宽计算，让表格在终端里对齐 */
function pad(s, width) {
  const str = String(s ?? "");
  let w = 0;
  for (const ch of str) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return str + " ".repeat(Math.max(0, width - w));
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** ISO → 人看得懂的两种时间（UTC + 北京时间） */
function fmtTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const utc = new Date(ms).toISOString().replace(".000Z", "Z");
  const cn = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(ms));
  return `${utc}（北京时间 ${cn}）`;
}

/** 时间戳 → 毫秒；解析不了返回 null（这类行**不删**，只告警） */
function toMs(ts) {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function chunks(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─────────────────────────────────────────────────────────────── 参数

const HELP = (() => {
  const src = fs.readFileSync(new URL(import.meta.url), "utf8");
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  return m ? m[1].replace(/^\s*\* ?/gm, "").trimEnd() : "见脚本头部注释";
})();

function parseArgs(argv) {
  const out = {
    db: null, user: null, before: null, dataDir: null,
    dryRun: false, yes: false, keepMastery: false, json: false, help: false,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) die(`参数 ${flag} 需要一个值`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue; // 兼容 `pnpm db:cleanup -- --user ...`（pnpm 会把 -- 原样传进来）
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : null;
    switch (flag) {
      case "--db": out.db = inline ?? need(i, "--db"); if (inline === null) i++; break;
      case "--user": out.user = inline ?? need(i, "--user"); if (inline === null) i++; break;
      case "--before": out.before = inline ?? need(i, "--before"); if (inline === null) i++; break;
      case "--data-dir": out.dataDir = inline ?? need(i, "--data-dir"); if (inline === null) i++; break;
      case "--dry-run": out.dryRun = true; break;
      case "--yes": out.yes = true; break;
      case "--keep-mastery": out.keepMastery = true; break;
      case "--json": out.json = true; break;
      case "-h": case "--help": out.help = true; break;
      default: die(`未知参数：${a}\n用 --help 看用法`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(EXIT.OK);
}
if (args.yes && args.dryRun) die("--yes 与 --dry-run 不能同时使用（想真删就只用 --yes）");
if (!args.user) die("缺少 --user <email>（这是必需的：不允许不指定账号的大范围删除）");
if (!args.before) die("缺少 --before <ISO8601>（这是必需的：避免把该账号的全部数据都删掉）");

// --before 必须带时区，否则会被按容器本地时区静默解释 —— 这是"删错时间窗口"的头号原因
if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(args.before).trim())) {
  die(
    `--before 必须带时区（现在是 "${args.before}"）。\n` +
      `  例如北京时间 2026-10-30 21:30 要写成：\n` +
      `    --before 2026-10-30T21:30:00+08:00\n` +
      `    --before 2026-10-30T13:30:00Z        ← 等价的 UTC\n` +
      `  这样才不会因为"容器时区是 UTC、你写的是本地时间"而删错窗口。`,
  );
}
const cutoffMs = toMs(String(args.before).trim());
if (cutoffMs === null) die(`--before 不是合法的 ISO 8601 时间："${args.before}"`);

const dbPath = path.resolve(
  args.db ?? process.env.DB_PATH ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "app.db"),
);
if (!fs.existsSync(dbPath)) die(`数据库文件不存在：${dbPath}`, EXIT.DB);
if (!fs.statSync(dbPath).isFile()) die(`--db 不是文件：${dbPath}`, EXIT.DB);

const dataDir = path.resolve(args.dataDir ?? path.dirname(dbPath));
const exec = args.yes; // 只有显式 --yes 才进入执行模式

// ─────────────────────────────────────────────────────────────── 打开（只读规划）

function openReadonly(p) {
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    db.prepare("SELECT count(*) FROM sqlite_master").get(); // 真正触发一次读，尽早暴露问题
    return db;
  } catch (err) {
    die(
      `无法以只读方式打开数据库：${p}\n  ${err.message}\n\n` +
        `  说明：dry-run 必须以只读方式打开，才能保证"不修改任何文件"。\n` +
        `  常见原因：WAL 模式下缺少 -shm 文件（服务已停）。解决办法二选一：\n` +
        `    · 在服务运行中执行（有 -shm）；或\n` +
        `    · 先停掉 web 容器让 WAL 落盘，再执行；或\n` +
        `    · 直接用一份备份库试跑：cp app.db /tmp/t.db 后用 --db /tmp/t.db`,
      EXIT.DB,
    );
  }
}

let db = openReadonly(dbPath);

// 账号必须精确匹配 1 个
const users = db.prepare("SELECT id, email, role, age_band, display_name FROM users WHERE lower(email) = lower(?)").all(args.user);
if (users.length === 0) {
  const all = db.prepare("SELECT email FROM users ORDER BY email").all().map((r) => r.email);
  die(`找不到账号：${args.user}\n  库里现有账号：${all.join(", ") || "(无)"}`, EXIT.NO_USER);
}
if (users.length > 1) die(`账号有歧义（匹配到 ${users.length} 个）：${args.user}`, EXIT.NO_USER);
const user = users[0];

// ─────────────────────────────────────────────────────────────── 规划（纯读）

/** 只保留 "时间 < cutoff" 的行；时间解析不了的行不删（只告警） */
function splitByCutoff(rows, timeCol) {
  const drop = [];
  const keep = [];
  const bad = [];
  for (const r of rows) {
    const ms = toMs(r[timeCol]);
    if (ms === null) bad.push(r);
    else if (ms < cutoffMs) drop.push(r);
    else keep.push(r);
  }
  return { drop, keep, bad };
}

const attemptsTotalBefore = db.prepare("SELECT count(*) c FROM attempts").get().c;
const plan = [];       // { table, drop, keep, basis }
const targets = {};    // 表名 → 要删的 id 列表（子表删除依赖它，务必与 plan 同步）
const warnings = [];
const files = [];      // { rel, abs, kind, exists, bytes, outOfRange }

// ── attempts（并收集音频）
const att = splitByCutoff(
  db.prepare("SELECT id, created_at, audio_path FROM attempts WHERE user_id = ?").all(user.id),
  "created_at",
);
const attIds = att.drop.map((r) => r.id);
plan.push({ table: "attempts", drop: att.drop.length, keep: att.keep.length, basis: "user_id + created_at < cutoff" });
for (const r of att.drop) {
  if (r.audio_path) files.push({ rel: r.audio_path, kind: "音频" });
}

// ── phoneme_scores：按 attempt_id 关联（契约里的标准关系）
//    ★ 同时兜住"孤立行"：历史上若有过不经 FK 的删除，会留下 attempt 已不存在的 score。
//      只按 attempt_id 删会遗漏它们，用户的"清零"目标就达不成。所以取两个集合的并集：
//        ① attempt_id ∈ 将被删的 attempts
//        ② 该账号 + created_at < cutoff（即使 attempt 已不存在）
//      两个条件都限定在"目标账号"与"cutoff 之前"，不会碰到别人或更晚的数据。
const psByAttempt = new Set();
for (const part of chunks(attIds)) {
  if (part.length === 0) continue;
  const marks = part.map(() => "?").join(",");
  for (const r of db.prepare(`SELECT id FROM phoneme_scores WHERE attempt_id IN (${marks})`).all(...part)) psByAttempt.add(r.id);
}
const psByUser = db
  .prepare("SELECT id, created_at FROM phoneme_scores WHERE user_id = ?")
  .all(user.id)
  .filter((r) => { const ms = toMs(r.created_at); return ms !== null && ms < cutoffMs; });
const psDrop = [...new Set([...psByAttempt, ...psByUser.map((r) => r.id)])];
const psTotal = db.prepare("SELECT count(*) c FROM phoneme_scores WHERE user_id = ?").get(user.id).c;
const psOrphans = psByUser.length - psByAttempt.size >= 0 ? psByUser.filter((r) => !psByAttempt.has(r.id)).length : 0;
if (psOrphans > 0) warnings.push(`phoneme_scores 里有 ${psOrphans} 行是孤立记录（其 attempt 已不存在），也会一并清掉`);
plan.push({
  table: "phoneme_scores",
  drop: psDrop.length,
  keep: psTotal - psDrop.length,
  basis: "attempt_id ∈ 将被删的 attempts ∪ 该账号 created_at < cutoff（含孤立行）",
});

// ── chat_sessions + chat_messages
const cs = splitByCutoff(
  db.prepare("SELECT id, started_at FROM chat_sessions WHERE user_id = ?").all(user.id),
  "started_at",
);
const csIds = cs.drop.map((r) => r.id);
plan.push({ table: "chat_sessions", drop: cs.drop.length, keep: cs.keep.length, basis: "user_id + started_at < cutoff" });

let cmDrop = [];
let cmTotal = 0;
for (const part of chunks(csIds)) {
  if (part.length === 0) continue;
  const marks = part.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, audio_path FROM chat_messages WHERE chat_session_id IN (${marks})`).all(...part);
  cmDrop.push(...rows.map((r) => r.id));
  for (const r of rows) if (r.audio_path) files.push({ rel: r.audio_path, kind: "音频" });
}
cmTotal = db
  .prepare(
    "SELECT count(*) c FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE user_id = ?)",
  )
  .get(user.id).c;
plan.push({ table: "chat_messages", drop: cmDrop.length, keep: cmTotal - cmDrop.length, basis: "chat_session_id ∈ 将被删的 chat_sessions" });

// ── 其余按 user + 时间直接过滤的表
for (const spec of [
  { table: "story_retells", time: "created_at", basis: "user_id + created_at < cutoff" },
  { table: "practice_sessions", time: "started_at", basis: "user_id + started_at < cutoff" },
  { table: "srs_cards", time: "created_at", basis: "user_id + created_at < cutoff" },
  { table: "blind_tests", time: "started_at", basis: "user_id + started_at < cutoff（该表有 user_id 列）" },
]) {
  const rows = db.prepare(`SELECT id, ${spec.time} AS t FROM ${spec.table} WHERE user_id = ?`).all(user.id);
  const sp = splitByCutoff(rows, "t");
  plan.push({ table: spec.table, drop: sp.drop.length, keep: sp.keep.length, basis: spec.basis });
  if (sp.bad.length) warnings.push(`${spec.table}: ${sp.bad.length} 行时间戳无法解析，已跳过（不删）`);
  targets[spec.table] = sp.drop.map((r) => r.id);
}

// ── reading_materials（created_by）+ 磁盘图片
const rm = splitByCutoff(
  db.prepare("SELECT id, created_at, image_path FROM reading_materials WHERE created_by = ?").all(user.id),
  "created_at",
);
plan.push({ table: "reading_materials", drop: rm.drop.length, keep: rm.keep.length, basis: "created_by + created_at < cutoff" });
for (const r of rm.drop) if (r.image_path) files.push({ rel: r.image_path, kind: "材料图片" });

// ── phoneme_mastery（无时间维度）
const masteryRows = db.prepare("SELECT phoneme FROM phoneme_mastery WHERE user_id = ?").all(user.id);
if (args.keepMastery) {
  plan.push({ table: "phoneme_mastery", drop: 0, keep: masteryRows.length, basis: "保留（--keep-mastery）" });
} else {
  plan.push({ table: "phoneme_mastery", drop: masteryRows.length, keep: 0, basis: "该账号全部（无时间维度）" });
}

// ── 关联风险提示（不删，只提醒）
const rmIds = rm.drop.map((r) => r.id);
if (rmIds.length) {
  let otherRetells = 0;
  let otherAttempts = 0;
  for (const part of chunks(rmIds)) {
    const marks = part.map(() => "?").join(",");
    otherRetells += db
      .prepare(`SELECT count(*) c FROM story_retells WHERE material_id IN (${marks}) AND user_id IS NOT ?`)
      .get(...part, user.id).c;
    otherAttempts += db
      .prepare(`SELECT count(*) c FROM attempts WHERE material_id IN (${marks}) AND user_id IS NOT ?`)
      .get(...part, user.id).c;
  }
  if (otherRetells > 0) warnings.push(`将删除 ${rmIds.length} 篇阅读材料，另有 ${otherRetells} 条**其他账号**的故事复述指向它们（不会删，但会变成孤儿引用）`);
  if (otherAttempts > 0) warnings.push(`另有 ${otherAttempts} 条**其他账号**的 attempts 指向被删材料（不会删，但会变成孤儿引用）`);
}

// ── 文件解析（必须在 dataDir 内；越界只告警不删）
const dataDirWithSep = dataDir.endsWith(path.sep) ? dataDir : dataDir + path.sep;
for (const f of files) {
  const abs = path.resolve(dataDir, f.rel);
  if (!(abs === dataDir || abs.startsWith(dataDirWithSep))) {
    f.outOfRange = true;
    warnings.push(`路径越界，已跳过（不删）：${f.rel}`);
    continue;
  }
  f.abs = abs;
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) {
      f.exists = true;
      f.bytes = st.size;
    } else {
      f.exists = false;
    }
  } catch {
    f.exists = false;
  }
}

const audioFiles = files.filter((f) => f.kind === "音频" && !f.outOfRange);
const imageFiles = files.filter((f) => f.kind === "材料图片" && !f.outOfRange);
const sumBytes = (arr) => arr.filter((f) => f.exists).reduce((a, f) => a + f.bytes, 0);
const totalDropRows = plan.reduce((a, p) => a + p.drop, 0);
const totalFiles = files.filter((f) => !f.outOfRange);
// 文件字节总数：并进 summary 的 files_bytes（避免单独定义未使用变量）
const totalFileBytes = sumBytes(totalFiles);
void totalFileBytes;

db.close();

// ─────────────────────────────────────────────────────────────── 输出计划

const summary = {
  mode: exec ? "execute" : "dry-run",
  db: dbPath,
  dataDir,
  user: { id: user.id, email: user.email, role: user.role, ageBand: user.age_band, displayName: user.display_name },
  before: { input: args.before, utc: new Date(cutoffMs).toISOString() },
  keepMastery: args.keepMastery,
  plan,
  files: {
    audio: { count: audioFiles.length, existing: audioFiles.filter((f) => f.exists).length, bytes: sumBytes(audioFiles) },
    images: { count: imageFiles.length, existing: imageFiles.filter((f) => f.exists).length, bytes: sumBytes(imageFiles) },
    missing: files.filter((f) => !f.outOfRange && !f.exists).length,
    outOfRange: files.filter((f) => f.outOfRange).length,
  },
  totalDropRows,
  warnings,
};

function printPlan() {
  const W = 22;
  console.log("");
  console.log("english-coach · 清理某个账号的测试数据");
  console.log("═".repeat(78));
  console.log(`${pad("数据库", W)}: ${dbPath}  (${fmtBytes(fs.statSync(dbPath).size)})`);
  console.log(`${pad("数据目录", W)}: ${dataDir}`);
  console.log(`${pad("目标账号", W)}: ${user.email}  (id=${user.id}, role=${user.role}, age_band=${user.age_band})`);
  console.log(`${pad("时间点", W)}: ${fmtTime(new Date(cutoffMs).toISOString())}`);
  console.log(`${pad("含义", W)}: 删除该账号「早于该时刻」的数据；等于/晚于该时刻的一律保留`);
  console.log(`${pad("模式", W)}: ${exec ? "★ 执行（--yes）：会先备份，再在事务里删除" : "DRY RUN（默认）：只统计，不修改任何东西"}`);
  if (args.keepMastery) console.log(`${pad("", W)}  --keep-mastery：保留 phoneme_mastery`);
  console.log("");
  console.log(`${pad("表", 20)}${pad("将删除", 8)}${pad("保留", 8)} 依据`);
  console.log("─".repeat(78));
  for (const p of plan) {
    console.log(`${pad(p.table, 20)}${pad(String(p.drop), 8)}${pad(String(p.keep), 8)} ${p.basis}`);
  }
  console.log("─".repeat(78));
  console.log(`${pad("合计", 20)}${pad(String(totalDropRows), 8)}`);
  console.log("");
  console.log("磁盘文件：");
  console.log(
    `  音频      : ${pad(String(audioFiles.length), 6)} 个待删（存在 ${audioFiles.filter((f) => f.exists).length} / 缺失 ${audioFiles.filter((f) => !f.exists).length}），共 ${fmtBytes(sumBytes(audioFiles))}`,
  );
  console.log(
    `  材料图片  : ${pad(String(imageFiles.length), 6)} 个待删（存在 ${imageFiles.filter((f) => f.exists).length} / 缺失 ${imageFiles.filter((f) => !f.exists).length}），共 ${fmtBytes(sumBytes(imageFiles))}`,
  );
  if (files.some((f) => f.outOfRange)) console.log(`  越界跳过  : ${files.filter((f) => f.outOfRange).length} 个（不在数据目录内，绝不删）`);
  console.log("");
  console.log("有意保留：audit_log（审计，全表不动）、sessions（登录态）、user_prefs（偏好）、");
  console.log("          suggestions（意见反馈）、sentences / chat_scenarios（全局共享语料）");
  if (warnings.length) {
    console.log("");
    console.log("⚠ 提示：");
    for (const w of warnings) console.log(`  · ${w}`);
  }
}

if (!args.json) printPlan();

// ─────────────────────────────────────────────────────────────── 无事可做 → 直接返回（幂等）

if (totalDropRows === 0 && totalFiles.length === 0) {
  if (args.json) {
    console.log(JSON.stringify({ ...summary, result: { noop: true, reason: "没有需要清理的数据（可能已经清理过）" } }, null, 2));
  } else {
    console.log("\n✔ 没有需要清理的数据（该账号在该时间点之前已无相关数据）—— 未修改任何东西、未创建备份。\n");
  }
  process.exit(EXIT.OK);
}

if (!exec) {
  if (args.json) console.log(JSON.stringify({ ...summary, result: { applied: false } }, null, 2));
  else {
    console.log("");
    console.log("这是 DRY RUN —— 没有修改数据库、没有删除任何文件、没有创建备份。");
    console.log("确认无误后，把 --dry-run 换成 --yes 再跑一次（会先自动备份再删）：");
    console.log(`  node ${path.relative(process.cwd(), process.argv[1]) || "scripts/cleanup-user-data.mjs"} \\`);
    console.log(`    --db ${dbPath} --user ${user.email} --before ${args.before} --yes`);
    console.log("");
  }
  process.exit(EXIT.OK);
}

// ─────────────────────────────────────────────────────────────── 执行：备份 → 事务删除 → 删文件

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
let backupPath = path.join(dataDir, `backup-before-cleanup-${stamp}.db`);
for (let i = 1; fs.existsSync(backupPath); i++) {
  backupPath = path.join(dataDir, `backup-before-cleanup-${stamp}-${i}.db`);
}

try {
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch {
  die(`数据目录不可写，无法创建备份：${dataDir}`, EXIT.BACKUP);
}

console.log(`\n[1/3] 备份 → ${backupPath}`);
let rw;
try {
  rw = new Database(dbPath);
  rw.pragma("busy_timeout = 10000");
  rw.prepare("VACUUM INTO ?").run(backupPath);
} catch (err) {
  die(`备份失败，已中止（一行数据都没删）：${err.message}`, EXIT.BACKUP);
}

// 校验备份：能打开 + quick_check 通过 + attempts 行数与删除前一致
try {
  const b = new Database(backupPath, { readonly: true, fileMustExist: true });
  const check = b.pragma("quick_check", { simple: true });
  const backupAttempts = b.prepare("SELECT count(*) c FROM attempts").get().c;
  b.close();
  if (check !== "ok") die(`备份校验失败（quick_check=${check}），已中止`, EXIT.BACKUP);
  if (backupAttempts !== attemptsTotalBefore) {
    die(`备份校验失败：备份里 attempts=${backupAttempts} 行，但删除前是 ${attemptsTotalBefore} 行（不一致 → 中止）`, EXIT.BACKUP);
  }
  summary.backup = {
    path: backupPath,
    bytes: fs.statSync(backupPath).size,
    quickCheck: check,
    attempts: backupAttempts,
    attemptsExpected: attemptsTotalBefore,
  };
  console.log(`      完成：${fmtBytes(summary.backup.bytes)}，quick_check=ok，attempts=${backupAttempts} 行`);
} catch (err) {
  die(`备份文件无法校验，已中止：${err.message}`, EXIT.BACKUP);
}

console.log("[2/3] 事务内删除数据库行");
const deleted = {};
const runInChunks = (sqlPrefix, ids) => {
  let n = 0;
  for (const part of chunks(ids)) {
    const marks = part.map(() => "?").join(",");
    n += rw.prepare(`${sqlPrefix} (${marks})`).run(...part).changes;
  }
  return n;
};

try {
  const tx = rw.transaction(() => {
    deleted.phoneme_scores = runInChunks("DELETE FROM phoneme_scores WHERE id IN", psDrop);
    deleted.attempts = runInChunks("DELETE FROM attempts WHERE id IN", attIds);
    deleted.chat_messages = runInChunks("DELETE FROM chat_messages WHERE chat_session_id IN", csIds);
    deleted.chat_sessions = runInChunks("DELETE FROM chat_sessions WHERE id IN", csIds);
    deleted.story_retells = runInChunks("DELETE FROM story_retells WHERE id IN", targets.story_retells ?? []);
    deleted.practice_sessions = runInChunks("DELETE FROM practice_sessions WHERE id IN", targets.practice_sessions ?? []);
    deleted.srs_cards = runInChunks("DELETE FROM srs_cards WHERE id IN", targets.srs_cards ?? []);
    // 子表（attempts）已删完，再删 blind_tests
    deleted.blind_tests = runInChunks("DELETE FROM blind_tests WHERE id IN", targets.blind_tests ?? []);
    deleted.reading_materials = runInChunks("DELETE FROM reading_materials WHERE id IN", rmIds);
    deleted.phoneme_mastery = args.keepMastery
      ? 0
      : rw.prepare("DELETE FROM phoneme_mastery WHERE user_id = ?").run(user.id).changes;
  });
  rw.pragma("foreign_keys = ON");
  tx();
  console.log("      提交成功");
} catch (err) {
  try { rw.close(); } catch { /* ignore */ }
  die(`删除失败，事务已回滚（数据库未改动，备份仍在）：${err.message}\n  备份：${backupPath}`, EXIT.DB);
}

// 提交后自检 ①：每张表的"实际删除数"必须等于"计划数"，否则说明有行没删掉（静默漏删是最危险的）
const mismatches = plan
  .map((p) => ({ table: p.table, planned: p.drop, actual: deleted[p.table] ?? 0 }))
  .filter((m) => m.planned !== m.actual);
if (mismatches.length) {
  try { rw.close(); } catch { /* ignore */ }
  console.error("\n✖ 自检失败：实际删除数与计划不一致（可能有行没删掉）");
  for (const m of mismatches) console.error(`   ${m.table}: 计划 ${m.planned} / 实际 ${m.actual}`);
  console.error(`\n  数据已部分提交。请先别用该账号，用备份恢复后再排查：${backupPath}\n`);
  process.exit(EXIT.DB);
}
summary.postCounts = {
  attempts: rw.prepare("SELECT count(*) c FROM attempts WHERE user_id = ?").get(user.id).c,
  phoneme_scores: rw.prepare("SELECT count(*) c FROM phoneme_scores WHERE user_id = ?").get(user.id).c,
  chat_sessions: rw.prepare("SELECT count(*) c FROM chat_sessions WHERE user_id = ?").get(user.id).c,
  phoneme_mastery: rw.prepare("SELECT count(*) c FROM phoneme_mastery WHERE user_id = ?").get(user.id).c,
};
rw.close();

console.log("[3/3] 删除磁盘文件（DB 事务已提交，文件删不掉也不影响数据一致性）");
let fileOk = 0;
let fileMissing = 0;
const fileErrors = [];
for (const f of totalFiles) {
  if (!f.exists) { fileMissing++; continue; }
  try {
    fs.unlinkSync(f.abs);
    fileOk++;
  } catch (err) {
    fileErrors.push(`${f.abs}: ${err.message}`);
  }
}
console.log(`      音频 ${audioFiles.filter((f) => f.exists).length} / 图片 ${imageFiles.filter((f) => f.exists).length} → 实际删除 ${fileOk} 个`);
if (fileErrors.length) {
  for (const e of fileErrors) warnings.push(`文件删除失败：${e}`);
}

// ─────────────────────────────────────────────────────────────── 最终汇总

summary.result = {
  applied: true,
  deleted,
  filesDeleted: fileOk,
  filesMissing: fileMissing,
  fileErrors: fileErrors.length,
  backup: backupPath,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(EXIT.OK);
}

console.log("");
console.log("✔ 清理完成");
console.log("─".repeat(78));
for (const p of plan) {
  const d = deleted[p.table] ?? 0;
  if (p.drop > 0 || d > 0) console.log(`  ${pad(p.table, 20)} 删除 ${pad(String(d), 6)} 行（计划 ${p.drop}）`);
}
console.log(`  ${pad("磁盘文件", 20)} 删除 ${pad(String(fileOk), 6)} 个（缺失跳过 ${fileMissing}，失败 ${fileErrors.length}）`);
console.log("");
console.log(`备份：${backupPath}`);
console.log(`      大小 ${fmtBytes(summary.backup?.bytes ?? 0)}，quick_check=ok`);
console.log("");
console.log("如何恢复（**先停 web，避免运行中的进程把状态写回去**）：");
console.log(`  docker compose stop web                                   # 1) 停写入方`);
console.log(`  cp ${backupPath} ${path.join(dataDir, "app.db")}          # 2) 备份覆盖主库（容器内执行时用 docker compose cp）`);
console.log(`  rm -f ${path.join(dataDir, "app.db")}-wal ${path.join(dataDir, "app.db")}-shm   # 3) 清掉 WAL/SHM，避免旧 WAL 回放`);
console.log(`  docker compose start web                                  # 4) 起回来并验证`);
console.log("");
if (!args.keepMastery) {
  console.log("注意：phoneme_mastery 已按你的要求清空。实现是**按次增量更新**，不会从剩余 attempts 全量重算；");
  console.log("      所以历史掌握度统计从零开始，之后随新练习逐步累积。想保留旧数字请在下次清理时加 --keep-mastery。");
  console.log("");
}
console.log("audit_log 未改动（审计保留）；sessions / user_prefs / suggestions / 共享语料均未触及。");
console.log("");
process.exit(EXIT.OK);
