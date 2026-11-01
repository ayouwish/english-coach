-- 0014: 用户偏好（task-76）
--
-- ① 卡通插画自动生成开关：默认 **关**（避免自动花钱）；开=保存故事后自动生成一张
-- ② 性别：girl|boy|woman|man|other，可空（历史行 NULL）→ 插画提示词必须带性别
ALTER TABLE users ADD COLUMN auto_illustrate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN gender TEXT;
