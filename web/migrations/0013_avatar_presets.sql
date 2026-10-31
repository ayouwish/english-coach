-- 0013: 虚拟形象改为预置形象选择题（task-64）
--
-- 用户决定：不接受照片上云 → 改为"预置卡通形象库 + 做选择题"（不拍照、不上传、零生成等待）。
-- users 增加 avatar_preset_id（历史行 NULL，纯追加）。
-- 沿用 0012 的 avatar_image_path / avatar_style / avatar_desc / avatar_prompt / avatar_updated_at：
--   avatar_image_path 现在存**静态预置图**相对路径（如 avatars/presets/c1-watercolor.png）。
ALTER TABLE users ADD COLUMN avatar_preset_id TEXT;
