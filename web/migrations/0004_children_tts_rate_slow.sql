-- 0004: 存量儿童账号的语速偏好迁移为 slow（task-21）
--
-- 背景：`user_prefs.tts_rate` 机制早就有，但代码里儿童一直被硬编码成 slow，
-- 于是库里存量儿童账号的 tts_rate 写的是 normal（初始化默认值）。
-- 一旦把硬编码改成"尊重偏好"，孩子会从 slow 变成 normal —— 反向退化。
-- 所以这里把**儿童账号**的 tts_rate 一次性迁到 slow（幂等，只动 user_prefs.tts_rate）。
--
-- 语义：儿童默认 slow，但仍然可以被偏好覆盖（改成 normal 就真的用 normal）。
UPDATE user_prefs
SET tts_rate = 'slow',
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE tts_rate <> 'slow'
  AND user_id IN (SELECT id FROM users WHERE age_band = 'child');
