-- 0021: 多家庭账号（task-97/98）
--
-- 用户需求：朋友的家人也要用，但家庭之间必须隔离。
--  - families：家庭 + 邀请码（家长可重置）
--  - users.family_id：NOT NULL；现有用户全部回填到默认家庭 fam_default（「我家」）
--  - reading_materials.family_id：回填为创建者的家庭（旧数据 created_by 为空 → fam_default）
-- 迁移幂等：CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE / 回填 UPDATE 可重复执行。
CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- 默认家庭（老账号的归宿）；邀请码固定且不参与轮换，任务 98 之后可由家长在 /parent 重置
INSERT OR IGNORE INTO families (id, name, invite_code, created_by, created_at)
VALUES ('fam_default', '我家', 'DEFAULT1', 'u-dad', datetime('now'));

ALTER TABLE users ADD COLUMN family_id TEXT NOT NULL DEFAULT 'fam_default';
CREATE INDEX IF NOT EXISTS idx_users_family ON users(family_id);
UPDATE users SET family_id = 'fam_default' WHERE family_id IS NULL OR family_id = '';

ALTER TABLE reading_materials ADD COLUMN family_id TEXT NOT NULL DEFAULT 'fam_default';
CREATE INDEX IF NOT EXISTS idx_materials_family ON reading_materials(family_id);
UPDATE reading_materials
SET family_id = COALESCE(
  (SELECT u.family_id FROM users u WHERE u.id = reading_materials.created_by),
  'fam_default'
);
