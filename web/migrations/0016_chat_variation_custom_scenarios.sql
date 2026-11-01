-- 0016: 对话场景随机变体 + 用户自定义场景（task-79）
--
-- ① 每个内置场景有 variations；创建会话时随机抽一组，存到会话里（历史回看用当时那组）
ALTER TABLE chat_sessions ADD COLUMN variation_json TEXT;

-- ② 用户自定义场景（仅 owner 可见/可改；儿童强制 child）
CREATE TABLE IF NOT EXISTS user_scenarios (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  title_zh TEXT NOT NULL,
  setting_zh TEXT NOT NULL,
  role_prompt TEXT NOT NULL,
  opening_line TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'A2',
  audience TEXT NOT NULL DEFAULT 'adult',
  variants_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_scenarios_owner ON user_scenarios(owner_id);
