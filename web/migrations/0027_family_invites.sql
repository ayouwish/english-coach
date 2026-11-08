-- 0027: 新家庭邀请名额（task-105）
ALTER TABLE families ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE families ADD COLUMN family_invite_quota INTEGER NOT NULL DEFAULT 0;
UPDATE families SET is_admin = 1, family_invite_quota = 100 WHERE id = 'fam_default';
CREATE TABLE IF NOT EXISTS family_invites (
  code TEXT PRIMARY KEY,
  created_by_user_id TEXT NOT NULL,
  created_by_family_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by_user_id TEXT,
  used_by_family_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_family_invites_creator ON family_invites(created_by_family_id, created_at);
