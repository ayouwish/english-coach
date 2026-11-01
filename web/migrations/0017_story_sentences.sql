-- 0017: 故事句子数可按账号配置（task-81）
--
-- NULL = 用按角色推算的默认值：儿童 5 句、成人 8 句；用户可在设置页改成 3–12。
ALTER TABLE users ADD COLUMN story_sentences INTEGER;
