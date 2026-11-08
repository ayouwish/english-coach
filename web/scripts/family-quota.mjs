#!/usr/bin/env node
/** task-105：调整家庭新家庭邀请名额。用法：node scripts/family-quota.mjs --family fam_default --set 100|--add 5 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const family = get("--family") ?? "fam_default";
const setV = get("--set"); const addV = get("--add");
if (setV === undefined && addV === undefined) { console.error("需要 --set N 或 --add N"); process.exit(1); }
const db = new Database(DB_PATH);
const before = db.prepare("SELECT family_invite_quota q FROM families WHERE id = ?").get(family);
if (!before) { console.error(`family 不存在：${family}`); process.exit(1); }
const next = setV !== undefined ? Number(setV) : Number(before.q) + Number(addV);
db.prepare("UPDATE families SET family_invite_quota = ? WHERE id = ?").run(next, family);
console.log(`[family-quota] ${family}: ${before.q} → ${next}`);
db.close();
