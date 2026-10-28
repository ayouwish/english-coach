/**
 * CLI 用的 SQLite/迁移/种子工具（纯 JS，避免 CLI 依赖 TS 构建产物）。
 * 与 src/db/index.ts、src/db/bootstrap.ts 行为保持一致；数据源同为 src/data/*.json。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

export const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(WEB_ROOT, "data");
export const AUDIO_DIR = path.join(DATA_DIR, "audio");
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "app.db");
export const MIGRATIONS_DIR = path.join(WEB_ROOT, "migrations");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(WEB_ROOT, rel), "utf8"));
}

export function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function migrate(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(db.prepare("SELECT name FROM _migrations").all().map((r) => r.name));
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const done = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      try {
        db.exec(sql);
      } catch (err) {
        // ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS：列已存在时视为已应用
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
      db.prepare("INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    })();
    done.push(file);
  }
  return done;
}

function accountOverrides(accounts) {
  const byId = {
    "u-dad": ["BOOTSTRAP_DAD_EMAIL", "BOOTSTRAP_DAD_PASSWORD"],
    "u-mom": ["BOOTSTRAP_MOM_EMAIL", "BOOTSTRAP_MOM_PASSWORD"],
    "u-girl": ["BOOTSTRAP_CHILD_EMAIL", "BOOTSTRAP_CHILD_PASSWORD"],
  };
  return accounts.map((a) => {
    const vars = byId[a.id];
    if (!vars) return a;
    return {
      ...a,
      email: process.env[vars[0]]?.trim() || a.email,
      password: process.env[vars[1]] || a.password,
    };
  });
}

export function seed(db, { resetPasswords = false } = {}) {
  const accounts = accountOverrides(readJson("src/data/accounts.json").accounts);
  const sentences = readJson("src/data/sentences.json").sentences;
  const scenarios = readJson("src/data/scenarios.json").scenarios;
  const now = new Date().toISOString();
  const summary = { users: 0, sentences: 0, scenarios: 0 };

  const insertUser = db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, role, birth_year, age_band,
       cefr_level, native_language, avatar, daily_limit_minutes, allow_free_chat, created_at)
     VALUES (@id, @email, @password_hash, @display_name, @role, @birth_year, @age_band,
       @cefr_level, 'zh', @avatar, @daily_limit_minutes, @allow_free_chat, @created_at)
     ON CONFLICT(email) DO UPDATE SET
       display_name=excluded.display_name, role=excluded.role, birth_year=excluded.birth_year,
       age_band=excluded.age_band, cefr_level=excluded.cefr_level, avatar=excluded.avatar,
       daily_limit_minutes=excluded.daily_limit_minutes, allow_free_chat=excluded.allow_free_chat
       ${resetPasswords ? ", password_hash=excluded.password_hash" : ""}`,
  );
  const insertPrefs = db.prepare(
    `INSERT INTO user_prefs (user_id, correction_level, tts_voice, tts_rate, updated_at)
     VALUES (?, 'gentle', NULL, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
  );
  const insertSentence = db.prepare(
    `INSERT INTO sentences (id, text, translation_zh, level, tags, focus_phonemes, source, sort_order)
     VALUES (@id, @text, @translation_zh, @level, @tags, @focus_phonemes, 'builtin', @sort_order)
     ON CONFLICT(id) DO UPDATE SET
       text=excluded.text, translation_zh=excluded.translation_zh, level=excluded.level,
       tags=excluded.tags, focus_phonemes=excluded.focus_phonemes, sort_order=excluded.sort_order`,
  );
  const insertScenario = db.prepare(
    `INSERT INTO chat_scenarios (id, title, title_zh, setting_zh, role_prompt, opening_line,
       level, min_age, tags, enabled, sort_order)
     VALUES (@id, @title, @title_zh, @setting_zh, @role_prompt, @opening_line,
       @level, @min_age, @tags, 1, @sort_order)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, title_zh=excluded.title_zh, setting_zh=excluded.setting_zh,
       role_prompt=excluded.role_prompt, opening_line=excluded.opening_line, level=excluded.level,
       min_age=excluded.min_age, tags=excluded.tags, sort_order=excluded.sort_order`,
  );

  db.transaction(() => {
    for (const a of accounts) {
      insertUser.run({
        id: a.id,
        email: a.email,
        password_hash: bcrypt.hashSync(a.password, 10),
        display_name: a.displayName,
        role: a.role,
        birth_year: a.birthYear,
        age_band: a.ageBand,
        cefr_level: a.cefrLevel,
        avatar: a.avatar,
        daily_limit_minutes: a.dailyLimitMinutes,
        allow_free_chat: a.allowFreeChat,
        created_at: now,
      });
      insertPrefs.run(a.id, a.ageBand === "child" ? "slow" : "normal", now);
      summary.users += 1;
    }
    sentences.forEach((s, i) => {
      insertSentence.run({
        id: s.id,
        text: s.text,
        translation_zh: s.translation_zh,
        level: s.level,
        tags: JSON.stringify(s.tags),
        focus_phonemes: JSON.stringify(s.focus_phonemes),
        sort_order: i + 1,
      });
      summary.sentences += 1;
    });
    scenarios.forEach((s, i) => {
      insertScenario.run({
        id: s.id,
        title: s.title,
        title_zh: s.title_zh,
        setting_zh: s.setting_zh,
        role_prompt: s.role_prompt,
        opening_line: s.opening_line,
        level: s.level,
        min_age: s.min_age,
        tags: JSON.stringify(s.tags),
        sort_order: s.sort_order ?? i + 1,
      });
      summary.scenarios += 1;
    });
  })();

  return { ...summary, accounts: accounts.map((a) => ({ email: a.email, role: a.role })) };
}

export function resetDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}
