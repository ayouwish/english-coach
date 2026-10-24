#!/usr/bin/env node
/**
 * 种子数据：node scripts/seed.mjs [--reset-passwords]
 * 幂等：语料/场景 upsert；账号按 email upsert（默认不动已存在账号的密码）。
 * 可用 BOOTSTRAP_DAD_EMAIL / BOOTSTRAP_DAD_PASSWORD 等环境变量覆盖初始账号。
 */
import { DB_PATH, migrate, openDb, seed } from "./lib/db.mjs";

const resetPasswords = process.argv.includes("--reset-passwords");
const db = openDb();
migrate(db);
const summary = seed(db, { resetPasswords });
db.close();

console.log(`[seed] DB=${DB_PATH}`);
console.log(
  `[seed] 用户 ${summary.users} 个 / 语料 ${summary.sentences} 句 / 对话场景 ${summary.scenarios} 个`,
);
for (const a of summary.accounts) {
  console.log(`[seed]   - ${a.role.padEnd(6)} ${a.email}`);
}
console.log(
  resetPasswords ? "[seed] 已重置密码为种子密码" : "[seed] 已存在账号的密码保持不变",
);
