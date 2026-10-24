#!/usr/bin/env node
/** 数据库迁移：node scripts/migrate.mjs [--reset] */
import { DB_PATH, migrate, openDb, resetDb } from "./lib/db.mjs";

const reset = process.argv.includes("--reset");
if (reset) {
  resetDb();
  console.log(`[migrate] 已删除旧库 ${DB_PATH}`);
}

const db = openDb();
const applied = migrate(db);
db.close();

console.log(`[migrate] DB=${DB_PATH}`);
console.log(
  applied.length > 0
    ? `[migrate] 应用了 ${applied.length} 个迁移：${applied.join(", ")}`
    : "[migrate] 无新迁移（已是最新）",
);
