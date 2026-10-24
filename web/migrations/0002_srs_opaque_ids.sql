-- 0002: srs_cards.id 改用不透明 id
--
-- 旧 id 形如 `<user_id>:<kind>:<ref>`（ref 可能是 IPA 音素，如 `u-girl:phoneme:θ`）。
-- id 会被序列化进页面的 RSC 负载，导致「儿童页面不得出现 IPA」这条产品约束被绕过
-- （可见文案已做儿童化，但 id 里仍带符号）。表上已有 UNIQUE(user_id, kind, ref) 约束，
-- 所以主键可以用不透明随机串。
UPDATE srs_cards
SET id = 'srs_' || lower(hex(randomblob(10)))
WHERE id LIKE '%:phoneme:%'
   OR id LIKE '%:word:%'
   OR id LIKE '%:sentence:%';
