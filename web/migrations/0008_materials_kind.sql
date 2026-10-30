-- 0008: 书页材料库支持「故事」（task-49）
--
-- 用户需求：孩子每天讲自己的故事（中文）→ 改写成适龄英文 → 自己读一遍。
-- 故事和拍照书页都进 reading_materials，用 kind 区分：
--   page  = 拍照识别的书页（历史行默认值，不破坏既有数据）
--   story = 孩子讲的故事（额外保留中文原稿与难度级别）
--
-- 幂等：ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，迁移执行器已把
-- "duplicate column name" 视为"该列已存在"继续（可重复执行）。
ALTER TABLE reading_materials ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';
ALTER TABLE reading_materials ADD COLUMN source_zh TEXT;
ALTER TABLE reading_materials ADD COLUMN level TEXT;

CREATE INDEX IF NOT EXISTS idx_materials_kind ON reading_materials(kind, created_at DESC);
