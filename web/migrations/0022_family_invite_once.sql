-- 0022: 邀请码一次性 + 家长上限（task-99）
--
-- 邀请码用一次即失效（invite_used=1），家长可 rotate 生成新码给下一位家长。
-- 家长上限（≤3）在应用层校验，不需要额外列。
ALTER TABLE families ADD COLUMN invite_used INTEGER NOT NULL DEFAULT 0;
