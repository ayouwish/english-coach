-- 0025: 盲测软取消（task-103）
-- cancelled_at：NULL=未取消；已取消的批次不物理删除（attempts 审计保留）。
ALTER TABLE blind_tests ADD COLUMN cancelled_at TEXT;
