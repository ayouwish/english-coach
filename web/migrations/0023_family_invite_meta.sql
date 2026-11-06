-- 0023: 邀请码使用记录（task-99）
--
-- families.invite_used 已由 0022 添加；这里补"谁/何时使用"，便于家长面板与审计。
ALTER TABLE families ADD COLUMN invite_used_by TEXT;
ALTER TABLE families ADD COLUMN invite_used_at TEXT;
