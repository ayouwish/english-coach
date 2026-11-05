#!/usr/bin/env node
/**
 * 历史对话「左划删除」验收（web 侧）。
 *
 * 断言：
 *  1. /chat 的历史对话列表带左划容器与删除按钮（chat-history-list / chat-history-delete-*）
 *  2. DELETE /api/chat/sessions/:id 删除自己的会话 → 200，DB 行与消息一起消失
 *  3. 删除后 /chat 不再出现该会话；逐句录音文件被清理
 *  4. 重复删除 → 404
 *  5. 删别人的会话 → 404（不泄露存在性）
 *  6. 未登录删除 → 401
 *
 * 用法（需要先起一个实例）：
 *   BASE_URL=http://127.0.0.1:3020 node scripts/check-delete-swipe.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import Database from "better-sqlite3";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3020").replace(/\/$/, "");
const DB_PATH = process.env.DB_PATH ?? path.join(WEB_ROOT, "data/app.db");

let failed = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
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

const ts = Date.now();
const girlSession = `sess_swipe_${ts}_girl`;
const dadSession = `sess_swipe_${ts}_dad`;
const WAV_REL = `audio/u-girl/swipe-${ts}.wav`;
const TINY_WAV = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", "base64");

async function main() {
  console.log(`=== 历史对话左划删除验收 @ ${BASE} ===`);
  const girl = await login("girl@example.com", "Girl12345!");
  const dad = await login("dad@example.com", "Dad12345!");

  // 造数据：女孩一次会话（含一条带录音的消息），爸爸一次会话
  const absWav = path.join(WEB_ROOT, "data", WAV_REL);
  fs.mkdirSync(path.dirname(absWav), { recursive: true });
  fs.writeFileSync(absWav, TINY_WAV);

  const db = new Database(DB_PATH);
  // scenario_id 有外键，取一个真实存在的场景（没有自定义场景时退化为关闭外键检查）
  const scenarioRow = db.prepare("SELECT id FROM chat_scenarios LIMIT 1").get();
  if (!scenarioRow) db.pragma("foreign_keys = OFF");
  const scenarioId = scenarioRow?.id ?? "sc_default";
  const insSession = db.prepare(
    "INSERT INTO chat_sessions (id, user_id, scenario_id, started_at, turn_count, summary_json) VALUES (?, ?, ?, ?, ?, NULL)",
  );
  const insMessage = db.prepare(
    "INSERT INTO chat_messages (id, chat_session_id, role, text, audio_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insSession.run(girlSession, "u-girl", scenarioId, new Date(ts).toISOString(), 1);
  insSession.run(dadSession, "u-dad", scenarioId, new Date(ts + 1).toISOString(), 1);
  insMessage.run(`msg_swipe_${ts}_a`, girlSession, "user", "I built a tower.", WAV_REL, new Date(ts).toISOString());

  try {
    // ── 1) 列表渲染（左划容器 + 删除按钮）────────────────────────────────
    const html = await (await fetch(`${BASE}/chat`, { headers: { cookie: girl } })).text();
    check("★ /chat 有历史对话列表", html.includes('data-testid="chat-history-list"'));
    check("★ 每行套了左划容器（chat-history-delete-root）", html.includes('data-testid="chat-history-delete-root"'));
    check("★ 左划容器里有删除按钮（chat-history-delete）", html.includes('data-testid="chat-history-delete"'));
    check("列表提示左划可删除", /向左滑动可删除/.test(html));
    check("历史条目 testid 仍在（聊天详情入口未破坏）", html.includes('data-testid="chat-history-item"'));

    // ── 2) 未登录删除 → 401 ─────────────────────────────────────────────
    const anon = await fetch(`${BASE}/api/chat/sessions/${girlSession}`, { method: "DELETE" });
    check("未登录删除 → 401", anon.status === 401, `status=${anon.status}`);

    // ── 3) 删别人的会话 → 404 ───────────────────────────────────────────
    const foreign = await fetch(`${BASE}/api/chat/sessions/${dadSession}`, {
      method: "DELETE",
      headers: { cookie: girl },
    });
    check("★ 删别人的会话 → 404（不泄露存在性）", foreign.status === 404, `status=${foreign.status}`);
    const dadStillThere = new Database(DB_PATH, { readonly: true })
      .prepare("SELECT COUNT(*) c FROM chat_sessions WHERE id = ?")
      .get(dadSession).c;
    check("别人的会话没被删掉", dadStillThere === 1, `count=${dadStillThere}`);

    // ── 4) 删自己的会话 → 200，行/消息/录音都清掉 ────────────────────────
    const del = await fetch(`${BASE}/api/chat/sessions/${girlSession}`, {
      method: "DELETE",
      headers: { cookie: girl },
    });
    check("★ 删除自己的会话 → 200", del.status === 200, `status=${del.status}`);
    const ro = new Database(DB_PATH, { readonly: true });
    check(
      "★ DB 会话行已删除",
      ro.prepare("SELECT COUNT(*) c FROM chat_sessions WHERE id = ?").get(girlSession).c === 0,
    );
    check(
      "★ 关联消息已删除",
      ro.prepare("SELECT COUNT(*) c FROM chat_messages WHERE chat_session_id = ?").get(girlSession).c === 0,
    );
    ro.close();
    check("★ 逐句录音文件已清理", !fs.existsSync(absWav));

    const afterHtml = await (await fetch(`${BASE}/chat`, { headers: { cookie: girl } })).text();
    check("★ 删除后 /chat 列表里不再出现该会话", !afterHtml.includes(girlSession));

    // ── 5) 重复删除 → 404 ───────────────────────────────────────────────
    const again = await fetch(`${BASE}/api/chat/sessions/${girlSession}`, {
      method: "DELETE",
      headers: { cookie: girl },
    });
    check("重复删除 → 404", again.status === 404, `status=${again.status}`);
  } finally {
    // 清理：爸爸的会话 + 残留文件
    const cleanup = new Database(DB_PATH);
    cleanup.prepare("DELETE FROM chat_messages WHERE chat_session_id = ?").run(girlSession);
    cleanup.prepare("DELETE FROM chat_sessions WHERE id IN (?, ?)").run(girlSession, dadSession);
    cleanup.close();
    if (fs.existsSync(absWav)) fs.rmSync(absWav);
  }
}

main()
  .then(() => {
    console.log(failed === 0 ? "\n结论：全部通过 ✅" : `\n结论：${failed} 项失败 ❌`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("守卫崩溃：", err);
    process.exit(1);
  });
