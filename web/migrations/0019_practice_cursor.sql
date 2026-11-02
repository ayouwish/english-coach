-- 0019: 跟读练习游标（task-84）—— 记住"上次练到第几句"，进入练习可继续。
CREATE TABLE IF NOT EXISTS practice_cursors (
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,               -- 'all' / 'level:A2' / 'focus:th'
  position INTEGER NOT NULL DEFAULT 0, -- 上次练的那句在列表里的下标（0-based）
  total INTEGER NOT NULL DEFAULT 0,
  sentence_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, scope)
);
