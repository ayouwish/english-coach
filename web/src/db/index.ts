import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");
export const AUDIO_DIR = path.join(DATA_DIR, "audio");
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "app.db");
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.join(process.cwd(), "migrations");

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * 幂等执行 migrations/*.sql。用 _migrations 记账，重复调用无副作用。
 * 用 CREATE TABLE IF NOT EXISTS 写成，所以即使记账表丢失也能恢复。
 */
export function runMigrations(sqlite: Database.Database, dir: string = MIGRATIONS_DIR): string[] {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  if (!fs.existsSync(dir)) {
    throw new Error(
      `migrations 目录不存在：${dir}（standalone 部署请把 migrations/ 复制进镜像，或用 MIGRATIONS_DIR 指定）`,
    );
  }
  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const tx = sqlite.transaction(() => {
      try {
        sqlite.exec(sql);
      } catch (err) {
        // SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS：
        // 若列已存在（例如迁移文件被部分执行过），视为已应用，保证可重复执行。
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
      sqlite
        .prepare("INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)")
        .run(file, new Date().toISOString());
    });
    tx();
    done.push(file);
  }
  return done;
}

type GlobalDb = {
  sqlite?: Database.Database;
  db?: Db;
  bootstrapped?: boolean;
};

const globalForDb = globalThis as unknown as { __englishCoachDb?: GlobalDb };

function createSqlite(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
}

export function getSqlite(): Database.Database {
  globalForDb.__englishCoachDb ??= {};
  const store = globalForDb.__englishCoachDb;
  if (!store.sqlite) {
    store.sqlite = createSqlite();
  }
  return store.sqlite;
}

export function getDb(): Db {
  globalForDb.__englishCoachDb ??= {};
  const store = globalForDb.__englishCoachDb;
  if (!store.db) {
    store.db = drizzle(getSqlite(), { schema });
  }
  return store.db;
}

/** 运行时自举：建表 + 首次运行时灌种子数据（users 表为空才算首次）。 */
export async function ensureBootstrap(): Promise<void> {
  globalForDb.__englishCoachDb ??= {};
  const store = globalForDb.__englishCoachDb;
  if (store.bootstrapped) return;
  runMigrations(getSqlite());
  const { seedIfEmpty } = await import("./bootstrap");
  await seedIfEmpty(getSqlite());
  // task-24：把上次进程遗留的 pending/scoring 标成 failed（否则永远卡"评分中"）
  try {
    const { recoverStuckAttempts } = await import("@/lib/async-scoring");
    const recovered = recoverStuckAttempts();
    if (recovered > 0) console.warn(`[bootstrap] 恢复遗留的异步评分记录：${recovered} 条 → failed`);
  } catch (err) {
    console.warn("[bootstrap] 恢复遗留评分失败（不影响启动）", err);
  }
  store.bootstrapped = true;
}

export { schema };
