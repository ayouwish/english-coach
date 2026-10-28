# english-coach · web

面向三口之家（爸爸 / 妈妈 / 6–9 岁女儿）的英语练习 Web 应用第一版：
**音素级发音纠正 + 日常对话训练 + 错音本 / SRS + 家长面板**。

```
浏览器 ──HTTP──► web (Next.js :3000) ──HTTP──► voice (FastAPI :8100) ──► 云 API / 本地模型
                     │                              │
                     │ SQLite + data/audio/          └── ASR / 发音评测 / TTS / LLM 反馈 / 对话
                     └ 账号、跟读、错音本、SRS、家长面板
```

- 接口契约（唯一事实来源）：[`../docs/api-contract.md`](../docs/api-contract.md) v1（FROZEN）。
- **web 不持有任何模型密钥**：所有 AI 调用都经 `voice`（AI Gateway），web 只读 `VOICE_SERVICE_URL`。
- 数据库字段名严格按契约 §10；音频只落 `data/audio/`，**不入库二进制**。

---

## 1. 快速开始（本地）

```bash
cd web
pnpm install                # 需要 Node >= 22（本仓库用 v24 验证）
pnpm db:reset               # 建表 + 灌种子（亦可省略：首次请求会自动建表+灌种子）
pnpm dev                    # http://127.0.0.1:3000
# 生产模式： pnpm build && pnpm start
```

voice 侧另起（同事的 FastAPI 服务，默认 8100）：

```bash
cd ../voice && PROVIDER_MODE=mock uv run uvicorn app.main:app --port 8100
```

**没有 Python / 只想纯 Node 跑通？** 本仓库自带一个最小 mock voice 桩（只依赖 node 内置模块，
完整实现契约的 `/v1/health|asr|pronounce|tts|feedback|dialogue|audio`，返回确定性假数据）：

```bash
pnpm mock:voice                     # 监听 8100（MOCK_PHONEME_LEVEL=0 可模拟"音素级不可用"）
```

> voice 未就绪时 web 不会崩：`/api/health` 探测 + 页面显式提示，录音与文本照常入库。

## 2. 三个种子账号（初始密码）

| 角色 | 邮箱 | 密码 | 说明 |
|---|---|---|---|
| 爸爸（parent） | `dad@example.com` | `Dad12345!` | 可看家长面板 |
| 妈妈（parent） | `mom@example.com` | `Mom12345!` | 可看家长面板 |
| 女儿（child） | `girl@example.com` | `Girl12345!` | `birth_year=2018` / `age_band=child` / 每日 20 分钟 |

登录页有"演示账号"一键填充。

> 部署时若用 `BOOTSTRAP_*_PASSWORD` 覆盖了种子密码，登录页的「演示账号」按钮**只填邮箱、不猜密码**，
> 并在下方提示密码来自 `deploy/.env`。注意：种子密码只在**首次建库**时写入，之后改 `.env` 不会生效。种子在首次请求时自动执行（`users` 表为空时），也可手动：

```bash
pnpm db:seed                             # 幂等；已存在账号的密码不会被覆盖
pnpm db:seed -- --reset-passwords        # 强制把密码重置回上表
```

## 3. 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | 开发 / 生产构建 / 生产启动（:3000） |
| `pnpm lint` | ESLint（当前 0 error / 0 warning） |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm db:migrate` / `pnpm db:migrate -- --reset` | 应用 `migrations/*.sql`（`--reset` 删库重建） |
| `pnpm db:seed` | 灌种子（3 账号 / 66 句语料 / 11 个对话场景） |
| `pnpm db:reset` | migrate --reset + seed |
| `pnpm mock:voice` | 纯 Node 的 mock voice 服务（:8100） |
| `pnpm smoke` | 服务端端到端自测（见下，140 项断言） |
| `pnpm test:migrations` | 迁移升级路径测试（造 v1.0 旧库 → 升级 → 断言数据不丢、id 重写、幂等） |
| `pnpm check:phoneme-hints` | 遍历 canonical-v1 的 43 个规范音素，核对音素→口型提示映射（漏键/死键/非法 hint 键直接失败） |
| `pnpm check:child-ipa` | 儿童 IPA 泄漏守卫：把儿童账号的 4 个 API 响应 + 7 个页面 HTML（含 RSC 负载）**整体序列化后扫描** 18 个特征字形 |
| `pnpm check:practice-ui` | 跟读 UI 断言：雷达图 null 轴、词级长度编码排序、整句没听到的判定 + `/practice` HTML（正常态 vs 没听到态） |
| `pnpm check:warmup` | 参考音预热：`/api/warmup` 打通 voice §12，第二次调用应命中缓存（证明"点示范音秒出"） |
| `pnpm check:diagnosis` | 发音诊断：`/api/diagnosis` 分档/排序/零 IPA、`/practice?focus=` 过滤与 banner、`/report` 口型微课与儿童零 IPA |
| `pnpm check:chat-speech` | 对话朗读：`/api/tts` 同句两次耗时对比（缓存）、`/chat` 里自动朗读开关/重播按钮的 aria 断言、儿童 slow / 成人 normal |

## 4. 自测（无浏览器环境下的验收方式）

```bash
# ① 构建 & 静态检查
pnpm build && pnpm lint && pnpm typecheck

# ② 起 voice（真实服务用 .venv；纯 Node 兜底桩用 pnpm mock:voice）
cd ../voice && PROVIDER_MODE=mock .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8110 &
cd ../web && PORT=8210 MOCK_PHONEME_LEVEL=0 node scripts/mock-voice.mjs &   # 模拟 local 的词级降级

# ③ 起三个 web 实例（端口只是示例；注意 8100 可能被他人占用，这里用 8110）
VOICE_SERVICE_URL=http://127.0.0.1:8110 pnpm exec next start -p 3010 &   # 正常
VOICE_SERVICE_URL=http://127.0.0.1:8199 pnpm exec next start -p 3011 &   # voice 不可达
VOICE_SERVICE_URL=http://127.0.0.1:8210 pnpm exec next start -p 3012 &   # phoneme_level=false

# ④ 跑端到端（140 项断言）
BASE_URL=http://127.0.0.1:3010 VOICE_URL=http://127.0.0.1:8110 \
  SMOKE_DOWN_BASE=http://127.0.0.1:3011 SMOKE_WORDLEVEL_BASE=http://127.0.0.1:3012 \
  node scripts/smoke.mjs

# ⑤ 迁移升级路径（独立临时库，不碰 data/app.db）
pnpm test:migrations
```

> ⚠️ 先 `pnpm db:reset` 再起 web 实例（顺序反了的话，实例会握着被删除的旧库文件句柄）。
> smoke 可以**重复连跑**（断言都用相对基线，不假设空库）。

`scripts/smoke.mjs` 覆盖：`/api/health` 探活 → 三账号登录（含错误密码 401）→ 语料/场景种子校验
→ 跟读提交（评测结果落库、F0 双曲线同长度/20ms 步长、音频落盘与 `/api/audio/:id` 流式回放、重试评测）
→ 错音本（`phoneme_scores` 落库、弱项自动进卡片、SM-2 评分）→ 对话 3 轮（回复/翻译/correction/suggested_replies）
→ 家长面板（成员、今日时长、剩余时长、高频错音 TOP10、平均分趋势）→ **child 访问 `/parent` 与 `/api/parent/summary` 均 403**
→ voice 故障降级（`degraded/retryable`、warnings、scores 不造假、稍后重试成功）
→ capabilities 降级（`granularity=word` + `phoneme_level_unavailable`，语调曲线仍可用）
→ **盲测三条硬性要求**（进行中响应只有 3 个键、历史/重试旁路被堵、mastery/SRS/趋势零污染、
抽题来自练过的语料且固定一组、finish 后才可读分、第二次给出 delta、家长面板可见）
→ **自定义语料归属隔离**（本人可见 / 孩子可见 / 其他家长不可见 / 儿童不能录入 / 不能删他人语料）
→ **错音本卡片**（成人有音素符号+口型提示+练习词，儿童无 IPA 且主体文案非空）
→ **渲染层断言**（curl HTML：儿童 `/practice`、`/review`、`/`、`/blindtest`、`/blindtest/report`
   均不得出现特征 IPA 字形 `θ ð ɹ ŋ æ ʃ ɪ ʌ ɔ ɜ ə ʊ ʒ ɑ ɒ ɛ ˈ ˌ`；403 页面文案；未登录跳转）。

> 真实 voice 比 mock 更严格：它用 ffmpeg 解码音频并做基频检测，所以 smoke 里喂的是
> 真实可解码的「类浊音」WAV（基频 120→220Hz 滑动），否则拿不到 F0 曲线。

## 5. 页面与 API

| 页面 | 说明 |
|---|---|
| `/login` | 邮箱 + 密码（bcryptjs），httpOnly cookie session |
| `/practice` | 选句 → MediaRecorder 录音（或选文件）→ 总分/分项、单词热力图、音素明细、**F0 双曲线 canvas**、问题卡片（只展示前 2 条）、示范音播放、一键重录/重试 |
| `/chat` | 场景选择（按 `min_age` 过滤）→ 文字或语音输入 → 多轮对话、中文翻译、correction、可点击 suggested_replies |
| `/review` | 错音本：到期卡片 + SM-2 四档评分（again/hard/good/easy）+ 音素掌握度趋势 + 单词级粗评错词 |
| `/parent` | **仅 parent**：每人时长/次数/平均分趋势、高频错音 TOP10、女儿今日剩余时长（child 访问 HTTP 403） |
| `/blindtest` | **盲测**：全程不显示任何分数（只有"第 N / 10 句"与进度条），结束后给「去看周报」入口 |
| `/blindtest/report` | 盲测周报：最近一次分值 + 与上一次的差值 + 历次柱状图（结束后才可读分数） |
| `/settings` | 每日时长上限、纠正强度、音色/语速、自由话题开关；**家长自定义语料**（单条 / 批量粘贴 / 删除） |

API（服务端路由，全部同名函数内有鉴权）：

```
GET  /api/health              探活（voice 不可达也 200；?force=1 绕过 15s 缓存）
POST /api/auth/login|logout   登录 / 退出     GET /api/auth/me
GET  /api/sentences           语料列表（?level=A1&mine=1）
POST /api/attempts            录音 + 评测入库（multipart）   GET /api/attempts 最近记录
POST /api/attempts/:id/retry  用已保存录音重新评测（不重录）
GET  /api/audio/:id           流式返回 data/audio 下的录音（本人或家长）
POST /api/tts                 示范音（转发 voice /v1/tts）
POST /api/asr                 语音转文字（对话语音输入）
GET  /api/chat/scenarios      场景（儿童按 min_age 过滤）
POST /api/chat/sessions       开始会话     GET /api/chat/sessions[/:id]
POST /api/chat/sessions/:id/turn   推进一步（服务端对儿童强制 child_safe）
GET  /api/blind-tests         盲测历史 + 周环比趋势（家长可带 ?user_id=<孩子>）
POST /api/blind-tests         开始盲测（固定一组、从练过的语料里抽）
POST /api/blind-tests/:id/finish  结束盲测：写 avg_* 并返回与上次的差值
POST /api/sentences           家长录入自定义语料（单条或 batch 批量粘贴）
DELETE /api/sentences/:id     删除自己录入的语料
GET  /api/review              错音本 + 掌握度     POST /api/review  SM-2 评分
GET  /api/parent/summary      家长面板汇总（requireParent → child 403）
GET/PATCH /api/settings       偏好设置（儿童不能自行改时长/自由话题 → 403）
```

浏览器**不直连** voice：示范音播放走 `next.config.ts` 的 `rewrites`：`/voice/* → ${VOICE_SERVICE_URL}/*`。

## 6. 契约要点与降级策略

- **能力自适应（契约 §1/§3.2）**：UI 完全由 `/v1/health.capabilities` 驱动。
  - `phoneme_level=false` → 不显示 IPA，热力图/问题卡片标注「单词级（粗评）」，并强制要求 voice 带
    `phoneme_level_unavailable` warning（`granularity=word`）。
  - `prosody=false` → 韵律分显示"暂不可用"（而不是 0）。
  - ~~`intonation_curve=false` 就藏起曲线~~：**语调曲线不依赖云 API**（契约 §3.1），只要
    `intonation.available=true` 就照常渲染 —— 它是 `local` 模式下唯一还能给的精确反馈。
- **绝不造假分数**：`scores.*` 不可得就是 `null`；`local` provider 的词级分数单独走
  `phoneme_scores.phoneme='@word'`（内部约定键，UI 明确标注"粗评"，绝不冒充音素级）。
- **降级优先于报错（契约 §9）**：`/v1/pronounce` 失败时保存音频 + 参考文本，`attempts.warnings_json`
  写入 `web_voice_unreachable` + `web_pending_retry`，接口仍返回 200 + `degraded/retryable`，页面提示
  "稍后可重试"；`POST /api/attempts/:id/retry` 用同一份录音重跑，不需要重录。
- **LLM 不可用**：`/v1/feedback` 失败 → web 侧按 `hint_key` 查表生成模板反馈；`/v1/dialogue` 失败 →
  本地固定话术。离线也有可用反馈。
- **超时/重试**：health 3s / asr 30s(1 retry) / pronounce 60s(0 retry) / tts 20s / feedback 40s(1 retry) /
  dialogue 40s(1 retry)，全部按契约 §9。
- **音素符号空间 canonical-v1**：语料与 voice 输出统一折叠到 43 个规范符号
  （`iː→i uː→u ɒ→ɑ ɹ→r ɛ→e ɝ→ɜ ɚ→ə` …，见 `voice/app/phonemes.py`）。web 侧的音素→口型提示映射
  放在 `src/lib/phoneme-hints.json`（TS 与校验脚本共用同一份数据），**只允许规范符号**；
  没有贴切提示键的音素走 `intentionallyUnmapped` 并写明理由（走通用文案），
  `pnpm check:phoneme-hints` 会强制"每个规范符号恰好归入一侧"，规范集新增符号时直接失败，不会静默退化成无提示。
- **儿童 IPA 安全网（两层）**：① 运行时 `childSafeDeep()` 递归剥离儿童响应里的 IPA 字形
  （新增字段自动覆盖，命中会打日志指出源头路径）；② `pnpm check:child-ipa` 把儿童可见载荷整体序列化后
  扫描 18 个特征字形（兼容 `\uXXXX` 转义）。历史教训：IPA 会从任何没被检查的序列化路径漏出去
  （`srs_cards.id` → `hint_key` → `demo_text`），所以不做逐字段断言。
- **安全边界**：所有鉴权在服务端（cookie session 表）；`/parent` 页面用 `forbidden()` 返回 **HTTP 403**，
  `/api/parent/summary` 再校验一次；音频路径解析被限制在 `data/audio/` 内防目录穿越。

## 6.1 盲测（契约 v1.1 §13）与自定义语料

### 为什么需要盲测
日常分数**不能证明长期进步**：用户看完反馈会立刻重读，分数自然上升，那是即时模仿不是习得。
唯一诚实的指标是盲测 —— 同一组句子、全程无反馈，与上一次对比。

### §13.3 三条硬性要求是怎么落地的（都有 smoke 断言）
1. **进行中绝不返回分数**：`POST /api/attempts` 带 `blind_test_id` 时，响应由白名单函数
   `blindAttemptResponse()` 构造，**只含** `{attempt_id, blind, progress}`（不 spread 任何含分数的对象）；
   同时 `/v1/feedback` 在盲测中根本不调用。
   连带堵住三个旁路：`GET /api/attempts` 对"进行中的盲测记录"屏蔽 `scores/issues/intonation/feedback`
   （`pending: true`）；`POST /api/attempts/:id/retry` 对盲测记录返回 **409**；`/blindtest` 页面
   （含 RSC 负载）里没有任何 `avg_*` 字段。
2. **不污染日常统计**：盲测 attempt 写入 `is_blind=1` + `blind_test_id`，且**不写** `phoneme_scores`、
   不更新 `phoneme_mastery`、不进 `srs_cards`；家长面板的 `avg_pron` / 练习次数 / 趋势 / 高频错音
   全部带 `is_blind = 0` 过滤。盲测时长单独记 `practice_sessions.kind='blindtest'`，
   在面板里以 `today.blind_minutes` 单独呈现（时间仍计入每日上限，否则孩子可以靠盲测绕过限制）。
3. **抽"学过且固定"的句子**：优先复用上一次盲测的 `sentence_ids_json`；否则从该用户
   `attempts(is_blind=0)` 里出现过的句子中，按 `sha1(user_id + sentence_id)` 排序取前 10 句
   （确定性、与时间无关）。没练过任何句子 → **409 `no_practiced_sentences`**，并提示先去跟读练习。

### 家长面板
`/parent` 顶部有独立的 **🎯 盲测周环比** 区块（大字号分值 + 「本周 vs 上周 ▲+N 分」+ 历次柱状图 +
进行中提示），它是家长判断"到底有没有变好"的唯一依据，因此不缩在角落。

### 自定义语料（归属隔离）
- 家长在 `/settings` 录入：`source='parent'`、`owner_user_id=当前家长`；支持单条与批量粘贴
  （每行一句，`English | 中文` 或 Tab 分隔，翻译可留空）。
- 可见性（服务端强制）：官方语料（`owner_user_id IS NULL`）所有人可见；自定义语料只有
  **录入者本人 + 其孩子**（家庭内 `role='child'` 的用户）可见可用；其他家长互相不可见。
- 只能删除自己录的（他人删除 → 403）。

## 6.2 跟读页的三处交互（task-14）

- **参考音静默预热**：句子被选中/切换时（`PracticeClient` 的 `useEffect`）就 fire-and-forget 调
  `POST /api/warmup` → voice `/v1/warmup`（契约 §12），把该句参考音与参考 F0 落缓存。
  不播放、不显示 loading、不阻塞 UI、失败静默忽略；队列**严格串行**（云 TTS 免费层并发=1）并按
  (文本, 语速, 音色) 去重，重复选择不会重复请求。首次进入还会低优先级预热当前等级前 5 句。
  **缓存按 `(provider, 文本, 音色, 语速)` 寻址**（契约 §12.2 的 v1.2 修正：key 必须含 TTS provider 身份），
  所以换 provider 后会自动 miss —— 这是设计如此，不是 bug（避免"合成音被当成母语者示范"）。
- **能力多边形（雷达图）**：`src/lib/radar.ts` 纯函数生成内联 SVG（无图表库），四轴 准确/流利/完整/节奏。
  契约 §3.1 的 `scores.*` 不可得时必须是 `null` —— null 轴画虚线、标 "—"、
  **不参与多边形**（画成 0 等于编造低分）。四个数值同时以文字列出，并额外给出"最需要练的是 X"
  （雷达图面积受轴顺序影响，需要显式文字兜底）。
- **词级反馈用长度编码**：`src/lib/word-encoding.ts` + `WordBars` —— 横向条，条长 = 分数；
  颜色对所有词同色，**不承担任何信息**（色盲友好）；问题词（<60）用 **⚠️ + 置顶排序**（分数升序）
  突出，另加 60 分参考刻度线；完整列表按句子原文顺序放在下面。不看颜色也能一眼看出哪个词最差。
- **整句没听到**：`src/lib/speech-detection.ts` 判定（`recognized_text` 去标点后 ≤1 个字母，或带 `low_snr`）。
  命中时**不展示逐词 0 分热力图**（那会让人以为是自己读错了），改为明确提示
  「这次好像没听到你的声音 —— 离麦克风近一点、说大声一点，再试一次」+ 卡片内直接放重录按钮；
  页面加载时若"上一次"就是这种情况，也会在服务端直接给出同一条提示。

## 6.3 发音诊断 → 口型动画微课 → 强化练习（task-16）

- **诊断 API** `GET /api/diagnosis`：从 `phoneme_mastery` 聚合（**样本 ≥2 才计入**），分档
  `weak(<65) / watch(65–80) / ok(≥80)`，每条含近 3 次趋势方向、关联错误词（该音素得分最低的词）、
  可练句数与一句结论。排序：weak 优先 → 同档按均分升序（ok 按降序）。
  **儿童请求整包零 IPA**（按角色剥离 + `childSafeDeep` 兜底），并用 `childLabel` 作为强化练习 token。
- **`/report` 诊断页**：薄弱音素卡片 = 参数化**口型动画微课** + 口型要点 + 常见错误（仅成人）+
  示范音/例词点读（走 `/api/tts`）+ 最小对立对对比 + 「去练这 N 句」。ok 档折叠在 `<details>` 里。
- **`ArticulationDemo`（`src/lib/articulation-svg.ts` + 组件）**：按 `articulation.ts` 的
  10 个参数（tongueHigh/tongueBack/lipOpen/lipRound/airflow/constriction/…）生成侧面剖面 SVG：
  头部轮廓、上下唇、上下齿、舌（path 按参数变形）、硬腭/软腭、鼻腔（鼻音高亮）、声门（浊音脉动）、
  气流（`stroke-dasharray` 动画，强弱∝airflow；擦音有摩擦标记；塞音/鼻音画闭锁，塞音另有爆破）、
  阻碍点标记；**循环教学动作**（舌头在中性↔目标位置之间循环，可暂停）；**对比模式**并排画两个音并高亮差异点。
  性能/无障碍：`<title>/<desc>`、只在可见时动画、`prefers-reduced-motion` 降级静态帧、SSR 首屏即静态目标帧。
- **强化练习队列**：`/practice?focus=<ipa|儿童标签>`（服务端 `resolveFocus` 两种写法都认）——
  句子按 `focus_phonemes` 过滤、**最小对立对优先**，顶部 banner 说明来源并提供「退出聚焦」；
  **无 focus 参数时行为与原来完全一致**（回归断言在 `check:diagnosis` 里）。

## 6.4 对话朗读（task-18）

- **每条 AI 回复自动朗读**：`ChatClient` 在拿到回复后用 `void readAssistant(index, reply)` 异步补声音 ——
  **文字先渲染**（`setMessages` 在前，TTS 在后），TTS 慢/失败都不影响消息出现。
  开场白同样朗读（点场景那次点击本身就是用户手势，最容易被自动播放策略放行）。
- **不重叠 / 可停止**：`speak()` 内部先 `stopSpeech()` 再播；新一轮用户发言、关闭开关、切场景
  （`clearSpeechCache()`）、组件卸载（`disposeSpeech()`）都会停止并 `revokeObjectURL`。
- **语速/格式**：儿童 `slow`、成人 `normal`。**聊天朗读用 `format: "mp3"`**（回复每次都是新文本 → 必 cache miss，
  此时体积小/传输快：实测同一句 wav 195666B vs mp3 56160B ≈ 1/3）；**练习页的「听示范」保持 wav**
  （与参考音分析共用预热缓存，是 0 等待的）。
- **"正在说话"状态（TTS 真的会慢）**：真实合成延迟在 1–11s 剧烈波动，所以消息旁会依次显示
  `🔊 正在准备语音…` → `🔊 正在说话…`；**不阻塞下一轮输入**（回复文字到达即可继续打字/说话，音频后到）。
  超过 **6s** 未返回就放弃等待，该条的重播按钮变成显眼的 **`🔊 重试播放`** 并提示「语音合成太慢，先不等了」。
- **可排查性**：`/api/tts` 透传 `x-tts-provider` / `x-audio-duration-ms`，前端记在 `console.info("[chat-speech] provider=… duration=…")`。
- **object URL 缓存**：key = `(语速, 文本)`，同一条消息重播**不再请求** `/api/tts`。
- **原生播放器是主路径（task-19 修复"没声音"）**：每条 assistant 消息渲染
  `<audio controls preload="none" src="/api/tts?text=…&rate=…&format=mp3">` —— 播放器的 ▶ 是**真实用户手势，永远能播**；
  自动朗读只是驱动这个元素 `el.play()`。**不再用 6s `AbortController` 掐断请求**（Azure 合成新文本 1–11s，
  掐断就等于"点了没声音"），改为 6s 提示「语音还在生成」、20s 提示「可能生成失败，点播放器重试」；
  `<audio onError>` → 「⚠️ 语音未加载（点播放器 ▶ 重试）」。被拦截时另有「点这里开启朗读」。
- **用户自己的语音可回放（task-19）**：语音输入时保留录音 object URL，渲染在该条 user 消息下
  `<audio controls data-testid="user-audio">`；卸载/切场景 `URL.revokeObjectURL`。
- **录音可取消（task-19）**：录音态多了「✖️ 取消」（儿童「✖️ 不要了」，带 `aria-label`）——
  停止并**彻底丢弃**（不调 `onRecorded`、不提交、不产生云端调用），且**同样释放麦克风**
  （走 `recorder.stop()` → `onstop` → `releaseStream()`；极端情况直接 `releaseStream()`）。
- **儿童语音输入默认展开**（`showMic` 初始 `isChild`）。
- `/chat` 还服务端渲染「最近一次对话（只读）」，每条助手消息带 `aria-label` 的重播按钮
  —— 这样无浏览器环境也能对 `aria-label` 做 HTML 断言。

## 7. 儿童模式（`age_band=child`）

- 大按钮大字（`body[data-child="true"]` 触发的 CSS）、emoji 引导、鼓励动效（纯 CSS）。
- **IPA 一律不下发**：`focus_phonemes`、音素符号、`phoneme_mastery.phoneme` 在服务端就被剥离，
  儿童页面 HTML 里不含任何 IPA 字符（smoke 有断言）。
- 场景按 `min_age ≤ 实际年龄` 过滤（服务端过滤，不只是隐藏 UI）。
- 对话服务端强制 `child_safe: true`，且对回复再做一次不安全词兜底替换（`flag=unsafe_filtered`）。
- `daily_limit_minutes` 到点：`POST /api/attempts`、`/api/chat/*` 返回 **429 + 友好文案**
  （"今天的练习时间到啦，我们明天继续 🌙"），页面显示收尾卡片；儿童不能自行修改时长/自由话题（403）。

## 8. 部署注意事项

1. **`/voice/*` 的 destination 是构建期固化的**：`rewrites()` 在 `next build` 时求值并写入
   `.next/routes-manifest.json`，`next start` 运行时不再读 `process.env.VOICE_SERVICE_URL`。
   因此容器构建**必须**传 build arg：

   ```bash
   docker build --build-arg VOICE_SERVICE_URL=http://voice:8100 -t english-coach-web ./web
   ```

   自检（注意 manifest 里冒号后有空格）：

   ```bash
   grep -o '"destination": *"[^"]*"' .next/routes-manifest.json
   # 期望看到 "destination": "http://voice:8100/:path*"，而不是 127.0.0.1:8100
   # 或： node -e "console.log(require('./.next/routes-manifest.json').rewrites.afterFiles)"
   ```

   本地开发不用管：不传该变量时默认 `http://127.0.0.1:8100`。
   （服务端到 voice 的 API 调用不受影响，那些请求在**运行时**读 `VOICE_SERVICE_URL`。）
2. **镜像里没有任何模型密钥**：web 只读 `VOICE_SERVICE_URL`，密钥只在 voice 侧。
3. 数据卷：`DATA_DIR=/app/data`（SQLite `app.db` + `audio/`）；standalone 镜像里已 `COPY migrations/`
   与 `src/data/`（运行时建表 + 灌种子需要），`scripts/` 也带上了（可用 CLI）。
4. 探活：`GET /api/health`（voice 不可达也返回 200，状态在 body 里）。Dockerfile 已内置 HEALTHCHECK。
5. 环境变量：

   | 变量 | 默认 | 说明 |
   |---|---|---|
   | `VOICE_SERVICE_URL` | `http://127.0.0.1:8100` | 服务端调 voice 的地址（构建期还决定 `/voice/*` 代理） |
   | `DATA_DIR` / `DB_PATH` / `MIGRATIONS_DIR` | `./data` 等 | 数据与迁移位置 |
   | `AUTO_SEED=0` | 开启 | 关闭"users 为空时自动灌种子" |
   | `BOOTSTRAP_DAD_EMAIL/PASSWORD`、`BOOTSTRAP_MOM_*`、`BOOTSTRAP_CHILD_*` | 见上表 | 覆盖初始账号（只在首次创建时生效） |
   | `COOKIE_SECURE=1` | `0` | HTTPS 部署时设置；内网 http 保持 0，否则登录会失败 |
   | `SESSION_SECRET` | — | **不需要**：session 是 32 字节随机串存 `sessions` 表，不做签名 |

## 9. 目录结构

```
web/
├── migrations/0001_init.sql     # 契约 §10 的 DDL（字段名照抄，冻结）
├── src/db/{schema,index,bootstrap}.ts   # Drizzle schema / 连接 / 建表+种子
├── src/lib/{voice,auth,evaluate,attempt-service,review-data,parent-summary,srs,hints,usage,...}.ts
├── src/app/                     # App Router：页面 + /api 路由
│   ├── practice|chat|review|parent|settings|login/
│   └── api/...
├── src/components/{F0Chart,WordHeatmap,ScoreBars,IssueList,Recorder,NavBar}.tsx
├── src/data/{accounts,sentences,scenarios}.json  # 种子数据（66 句 / 11 场景 / 3 账号）
├── scripts/{migrate,seed,mock-voice,smoke}.mjs   # CLI + mock voice + E2E 自测
└── Dockerfile / next.config.ts / eslint.config.mjs / pnpm-workspace.yaml
```

## 10. 已知限制（V1）

- 家长面板是**只读**的：没有"家长建孩子账号 / 改孩子密码"的 UI（账号来自 seed / 环境变量）。
- 没有密码找回、邮箱验证、限流；session 30 天，退出即从 `sessions` 表删除。
- `nbest` 只在 `phoneme_level=true` 且 provider 支持时展示；`local` 模式下整块音素 UI 都是粗评。
- 语音输入（`/api/asr`）依赖 voice 的能力，失败时提示直接打字。
- 音频没有做 Range 请求支持（`accept-ranges: none`），长音频拖动进度条体验一般。
- `prettier` 未接入（`pnpm lint` 只跑 ESLint）。
- 盲测固定组来自"上一次盲测的句子"或"练过的语料前 10 句"；如果家长删掉了其中某句，会在下次开始
  盲测时自动剔除（组会缩小），不做历史组回填。
- 盲测时长计入每日上限，但只有分数类指标排除盲测；`practice_sessions.kind='blindtest'` 可单独统计。
- 家长自定义语料没有"编辑"（只能删除后重新录入），也没有分页（一次最多批量 200 行）。
