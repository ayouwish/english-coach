-- 0028: 后台系统设置 + 新家庭邀请名额（task-111）
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO system_settings (key, value, updated_at)
VALUES ('family_invite_quota_remaining', '100', datetime('now'));
