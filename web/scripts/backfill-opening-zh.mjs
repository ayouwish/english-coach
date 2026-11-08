#!/usr/bin/env node
/**
 * task-104：历史会话开场白中文回填（幂等）。
 *
 * 扫描 chat_messages 中 role='assistant' 且 text 命中 OPENING_ZH_BY_TEXT 的行：
 *   - text_zh 为空 或 与映射不一致 → 更新为映射值
 *   - 否则跳过
 *
 * 用法：node scripts/backfill-opening-zh.mjs [--dry-run]；支持 DB_PATH。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const dryRun = process.argv.includes("--dry-run");

const { OPENING_ZH_BY_TEXT } = await import(path.join(WEB_ROOT, "src/lib/opening-zh.ts"));

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 5000");
const rows = db.prepare("SELECT id, text, text_zh FROM chat_messages WHERE role = 'assistant'").all();
const update = db.prepare("UPDATE chat_messages SET text_zh = ? WHERE id = ?");
let updated = 0;
let skipped = 0;
let unmatched = 0;
const sample = [];
for (const row of rows) {
  const mapped = OPENING_ZH_BY_TEXT[row.text];
  if (!mapped) {
    unmatched += 1;
    continue;
  }
  if (row.text_zh === mapped) {
    skipped += 1;
    continue;
  }
  if (!dryRun) update.run(mapped, row.id);
  updated += 1;
  if (sample.length < 3) sample.push(`${row.id}: ${String(row.text).slice(0, 30)} → ${mapped}`);
}
db.close();
console.log(`[backfill-opening-zh] DB=${DB_PATH}${dryRun ? "（dry-run）" : ""}`);
console.log(`  扫描 assistant 消息 ${rows.length} 条：更新 ${updated}，已一致跳过 ${skipped}，未命中映射 ${unmatched}`);
for (const s of sample) console.log(`  ↳ ${s}`);
