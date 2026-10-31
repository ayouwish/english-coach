import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type Database from "better-sqlite3";
import accountsData from "@/data/accounts.json";
import sentencesData from "@/data/sentences.json";
import scenariosData from "@/data/scenarios.json";

type Account = (typeof accountsData)["accounts"][number];
type Sentence = (typeof sentencesData)["sentences"][number];
type Scenario = (typeof scenariosData)["scenarios"][number];

export const BCRYPT_ROUNDS = 10;

/**
 * 种子账号可用环境变量覆盖（部署时改初始密码用）。
 * 变量名：BOOTSTRAP_DAD_EMAIL/PASSWORD、BOOTSTRAP_MOM_EMAIL/PASSWORD、BOOTSTRAP_CHILD_EMAIL/PASSWORD
 * 关闭自动灌种子：AUTO_SEED=0
 */
export function applyAccountOverrides(accounts: Account[] = accountsData.accounts): Account[] {
  const env = process.env;
  const override = (
    acc: Account,
    emailVar: string,
    passVar: string,
  ): Account => ({
    ...acc,
    email: env[emailVar]?.trim() || acc.email,
    password: env[passVar] || acc.password,
  });
  const byId: Record<string, [string, string]> = {
    "u-dad": ["BOOTSTRAP_DAD_EMAIL", "BOOTSTRAP_DAD_PASSWORD"],
    "u-mom": ["BOOTSTRAP_MOM_EMAIL", "BOOTSTRAP_MOM_PASSWORD"],
    "u-girl": ["BOOTSTRAP_CHILD_EMAIL", "BOOTSTRAP_CHILD_PASSWORD"],
  };
  return accounts.map((a) => {
    const vars = byId[a.id];
    return vars ? override(a, vars[0], vars[1]) : a;
  });
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function seedAccounts(
  sqlite: Database.Database,
  accounts: Account[] = applyAccountOverrides(),
) {
  const now = new Date().toISOString();
  const insertUser = sqlite.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, role, birth_year, age_band,
       cefr_level, native_language, avatar, daily_limit_minutes, allow_free_chat, created_at)
     VALUES (@id, @email, @password_hash, @display_name, @role, @birth_year, @age_band,
       @cefr_level, 'zh', @avatar, @daily_limit_minutes, @allow_free_chat, @created_at)
     ON CONFLICT(email) DO UPDATE SET
       display_name=excluded.display_name, role=excluded.role, birth_year=excluded.birth_year,
       age_band=excluded.age_band, cefr_level=excluded.cefr_level, avatar=excluded.avatar,
       daily_limit_minutes=excluded.daily_limit_minutes, allow_free_chat=excluded.allow_free_chat`,
  );
  const insertPrefs = sqlite.prepare(
    `INSERT INTO user_prefs (user_id, correction_level, tts_voice, tts_rate, updated_at)
     VALUES (?, 'gentle', NULL, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  );
  for (const a of accounts) {
    insertUser.run({
      id: a.id,
      email: a.email,
      password_hash: hashPassword(a.password),
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
    // 新儿童账号默认慢速（task-21）；成人默认正常
    insertPrefs.run(a.id, a.ageBand === "child" ? "slow" : "normal", now);
  }
}

export function seedSentences(
  sqlite: Database.Database,
  sentences: Sentence[] = sentencesData.sentences,
) {
  const stmt = sqlite.prepare(
    `INSERT INTO sentences (id, text, translation_zh, level, tags, focus_phonemes, source, sort_order)
     VALUES (@id, @text, @translation_zh, @level, @tags, @focus_phonemes, 'builtin', @sort_order)
     ON CONFLICT(id) DO UPDATE SET
       text=excluded.text, translation_zh=excluded.translation_zh, level=excluded.level,
       tags=excluded.tags, focus_phonemes=excluded.focus_phonemes, sort_order=excluded.sort_order`,
  );
  sentences.forEach((s, i) => {
    stmt.run({
      id: s.id,
      text: s.text,
      translation_zh: s.translation_zh,
      level: s.level,
      tags: JSON.stringify(s.tags),
      focus_phonemes: JSON.stringify(s.focus_phonemes),
      sort_order: i + 1,
    });
  });
}

interface ScenarioLike {
  id: string;
  title: string;
  title_zh: string;
  setting_zh: string;
  role_prompt: string;
  opening_line: string;
  level: string;
  min_age: number;
  tags: string[];
  sort_order: number;
  /** child | adult（task-68）：通过 tags 存 `audience:<x>`，避免改契约表结构 */
  audience?: string;
}

export function seedScenarios(
  sqlite: Database.Database,
  scenarios: Scenario[] = scenariosData.scenarios,
) {
  const stmt = sqlite.prepare(
    `INSERT INTO chat_scenarios (id, title, title_zh, setting_zh, role_prompt, opening_line,
       level, min_age, tags, enabled, sort_order)
     VALUES (@id, @title, @title_zh, @setting_zh, @role_prompt, @opening_line,
       @level, @min_age, @tags, 1, @sort_order)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, title_zh=excluded.title_zh, setting_zh=excluded.setting_zh,
       role_prompt=excluded.role_prompt, opening_line=excluded.opening_line, level=excluded.level,
       min_age=excluded.min_age, tags=excluded.tags, sort_order=excluded.sort_order`,
  );
  scenarios.forEach((s0, i) => {
    const s = s0 as ScenarioLike;
    const tags = [...(s.tags ?? [])].filter((t) => !t.startsWith("audience:"));
    tags.push(`audience:${s.audience === "adult" ? "adult" : "child"}`);
    stmt.run({
      id: s.id,
      title: s.title,
      title_zh: s.title_zh,
      setting_zh: s.setting_zh,
      role_prompt: s.role_prompt,
      opening_line: s.opening_line,
      level: s.level,
      min_age: s.min_age,
      tags: JSON.stringify(tags),
      sort_order: s.sort_order ?? i + 1,
    });
  });
}

/** 只在 users 表为空时灌种子（幂等、不会覆盖真实用户数据）。AUTO_SEED=0 可关闭。 */
export function seedIfEmpty(sqlite: Database.Database): boolean {
  const row = sqlite.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
  if (process.env.AUTO_SEED === "0") {
    if (row.c === 0) {
      console.warn("[bootstrap] AUTO_SEED=0，users 表为空且未灌种子（请手动跑 node scripts/seed.mjs）");
    }
    return false;
  }
  if (row.c > 0) {
    // 语料/场景可以安全地补齐（upsert），但用户不重灌
    seedSentences(sqlite);
    seedScenarios(sqlite);
    return false;
  }
  seedAccounts(sqlite);
  seedSentences(sqlite);
  seedScenarios(sqlite);
  return true;
}

export function newId(prefix = "id"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
