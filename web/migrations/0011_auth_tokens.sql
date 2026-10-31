-- 0011: Bearer Token 认证（task-60）
--
-- 移动端（iOS/鸿蒙）直接上不透明 Bearer Token；Web 端继续用 Cookie，**双模式并存**。
--  - 库里只存 sha256(token)，不存明文；refresh 一次性轮换（used_at 标记）
--  - parent_id：refresh 轮换/登录时记录"签发它的父 refresh"，吊销 refresh 时连带吊销配对的 access
-- 纯追加，历史数据（sessions/users）不受影响。
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,   -- sha256(token) 十六进制
  kind        TEXT NOT NULL,          -- 'access' | 'refresh'
  expires_at  TEXT NOT NULL,
  used_at     TEXT,                   -- refresh 轮换用（一次性）
  revoked_at  TEXT,
  created_at  TEXT NOT NULL,
  user_agent  TEXT,
  parent_id   TEXT                    -- 该 token 由哪个 refresh 签发（用于 revoke 连带）
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_parent ON auth_tokens(parent_id);
