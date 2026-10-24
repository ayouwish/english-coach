-- 0003: 盲测（blind test）+ 家长自定义语料（契约 v1.1 §13.2）
--
-- 目的（§13.1/§13.3）：
--   1) 盲测记录必须能与日常练习严格区分（attempts.is_blind / blind_test_id），
--      否则"看完反馈立刻重读"带来的分数上涨会污染长期进步判断；
--   2) 家长自定义语料要能标记归属（sentences.owner_user_id），做到家庭内隔离。
--
-- 兼容性：全部是「加列 + 建表 + 索引」，对 v1.0 的旧库可直接升级（不重建、不丢数据）。

-- ── attempts：盲测标记 ───────────────────────────────────────────────────────
ALTER TABLE attempts ADD COLUMN is_blind INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN blind_test_id TEXT;

-- ── sentences：归属（官方语料为 NULL）─────────────────────────────────────────
ALTER TABLE sentences ADD COLUMN owner_user_id TEXT;

-- source 取值按契约统一为 'official' | 'parent'（v1.0 种子写的是 'builtin'）
UPDATE sentences SET source = 'official' WHERE source = 'builtin';

-- ── blind_tests：一批盲测 ────────────────────────────────────────────────────
-- ended_at IS NULL 表示进行中；进行中不得对外暴露任何分数（§13.3 第 1 条）。
CREATE TABLE IF NOT EXISTS blind_tests (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at               TEXT NOT NULL,
  ended_at                 TEXT,
  item_count               INTEGER NOT NULL DEFAULT 0,
  avg_pron                 REAL,
  avg_accuracy             REAL,
  avg_fluency              REAL,
  avg_intonation_distance  REAL,
  sentence_ids_json        TEXT NOT NULL DEFAULT '[]',
  created_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blind_tests_user ON blind_tests(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_blind ON attempts(user_id, is_blind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentences_owner ON sentences(owner_user_id);
