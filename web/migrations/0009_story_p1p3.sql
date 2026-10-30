-- 0009: 故事模式 P1（录音归属/回放）+ P3（复述记录）（task-50）
--
-- P1: 连读的 attempts 需要知道"这次读的是哪个故事"，才能回放"听我上次读的"，
--     所以给 attempts 加 material_id（NULL = 不是从故事/材料读的，历史行不受影响）。
-- P3: 复述评估结果（覆盖度/讲到的点/漏掉的点/中英反馈）按 story 存下来，故事详情里可回看。
--
-- 幂等：ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，迁移执行器会把
-- "duplicate column name" 视为"该列已存在"继续（可重复执行）。
ALTER TABLE attempts ADD COLUMN material_id TEXT;

CREATE INDEX IF NOT EXISTS idx_attempts_material ON attempts(material_id, created_at DESC);

CREATE TABLE IF NOT EXISTS story_retells (
  id            TEXT PRIMARY KEY,
  material_id   TEXT,
  user_id       TEXT,
  story_sentences_json TEXT,
  transcript    TEXT,
  coverage      REAL,
  covered_json  TEXT,
  missing_json  TEXT,
  feedback_zh   TEXT,
  feedback_en   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_story_retells_material ON story_retells(material_id, created_at DESC);
