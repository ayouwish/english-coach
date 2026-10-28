-- 0006: 连读模式的异步评分字段（task-24）
--
-- attempts 增加 status / scored_at / error：
--   status ∈ pending | scoring | done | failed
--   历史行（同步评完的）默认 'done'，不破坏任何既有数据。
--
-- 注意：SQLite 的 ALTER TABLE ADD COLUMN **不支持 IF NOT EXISTS**。
-- 迁移执行器已做幂等封装：记录在 _migrations 里保证只跑一次；
-- 并且执行器会把 "duplicate column name" 视为"该列已存在"继续（可重复执行）。
ALTER TABLE attempts ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE attempts ADD COLUMN scored_at TEXT;
ALTER TABLE attempts ADD COLUMN error TEXT;

CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status, created_at DESC);
