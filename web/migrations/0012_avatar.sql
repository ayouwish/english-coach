-- 0012: 虚拟形象（task-62）+ 插画提示词留存
--
-- 用户需求：① 拍照/上传照片生成虚拟形象（5 种风格）② 故事插画参考虚拟形象 ③ 提示词前端可见可反馈。
--  - users 加 5 列（历史行默认 NULL；纯追加，不动既有数据）
--  - reading_materials 加 2 列存"画插画用的提示词/是否用了虚拟形象"（否则详情页无法展示提示词）
--
-- 幂等：ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，迁移执行器把
-- "duplicate column name" 视为"该列已存在"继续（可重复执行）。
ALTER TABLE users ADD COLUMN avatar_image_path TEXT;
ALTER TABLE users ADD COLUMN avatar_style TEXT;
ALTER TABLE users ADD COLUMN avatar_desc TEXT;
ALTER TABLE users ADD COLUMN avatar_prompt TEXT;
ALTER TABLE users ADD COLUMN avatar_updated_at TEXT;

ALTER TABLE reading_materials ADD COLUMN image_prompt TEXT;
ALTER TABLE reading_materials ADD COLUMN image_character_used INTEGER;
