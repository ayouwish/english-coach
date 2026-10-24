# web 自测证据（task-2）

环境：Node v24.15.0 / pnpm 11.28.5 / 10 核 15GB，**无 GPU、无浏览器**（渲染层用 curl HTML 断言兜底）。
执行时间：2026-10-22 01:41–01:45 (+08:00)。

## 1. `pnpm build`（带 compose 的 build arg）

```
$ VOICE_SERVICE_URL=http://voice:8100 pnpm build
   ▲ Next.js 15.5.28
   - Experiments (use with caution):
     ✓ authInterrupts

   Creating an optimized production build ...
 ✓ Compiled successfully in 2.4s
   Linting and checking validity of types ...
   Collecting page data ...
 ✓ Generating static pages (2/2)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                                 Size  First Load JS
┌ ƒ /                                      161 B         106 kB
├ ƒ /_not-found                            994 B         103 kB
├ ƒ /api/asr                               164 B         102 kB
├ ƒ /api/attempts                          164 B         102 kB
├ ƒ /api/attempts/[id]/retry               164 B         102 kB
├ ƒ /api/audio/[id]                        164 B         102 kB
├ ƒ /api/auth/login                        164 B         102 kB
├ ƒ /api/auth/logout                       164 B         102 kB
├ ƒ /api/auth/me                           164 B         102 kB
├ ƒ /api/chat/scenarios                    164 B         102 kB
├ ƒ /api/chat/sessions                     164 B         102 kB
├ ƒ /api/chat/sessions/[id]                164 B         102 kB
├ ƒ /api/chat/sessions/[id]/turn           164 B         102 kB
├ ƒ /api/health                            164 B         102 kB
├ ƒ /api/parent/summary                    164 B         102 kB
├ ƒ /api/review                            164 B         102 kB
├ ƒ /api/sentences                         164 B         102 kB
├ ƒ /api/settings                          164 B         102 kB
├ ƒ /api/tts                               164 B         102 kB
├ ƒ /chat                                3.93 kB         106 kB
├ ƒ /login                               1.39 kB         104 kB
├ ƒ /parent                                164 B         102 kB
├ ƒ /practice                            10.2 kB         112 kB
├ ƒ /review                              2.55 kB         105 kB
└ ƒ /settings                            1.83 kB         104 kB

ƒ  (Dynamic) server-rendered on demand
```

静态检查：`pnpm lint`（`eslint .`）无输出 = **0 error / 0 warning**；`npx tsc --noEmit` 无输出 = 通过。

## 2. 部署陷阱自检：rewrite destination 构建期固化

```
$ grep -o '"destination": *"[^"]*"' .next/routes-manifest.json
"destination": "/:path+"
"destination": "http://voice:8100/:path*"     <- build arg 生效；不传时会烘焙成 127.0.0.1:8100

$ ls .next/standalone/
data  migrations  node_modules  package.json  server.js  src
$ ls -d .next/standalone/node_modules/better-sqlite3
.next/standalone/node_modules/better-sqlite3  <- 原生模块已 trace 进来
```

## 3. `/voice/*` 反向代理（浏览器侧示范音路径）

```
$ curl -o /tmp/proxied.wav -w "%{http_code} %{content_type} %{size_download}\n" \
    http://127.0.0.1:3000/voice/v1/audio/ref_aaaaaaaaaaaa.wav
200 audio/wav 19244        # RIFF 头校验通过（web 反代 → voice）
```

## 4. 端到端 smoke

三个 web 实例共用同一份 DB：

| 实例 | VOICE_SERVICE_URL | 用途 |
|---|---|---|
| `:3000` | mock voice `:8300`（phoneme_level=true） | 主路径 |
| `:3001` | `:8199`（无人监听） | voice 挂掉：仍入库 + 稍后可重试 |
| `:3002` | mock voice `:8200`（`MOCK_PHONEME_LEVEL=0`） | capabilities 自适应降级 |

```
$ SMOKE_DOWN_BASE=http://127.0.0.1:3001 SMOKE_WORDLEVEL_BASE=http://127.0.0.1:3002 node scripts/smoke.mjs
──────── 1. 三账号登录 ────────
✅ 爸爸(parent) 登录 200
✅ 妈妈(parent) 登录 200
✅ 女儿(child) 登录 200
✅ 女儿 age_band=child / birth_year≈2018 — birth_year=2018
✅ 错误密码 401 — status=401

──────── 2. 语料 & 场景种子数据 ────────
✅ 跟读语料 ≥ 60 句 — count=66
✅ 语料含 A1/A2/B1 分级 — A1,A2,B1
✅ 每句都有中文翻译
✅ 每句都有 focus_phonemes
✅ 对话场景 ≥ 8 个（儿童可见） — count=9
✅ 儿童场景按 min_age 过滤 — age=8, hidden=2

──────── 3. 跟读提交（voice mock 评测落库） ────────
✅ POST /api/attempts 200 — status=200
✅ 没有降级（voice mock 正常） — message=评测完成
✅ 总分落库（scores.pron 是数字） — pron=58.1
✅ 逐词结果非空 — words=8
✅ issues 非空（含 hint_key） — issues=5
✅ F0 双曲线对齐（同长度、20ms 步长、≥20 点） — user=169 ref=169
✅ 语调数据让 UI 能画出双曲线（available 或显式 warning 二选一） — available=true warnings=[]
✅ 示范音 URL 走 /voice 同源代理 — /voice/v1/audio/ref_9269e8f7be89.wav
✅ 落库反馈（feedback.summary 非空） — template
✅ usage 返回（儿童时长限制用）
✅ GET /api/attempts 能查到刚提交的记录 — ids=5
✅ 该记录 scores_json 已持久化 — db=58.1 api=58.1
✅ 该记录有 audio_url（音频落盘 data/audio） — /api/audio/att_22a5b7b338374a3fb7e6
✅ GET /api/audio/:id 流式返回音频 — status=200 type=audio/wav bytes=80044
✅ POST /api/attempts/:id/retry 200 — status=200

──────── 4. 错音本 / SRS ────────
✅ GET /api/review 200
✅ 产生了逐音素/逐词明细（phoneme_scores 落库） — rows=96
✅ 弱项自动进错音本（due_cards ≥ 1） — due=5
✅ 音素掌握度聚合非空 — weak=9 words=0
✅ POST /api/review 评分（good）200 — next_due=2026-10-22T17:43:52.166Z
✅ SM-2 排期到未来

──────── 5. 对话 3 轮 ────────
✅ POST /api/chat/sessions 201 — status=201
✅ 开场白已入库（assistant 首条）
✅ 第 1 轮 dialogue 200 — reply="Sure! Hot or iced?"
✅ 第 2 轮 dialogue 200 — reply="Would you like milk with that?"
✅ 第 3 轮 dialogue 200 — reply="That will be three dollars."
✅ 回复有中文翻译字段
✅ 点了 suggested_replies 可用（2–3 条） — ["Yes, please.","That sounds good.","Could you say that again?"]
✅ correction 结构完整（has_error 布尔） — {"has_error":false,"type":null,"original":null,"better":null,"explain_zh":null,"severity":null}
✅ 会话消息数 = 1 开场 + 3 轮 × 2 = 7 — messages=7

──────── 6. 家长面板（RBAC） ────────
✅ 爸爸 GET /api/parent/summary 200 — status=200
✅ 成员数 = 3 — members=3
✅ 面板含女儿的今日剩余时长 — remaining=19.9
✅ 面板含家庭学习时长汇总 — today=5min
✅ 面板含高频错音 TOP10（练习者本人有数据） — dad_top=6 例：{"phoneme":"θ","count":18,"avg_score":47.4,"hard_hits":18,"title_zh":"th 的 /θ/ 音（如 think）"}
✅ 高频错音带教学提示文案 — th 的 /θ/ 音（如 think）
✅ 面板含平均分趋势序列
✅ 女儿访问 /api/parent/summary → 403 — status=403 code=forbidden
✅ 女儿访问 /parent 页面 → HTTP 403 — status=403
✅ 403 页面有明确提示
✅ 爸爸访问 /parent → 200 且渲染面板 — status=200
✅ 女儿自行修改每日时长 → 403 — status=403

──────── 7. 渲染层检查（无浏览器，用 HTML 断言兜底） ────────
✅ GET /login 200 且含登录表单文案
✅ 未登录访问 /practice 跳转到 /login
✅ 儿童 /practice 页面不含 IPA 字符 — status=200 leaked=
✅ 儿童 /review 页面不含 IPA 字符 — status=200 leaked=
✅ 儿童 / 页面不含 IPA 字符 — status=200 leaked=
✅ 儿童 /practice 有儿童化文案
✅ 成人 /practice 有 66 句语料链接
✅ 成人 /practice 无 IPA 泄漏到 HTML 也没关系（仅检查渲染成功）

──────── 8. voice 故障降级：录音与文本仍入库 + 稍后可重试 ────────
✅ voice 不可达时仍返回 200（降级而不是报错） — status=200
✅ 标记 degraded=true 且 retryable=true — degraded=true retryable=true
✅ 结果为空但给出'稍后可重试'提示 — 评测服务暂时不可用，录音和文本已经保存，稍后可重试（voice_unreachable: voice 不可达（http://127.0.0.1:8199/v1/pronounce）：fetch failed）
✅ 降级记录已入库（参考文本 + 音频路径） — audio=/api/audio/att_5314004cd87a4d5ca264
✅ warnings 显式暴露降级原因 — ["provider_fallback","web_voice_unreachable","web_pending_retry"]
✅ 降级记录 scores 为空（绝不造分数）
✅ 降级时录音仍已落盘可回放 — bytes=64044
✅ voice 恢复后「重试评测」成功（不用重录） — status=200
✅ 重试后拿到分数 — pron=62.2

──────── 9. capabilities 自适应降级（phoneme_level=false → 单词级粗评） ────────
✅ 该实例探测到 phoneme_level=false — {"phoneme_level":false,"prosody":true,"intonation_curve":true,"nbest_phonemes":false,"ssml":false,"gpu":false}
✅ 该实例仍探测到 intonation_curve=true（语调不依赖云 API）
✅ 单词级模式下仍能提交 200 — status=200
✅ granularity 降级为 word 且带 warning — granularity=word warnings=["phoneme_level_unavailable"]
✅ 单词级也返回可用的语调曲线（F0） — points=162
✅ 页面标注「单词级粗评」而不是假装音素级

──────── 汇总 ────────
共 80 项断言，通过 80，失败 0

家长面板摘要：成员 3 人，今日 5 分钟，语料 66 句，场景 11 个
```

---

# v1.1 自测证据（task-5：盲测周报 + 家长自定义语料 + 错音本修复）

环境：Node v24.15.0 / pnpm 11.28.5，**无浏览器**（渲染层用 curl HTML + RSC 负载断言兜底）。
服务：真实 voice（`PROVIDER_MODE=mock`，`.venv/bin/python -m uvicorn ... --port 8110`）；
web 三实例 3010（正常）/3011（voice 不可达）/3012（`MOCK_PHONEME_LEVEL=0` 词级降级）。
执行时间：2026-10-22 11:00 (+08:00)。

## 1. 迁移升级路径测试（`pnpm test:migrations`，独立临时库）

```
$ node scripts/test-migrations.mjs
✅ 旧库已就绪（只有 0001 + 旧数据） — {"users":1,"sentences":1,"attempts":1,"srs_cards":2}
✅ 升级时按顺序应用了 0002 与 0003 — applied=0002_srs_opaque_ids.sql,0003_blind_tests_and_custom_corpus.sql
✅ _migrations 记录 0001→0002→0003 全部就位
✅ 旧数据行数不变（不重建、不丢数据）
✅ srs_cards 旧 id 已重写为 srs_<随机>
✅ 主键里不再含 IPA / 冒号
✅ attempts 新增 is_blind / blind_test_id；sentences 新增 owner_user_id
✅ 旧 attempts 的 is_blind 默认为 0（不会被误当成盲测）
✅ source='builtin' 已归一化为 'official'
✅ blind_tests 表已创建
✅ 重复执行迁移是幂等的 — second run applied=(none)

共 14 项断言，通过 14，失败 0
```

`pnpm db:reset` 同样按序应用全部迁移：

```
$ pnpm db:reset
[migrate] 应用了 3 个迁移：0001_init.sql, 0002_srs_opaque_ids.sql, 0003_blind_tests_and_custom_corpus.sql
[seed] 用户 3 个 / 语料 300 句 / 对话场景 11 个
```

## 2. 盲测（契约 §13.3 三条硬性要求）

```
$ BASE_URL=http://127.0.0.1:3010 VOICE_URL=http://127.0.0.1:8110 SMOKE_DOWN_BASE=http://127.0.0.1:3011 SMOKE_WORDLEVEL_BASE=http://127.0.0.1:3012 node scripts/smoke.mjs
──────── 10. 盲测周报（契约 §13.3 三条硬性要求） ────────
✅ 已为盲测准备 12 句「练过的语料」 — ids=12
✅ 基线：女儿已有日常练习数据（非盲测） — attempts=13 avg=81.4
✅ POST /api/blind-tests 201 — status=201
✅ 盲测抽 10 句（上限，且不超过练过的句数） — total=10
✅ 抽题全部来自「练过」的语料（不是没学过的） — 10 句
✅ 重复开始返回同一批次 + 同一组句子（固定一组，才能与上周比） — resumed=true
✅ 盲测第 1 句：HTTP 200 — status=200
✅ ★ 盲测进行中响应体只有 attempt_id / blind / progress — {"attempt_id":"att_0ad4007d5fb8405f8ac6","blind":true,"progress":{"done":1,"total":10}}
✅ ★ 盲测进行中不含 result / feedback / scores — keys=attempt_id,blind,progress
✅ progress 正确（done=1, total=10） — {"done":1,"total":10}
✅ 10 句提交过程中出现过的所有字段里都没有分数/反馈键 — attempt_id,blind,progress
✅ 进行中不返回反馈（feedback 字段缺席）
✅ 进行中的盲测记录在 /api/attempts 里被屏蔽（scores/issues/intonation/feedback 全为 null） — records=10
✅ 盲测录音不允许「重试评测」（否则分数会漏出来） — status=409 code=blind_attempt_no_retry
✅ ★ 盲测不写 phoneme_scores（明细行数不变） — 272 → 272
✅ ★ 盲测不参与 phoneme_mastery 聚合（掌握度完全不变） — weak=10
✅ ★ 盲测不进 SRS 排期（卡片总数不变） — 8 → 8
✅ ★ 盲测不进日常练习趋势（avg_pron 与练习次数不变） — avg 81.4 → 81.4；attempts 13 → 13
✅ 盲测时长单独归类（blind_minutes>0，不混进练习分钟） — practice=0.5 blind=0.3
✅ finish 后分数可读（avg_pron 是数字） — avg_pron=81.5
✅ finish 汇总含 accuracy/fluency/语调差异 — acc=89.9 flu=80.9 dtw=0.6
✅ 首次盲测没有上一次可比（previous=null, delta=null） — weeksBefore=0 prev=null delta=null
✅ 第二次盲测复用同一组句子（固定一组） — total=10
✅ 第二次 finish 给出与上一次的差值（delta_pron 是数字，previous 指向上一次） — this=81.5 prev=81.5 delta_pron=0
✅ ★ 差值计算有真实变化（第二次录音更短 → delta_fluency ≠ 0） — this_flu=45.4 prev_flu=80.9 delta_flu=-35.5
✅ GET /api/blind-tests 趋势字段齐全（current/previous/delta_pron/weeks） — {"current":{"blind_test_id":"bt_b40c9c5f56434155b1d3","ended_at":"2026-10-22T03:00:07.035Z","avg_pron":81.5,"avg_accuracy":89.9,"avg_fluency":45.4,"avg_intonation_distance":0.8},"previous":{"blind_test_id":"bt_8b45b7a5cf584aba9c94","ended_at":"2026-10-22T03:00:06.774Z","avg_pron":81.5,"avg_accuracy":89.9,"avg_fluency":80.9,"avg_intonation_distance":0.6},"delta_pron":0,"delta_accuracy":0,"delta_fluency":-35.5,"delta_intonation_distance":0.2,"weeks":2}
✅ 历史列表按时间倒序返回（含本次新增的 2 次） — tests=2 weeksBefore=0
✅ ★ 家长面板拿到盲测周环比数据 — current=81.5 delta=0 weeks=2
✅ 家长面板 HTML 渲染盲测周环比区块（显眼位置）
✅ ★ 儿童 /blindtest 页面 HTML 不含任何分数（无 avg_pron/delta_pron 字样） — len=11746
✅ 结束后 /blindtest/report 才展示分数

──────── 11. 家长自定义语料（归属隔离） ────────
✅ 爸爸录入自定义语料 201 — status=201
✅ 落库字段正确（source=parent / owner=爸爸 / 等级与重点音素保留） — {"id":"s-custom-5613995b8aaf46aa","text":"I would like a glass of water, please.","translation_zh":"请给我一杯水。","level":"A2","tags":[],"focus_phonemes":["θ","w"],"source":"parent","owner_user_id":"u-dad","mine":true,"sort_order":301}
✅ 爸爸自己可见（mine_count ≥ 1） — mine=1
✅ 官方语料数量不受自定义录入影响（基线不变） — 300 → 300
✅ 女儿可见爸爸录的语料（家长录入 → 其孩子可用） — girl total=301
✅ 女儿看到的官方语料数量与爸爸一致（没被污染） — official=300
✅ 妈妈看不到爸爸录的语料（家长之间互相隔离） — mom total=300 custom=0
✅ 儿童不能录入自定义语料 → 403 — status=403
✅ 批量粘贴：每行一句，翻译可留空 — created=3 skipped=0
✅ 别人不能删我的语料 → 403 — status=403
✅ 本人可以删除自己的语料 — status=200
✅ 删除后女儿也看不到了 — girl total=303
✅ 官方语料全程保持基线不变（自定义语料独立计数） — official=300 custom=3 (总 300 → 303)

──────── 12. 错音本卡片（成人有音素+口型提示 / 儿童无 IPA 且文案非空） ────────
✅ 成人视图存在音素卡片 — cards=6
✅ ★ 成人音素卡片：ref/phoneme/label 全部非空（不再出现 ref: ""） — ŋ|ŋ|ŋ · 词尾 / / k|k|k · 这个词可 / ð|ð|ð · th 的 / ə|ə|ə · 非重读弱 / w|w|w · /v/  / ɛ|ɛ|ɛ · /æ/ 
✅ ★ 成人音素卡片：每张都有非空的口型/舌位提示（how_zh）与「为什么」 — /ŋ/ 舌根抬起顶住 / 放慢速度，把每个音都 / 舌尖放在上下齿之间， / 非重读音节放松成轻轻 / 上齿轻咬下唇送气＝/ / 下巴放低，嘴角略向两
✅ ★ hint_key 语义正确：是「提示键」或 null，绝不等于音素符号本身 — ŋ→n_ng / k→null / ð→th_voiced / ə→schwa / w→v_w / ɛ→ae_e
✅ 有映射的音素卡片带练习词与示范文本 — mapped=5/6 例：["sing","sin","thing","thin"]
✅ 成人 /review 页面渲染了音素符号（IPA 对成人可见） — symbols=ŋ,k,ð,ə,w,ɛ
✅ 儿童视图存在音素卡片 — cards=7
✅ ★ 儿童音素卡片：ref/phoneme 置空（不下发 IPA）但 label 与 how_zh 非空 — label="这个词再说清楚一点点" how="放慢速度，把每个音都说完整，再录一遍试试。"
✅ ★ 儿童卡片 JSON 载荷里不含任何特征 IPA 字形（含 hint_key） — hint_key=null
✅ 儿童音素卡片文案是儿童化版本（不是成人 IPA 文案）
✅ ★ 儿童掌握度列表：phoneme 置空 + hint_key 不是音素符号 — weak=10
✅ ★ 儿童 /review 接口整个载荷不含 IPA 字形 — len=6301
✅ 成人视图仍保留音素符号（降级不能把成人的信息也砍掉）

──────── 汇总 ────────
共 140 项断言，通过 140，失败 0

家长面板摘要：成员 3 人，今日 1.6 分钟，语料 300 句，场景 11 个
```

## 3. 家长自定义语料（归属隔离）

```
──────── 11. 家长自定义语料（归属隔离） ────────
✅ 爸爸录入自定义语料 201 — status=201
✅ 落库字段正确（source=parent / owner=爸爸 / 等级与重点音素保留） — {"id":"s-custom-5613995b8aaf46aa","text":"I would like a glass of water, please.","translation_zh":"请给我一杯水。","level":"A2","tags":[],"focus_phonemes":["θ","w"],"source":"parent","owner_user_id":"u-dad","mine":true,"sort_order":301}
✅ 爸爸自己可见（mine_count ≥ 1） — mine=1
✅ 官方语料数量不受自定义录入影响（基线不变） — 300 → 300
✅ 女儿可见爸爸录的语料（家长录入 → 其孩子可用） — girl total=301
✅ 女儿看到的官方语料数量与爸爸一致（没被污染） — official=300
✅ 妈妈看不到爸爸录的语料（家长之间互相隔离） — mom total=300 custom=0
✅ 儿童不能录入自定义语料 → 403 — status=403
✅ 批量粘贴：每行一句，翻译可留空 — created=3 skipped=0
✅ 别人不能删我的语料 → 403 — status=403
✅ 本人可以删除自己的语料 — status=200
✅ 删除后女儿也看不到了 — girl total=303
✅ 官方语料全程保持基线不变（自定义语料独立计数） — official=300 custom=3 (总 300 → 303)

──────── 12. 错音本卡片（成人有音素+口型提示 / 儿童无 IPA 且文案非空） ────────
✅ 成人视图存在音素卡片 — cards=6
✅ ★ 成人音素卡片：ref/phoneme/label 全部非空（不再出现 ref: ""） — ŋ|ŋ|ŋ · 词尾 / / k|k|k · 这个词可 / ð|ð|ð · th 的 / ə|ə|ə · 非重读弱 / w|w|w · /v/  / ɛ|ɛ|ɛ · /æ/ 
✅ ★ 成人音素卡片：每张都有非空的口型/舌位提示（how_zh）与「为什么」 — /ŋ/ 舌根抬起顶住 / 放慢速度，把每个音都 / 舌尖放在上下齿之间， / 非重读音节放松成轻轻 / 上齿轻咬下唇送气＝/ / 下巴放低，嘴角略向两
✅ ★ hint_key 语义正确：是「提示键」或 null，绝不等于音素符号本身 — ŋ→n_ng / k→null / ð→th_voiced / ə→schwa / w→v_w / ɛ→ae_e
✅ 有映射的音素卡片带练习词与示范文本 — mapped=5/6 例：["sing","sin","thing","thin"]
✅ 成人 /review 页面渲染了音素符号（IPA 对成人可见） — symbols=ŋ,k,ð,ə,w,ɛ
✅ 儿童视图存在音素卡片 — cards=7
✅ ★ 儿童音素卡片：ref/phoneme 置空（不下发 IPA）但 label 与 how_zh 非空 — label="这个词再说清楚一点点" how="放慢速度，把每个音都说完整，再录一遍试试。"
✅ ★ 儿童卡片 JSON 载荷里不含任何特征 IPA 字形（含 hint_key） — hint_key=null
✅ 儿童音素卡片文案是儿童化版本（不是成人 IPA 文案）
✅ ★ 儿童掌握度列表：phoneme 置空 + hint_key 不是音素符号 — weak=10
✅ ★ 儿童 /review 接口整个载荷不含 IPA 字形 — len=6301
✅ 成人视图仍保留音素符号（降级不能把成人的信息也砍掉）

```

## 4. 错音本卡片（C.12）

```
──────── 12. 错音本卡片（成人有音素+口型提示 / 儿童无 IPA 且文案非空） ────────
✅ 成人视图存在音素卡片 — cards=6
✅ ★ 成人音素卡片：ref/phoneme/label 全部非空（不再出现 ref: ""） — ŋ|ŋ|ŋ · 词尾 / / k|k|k · 这个词可 / ð|ð|ð · th 的 / ə|ə|ə · 非重读弱 / w|w|w · /v/  / ɛ|ɛ|ɛ · /æ/ 
✅ ★ 成人音素卡片：每张都有非空的口型/舌位提示（how_zh）与「为什么」 — /ŋ/ 舌根抬起顶住 / 放慢速度，把每个音都 / 舌尖放在上下齿之间， / 非重读音节放松成轻轻 / 上齿轻咬下唇送气＝/ / 下巴放低，嘴角略向两
✅ ★ hint_key 语义正确：是「提示键」或 null，绝不等于音素符号本身 — ŋ→n_ng / k→null / ð→th_voiced / ə→schwa / w→v_w / ɛ→ae_e
✅ 有映射的音素卡片带练习词与示范文本 — mapped=5/6 例：["sing","sin","thing","thin"]
✅ 成人 /review 页面渲染了音素符号（IPA 对成人可见） — symbols=ŋ,k,ð,ə,w,ɛ
✅ 儿童视图存在音素卡片 — cards=7
✅ ★ 儿童音素卡片：ref/phoneme 置空（不下发 IPA）但 label 与 how_zh 非空 — label="这个词再说清楚一点点" how="放慢速度，把每个音都说完整，再录一遍试试。"
✅ ★ 儿童卡片 JSON 载荷里不含任何特征 IPA 字形（含 hint_key） — hint_key=null
✅ 儿童音素卡片文案是儿童化版本（不是成人 IPA 文案）
✅ ★ 儿童掌握度列表：phoneme 置空 + hint_key 不是音素符号 — weak=10
✅ ★ 儿童 /review 接口整个载荷不含 IPA 字形 — len=6301
✅ 成人视图仍保留音素符号（降级不能把成人的信息也砍掉）

```

## 5. 儿童 IPA 检查（完整 HTML，含 RSC 负载）

```
✅ 儿童 /practice 页面不含 IPA 字符 — status=200 leaked=
✅ 儿童 /review 页面不含 IPA 字符 — status=200 leaked=
✅ 儿童 / 页面不含 IPA 字符 — status=200 leaked=
✅ 儿童 /blindtest 页面不含 IPA 字符 — status=200 leaked=
✅ 儿童 /blindtest/report 页面不含 IPA 字符 — status=200 leaked=
```

## 6. 汇总

```
共 140 项断言，通过 140，失败 0
家长面板摘要：成员 3 人，今日 1.6 分钟，语料 300 句，场景 11 个
```

可重复运行（不 reset、数据累积后再跑一遍）：

```
共 140 项断言，通过 140，失败 0
```
