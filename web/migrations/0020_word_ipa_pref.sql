-- 0020: 单词显示音标开关（task-87）
--
-- NULL = 角色默认（成人开、儿童关；儿童零 IPA 规则）。家长可为孩子打开。
ALTER TABLE user_prefs ADD COLUMN show_word_ipa INTEGER;
