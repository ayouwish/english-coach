-- english-coach web schema v1
-- 字段名严格照抄 docs/api-contract.md §10（冻结）。新增的 web 私有表/字段见文件末尾注释。
PRAGMA foreign_keys = ON;

-- ── users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('parent','child')),
  birth_year          INTEGER,
  age_band            TEXT NOT NULL CHECK (age_band IN ('child','teen','adult')),
  cefr_level          TEXT NOT NULL DEFAULT 'A1',
  native_language     TEXT NOT NULL DEFAULT 'zh',
  avatar              TEXT,
  daily_limit_minutes INTEGER NOT NULL DEFAULT 20,
  allow_free_chat     INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL
);

-- ── sessions ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ── sentences（跟读语料）────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentences (
  id              TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  translation_zh  TEXT NOT NULL,
  level           TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  focus_phonemes  TEXT NOT NULL DEFAULT '[]',
  source          TEXT NOT NULL DEFAULT 'builtin',
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sentences_level ON sentences(level, sort_order);

-- ── attempts（一次跟读评测）─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attempts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sentence_id      TEXT REFERENCES sentences(id) ON DELETE SET NULL,
  mode             TEXT NOT NULL DEFAULT 'scripted',
  reference_text   TEXT NOT NULL,
  recognized_text  TEXT,
  scores_json      TEXT,
  issues_json      TEXT,
  intonation_json  TEXT,
  feedback_json    TEXT,
  audio_path       TEXT,
  ref_audio_url    TEXT,
  duration_ms      INTEGER,
  warnings_json    TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_user_created ON attempts(user_id, created_at DESC);

-- ── phoneme_scores（每次评测逐音素明细，错音本数据源）──────────────────────
CREATE TABLE IF NOT EXISTS phoneme_scores (
  id          TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word        TEXT NOT NULL,
  phoneme     TEXT NOT NULL,
  score       REAL,
  actual      TEXT,
  error_type  TEXT,
  hint_key    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pscores_user_phoneme ON phoneme_scores(user_id, phoneme);
CREATE INDEX IF NOT EXISTS idx_pscores_attempt ON phoneme_scores(attempt_id);

-- ── phoneme_mastery（按用户+音素聚合）────────────────────────────────────────
CREATE TABLE IF NOT EXISTS phoneme_mastery (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phoneme     TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  avg_score   REAL,
  best_score  REAL,
  last_score  REAL,
  trend_json  TEXT NOT NULL DEFAULT '[]',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, phoneme)
);

-- ── srs_cards（间隔重复）────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS srs_cards (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('phoneme','word','sentence')),
  ref           TEXT NOT NULL,
  ease          REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 0,
  due_at        TEXT NOT NULL,
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0,
  last_grade    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_srs_due ON srs_cards(user_id, due_at);

-- ── chat_scenarios（对话场景，min_age 分级）─────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_scenarios (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  title_zh      TEXT NOT NULL,
  setting_zh    TEXT NOT NULL,
  role_prompt   TEXT NOT NULL,
  opening_line  TEXT NOT NULL,
  level         TEXT NOT NULL,
  min_age       INTEGER NOT NULL DEFAULT 6,
  tags          TEXT NOT NULL DEFAULT '[]',
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- ── chat_sessions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_id   TEXT NOT NULL REFERENCES chat_scenarios(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  turn_count    INTEGER NOT NULL DEFAULT 0,
  summary_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, started_at DESC);

-- ── chat_messages ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id               TEXT PRIMARY KEY,
  chat_session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text             TEXT NOT NULL,
  text_zh          TEXT,
  correction_json  TEXT,
  flag             TEXT,
  audio_path       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(chat_session_id, created_at);

-- ── practice_sessions（学习时长统计）────────────────────────────────────────
CREATE TABLE IF NOT EXISTS practice_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  minutes     REAL NOT NULL DEFAULT 0,
  item_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_practice_user_started ON practice_sessions(user_id, started_at DESC);

-- ── audit_log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  actor_user_id  TEXT,
  action         TEXT NOT NULL,
  detail_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

-- ── web 私有扩展表（契约 §10 允许追加可选字段；不改动冻结字段）──────────────
-- 纠正强度 / 音色 等偏好放在独立表，避免污染冻结的 users 列。
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  correction_level  TEXT NOT NULL DEFAULT 'gentle' CHECK (correction_level IN ('gentle','standard','none')),
  tts_voice         TEXT,
  tts_rate          TEXT NOT NULL DEFAULT 'normal' CHECK (tts_rate IN ('slow','normal')),
  updated_at        TEXT NOT NULL
);
