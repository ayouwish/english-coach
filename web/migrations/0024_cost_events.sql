-- 0024: 家庭成本台账（task-101）
--
-- 金额用「微元」整数（1 元 = 1_000_000 micro_cny），避免浮点误差；
-- 单价从 web 环境变量读取，voice 只提供原始用量 usage；缺失不记账、不编造。
CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL,            -- llm | image | tts | asr
  provider TEXT,
  model TEXT,
  units_json TEXT,
  cost_micro_cny INTEGER NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_events_family_time ON cost_events(family_id, created_at);
