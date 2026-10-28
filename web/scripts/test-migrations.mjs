#!/usr/bin/env node
/**
 * 迁移升级路径测试（task-5 C.13）：
 *   1) 先造一个「v1.0 旧库」——只应用 0001，并塞入旧格式数据
 *      （srs_cards.id = "<user>:<kind>:<ref>"、sentences.source='builtin'）；
 *   2) 再用与线上完全相同的迁移执行器（scripts/lib/db.mjs migrate）升级；
 *   3) 断言：迁移按顺序全部应用、旧数据不丢、旧 id 被重写、新列/新表就位。
 *
 * 全程在独立的临时 DATA_DIR 里跑，不碰 data/app.db。
 * 用法：node scripts/test-migrations.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP_DIR = path.join(WEB_ROOT, "data", "migration-test");
const MIGRATIONS_DIR = path.join(WEB_ROOT, "migrations");

const results = [];
let failed = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  if (!ok) failed += 1;
  results.push({ ok, name, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function freshDir() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP_DIR, "audio"), { recursive: true });
}

function applyOne(db, file) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  db.exec(sql);
  db.prepare("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
}

console.log("=== 迁移升级路径测试（v1.0 旧库 → v1.1）===\n");

// ── 1) 造旧库（只有 0001 + 旧格式数据）────────────────────────────────────────
freshDir();
const dbPath = path.join(TMP_DIR, "app.db");
let db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

applyOne(db, "0001_init.sql");
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO users (id, email, password_hash, display_name, role, birth_year, age_band, cefr_level, native_language, avatar, daily_limit_minutes, allow_free_chat, created_at)
   VALUES ('u-girl','girl@example.com',?, '女儿','child',2018,'child','A1','zh','🧒',20,0,?)`,
).run(bcrypt.hashSync("Girl12345!", 4), now);
db.prepare(
  `INSERT INTO sentences (id, text, translation_zh, level, tags, focus_phonemes, source, sort_order)
   VALUES ('s-a1-01','Hello! My name is Lily.','你好！我叫 Lily。','A1','[]','["aɪ","l"]','builtin',1)`,
).run();
db.prepare(
  `INSERT INTO attempts (id, user_id, sentence_id, mode, reference_text, scores_json, warnings_json, created_at)
   VALUES ('att_legacy','u-girl','s-a1-01','scripted','Hello! My name is Lily.','{"pron":61}', '[]', ?)`,
).run(now);
// 旧格式 srs_cards.id：把 IPA 写进了主键（0002 要修的就是这个）
db.prepare(
  `INSERT INTO srs_cards (id, user_id, kind, ref, ease, interval_days, due_at, reps, lapses, created_at)
   VALUES ('u-girl:phoneme:θ','u-girl','phoneme','θ',2.5,1,?,1,0,?)`,
).run(now, now);
db.prepare(
  `INSERT INTO srs_cards (id, user_id, kind, ref, ease, interval_days, due_at, reps, lapses, created_at)
   VALUES ('u-girl:word:think','u-girl','word','think',2.5,1,?,1,0,?)`,
).run(now, now);
db.close();

const beforeCounts = (() => {
  const d = new Database(dbPath, { readonly: true });
  const c = {
    users: d.prepare("SELECT COUNT(*) c FROM users").get().c,
    sentences: d.prepare("SELECT COUNT(*) c FROM sentences").get().c,
    attempts: d.prepare("SELECT COUNT(*) c FROM attempts").get().c,
    srs_cards: d.prepare("SELECT COUNT(*) c FROM srs_cards").get().c,
  };
  d.close();
  return c;
})();
check("旧库已就绪（只有 0001 + 旧数据）", beforeCounts.srs_cards === 2 && beforeCounts.attempts === 1, JSON.stringify(beforeCounts));

// ── 2) 用线上同一个迁移执行器升级 ────────────────────────────────────────────
const { migrate } = await import("./lib/db.mjs");
db = new Database(dbPath);
db.pragma("foreign_keys = ON");
const applied = migrate(db);

check(
  "升级时按顺序应用了 0002 与 0003",
  applied.includes("0002_srs_opaque_ids.sql") && applied.includes("0003_blind_tests_and_custom_corpus.sql"),
  `applied=${applied.join(",") || "(none)"}`,
);

const migrations = db.prepare("SELECT name FROM _migrations ORDER BY name").all().map((r) => r.name);
check(
  "_migrations 记录全部迁移且顺序正确（不写死清单，后续新增迁移无需改这里）",
  migrations.length >= 3 &&
    migrations[0] === "0001_init.sql" &&
    migrations.join(",") === [...migrations].sort().join(",") &&
    migrations.includes("0002_srs_opaque_ids.sql") &&
    migrations.includes("0003_blind_tests_and_custom_corpus.sql"),
  migrations.join(","),
);

// 旧数据不丢
const afterCounts = {
  users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
  sentences: db.prepare("SELECT COUNT(*) c FROM sentences").get().c,
  attempts: db.prepare("SELECT COUNT(*) c FROM attempts").get().c,
  srs_cards: db.prepare("SELECT COUNT(*) c FROM srs_cards").get().c,
};
check(
  "旧数据行数不变（不重建、不丢数据）",
  JSON.stringify(afterCounts) === JSON.stringify(beforeCounts),
  `${JSON.stringify(beforeCounts)} → ${JSON.stringify(afterCounts)}`,
);
check(
  "旧的 attempts 内容仍在",
  db.prepare("SELECT reference_text FROM attempts WHERE id='att_legacy'").get()?.reference_text ===
    "Hello! My name is Lily.",
);

// 0002：旧 id 重写为不透明 id，且 IPA 不再出现在主键里
const cardIds = db.prepare("SELECT id, ref FROM srs_cards ORDER BY ref").all();
check(
  "srs_cards 旧 id 已重写为 srs_<随机>",
  cardIds.length === 2 && cardIds.every((c) => /^srs_[0-9a-f]{20}$/.test(c.id)),
  cardIds.map((c) => c.id).join(", "),
);
check(
  "主键里不再含 IPA / 冒号",
  cardIds.every((c) => !c.id.includes(":") && !/[θðɪæʃŋə]/.test(c.id)),
);
check(
  "卡片内容（ref）保持不变",
  cardIds.map((c) => c.ref).sort().join(",") === "think,θ",
  cardIds.map((c) => c.ref).join(","),
);

// 0003：新列/新表
const attemptCols = db.prepare("PRAGMA table_info(attempts)").all().map((c) => c.name);
check("attempts 新增 is_blind / blind_test_id", attemptCols.includes("is_blind") && attemptCols.includes("blind_test_id"), attemptCols.join(","));
const sentenceCols = db.prepare("PRAGMA table_info(sentences)").all().map((c) => c.name);
check("sentences 新增 owner_user_id", sentenceCols.includes("owner_user_id"));
check(
  "旧 attempts 的 is_blind 默认为 0（不会被误当成盲测）",
  db.prepare("SELECT is_blind FROM attempts WHERE id='att_legacy'").get().is_blind === 0,
);
check(
  "source='builtin' 已归一化为 'official'",
  db.prepare("SELECT source FROM sentences WHERE id='s-a1-01'").get().source === "official",
);
check(
  "blind_tests 表已创建",
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blind_tests'").get()?.name ===
    "blind_tests",
);

// 幂等：再跑一次不应重复应用
const second = migrate(db);
check("重复执行迁移是幂等的", second.length === 0, `second run applied=${second.join(",") || "(none)"}`);
db.close();

fs.rmSync(TMP_DIR, { recursive: true, force: true });

const passed = results.length - failed;
console.log(`\n共 ${results.length} 项断言，通过 ${passed}，失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
