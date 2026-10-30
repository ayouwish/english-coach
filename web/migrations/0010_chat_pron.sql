-- 0010: 对话轮次的发音评估（task-57）
--
-- 用户反馈「历史对话里没有发音信息」：对话是 unscripted（没有参考文本），
-- 所以另外用 voice /v1/pronounce 的 unscripted 模式评一次，把精简结果存这里。
-- 可空：历史行默认 NULL（页面对 NULL 显示「—」，不崩）。纯追加，不动既有数据。
ALTER TABLE chat_messages ADD COLUMN pron_json TEXT;
