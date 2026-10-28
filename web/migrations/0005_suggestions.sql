-- 0005: 「提建议」（task-23）
--
-- 家里人在使用中随手留建议/吐槽，家长集中查看并导出，用于持续迭代产品。
-- 幂等：CREATE TABLE / INDEX IF NOT EXISTS，可安全重复执行；
-- 只新增表与索引，不改动任何既有表（对已有数据的库是纯追加）。
CREATE TABLE IF NOT EXISTS suggestions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,                              -- 提交人（本应用都要登录，正常有值）
  user_role    TEXT,                              -- parent | child
  page         TEXT,                              -- 提交时所在页面路径，如 /practice
  category     TEXT,                              -- experience | content | feature | bug | other
  content      TEXT NOT NULL,                     -- 建议正文（trim 后 1–2000 字）
  context_json TEXT,                              -- 自动采集的上下文（UA / app version / voice mode / viewport）
  status       TEXT NOT NULL DEFAULT 'open',      -- open | read | resolved
  created_at   TEXT NOT NULL,
  handled_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_suggestions_created ON suggestions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, created_at DESC);
