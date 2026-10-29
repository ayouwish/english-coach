-- 0007: 书页材料库（task-29）
--
-- 用户需求：「识别好的图片和内容要保存起来，后续可以反复练习」。
-- 家庭应用：所有登录用户都能看到全部材料（妈妈拍的书页女儿也能读）。
-- 幂等：CREATE TABLE / INDEX IF NOT EXISTS，纯追加，不改动任何既有表。
CREATE TABLE IF NOT EXISTS reading_materials (
  id             TEXT PRIMARY KEY,
  created_by     TEXT,                        -- user id
  title          TEXT NOT NULL,
  text           TEXT NOT NULL,               -- 识别/编辑后的原文
  image_path     TEXT,                        -- 相对 DATA_DIR，如 materials/<id>.jpg；无图为 NULL
  sentence_count INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'photo', -- photo | text
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_materials_created ON reading_materials(created_at DESC);
