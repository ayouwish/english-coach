-- 0015: 故事录音原始音频落盘（task-77）
--
-- 用户：「录音输入需要把原始录音存下来，中文较长录音会转录失败」
-- 设计：**先落盘再转录**；转录失败也有记录（status=failed），可重试/换 provider 重转录。
CREATE TABLE IF NOT EXISTS story_recordings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  material_id TEXT,
  audio_path TEXT NOT NULL,
  mime TEXT,
  duration_ms INTEGER,
  size_bytes INTEGER,
  transcript_zh TEXT,
  provider TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_story_recordings_user ON story_recordings(user_id, created_at);
