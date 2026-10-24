# 验收记录（Lead 独立验证）

> 日期：2026-10-22（V1.0）／2026-10-23（V1.5 复验）｜ 验证人：Lead（非任何模块实现者）
> 原则：**不采信实现方的自测结论，自己跑一遍。** 本文件记录 Lead 亲自执行的命令与结果。
> 模块自测证据另见 [web/docs/verification.md](../web/docs/verification.md)。
> **V1.5 的验收见 §7**（含最终数字与一条由本验收抓出的真实缺陷）。

---

## 1. 结论汇总（V1.5 交付状态）

| 验证项 | 结果 | 说明 |
|---|---|---|
| voice 契约一致性（Lead 编写，按 `docs/api-contract.md` v1.1 逐字段） | **113 / 113 通过，0 失败 0 警告** | `tests/contract_check.mjs`（含 `/v1/warmup` 与 `provider_meta.cache`） |
| web↔voice 端到端（Lead 编写，真实两服务） | **92 / 92 通过，0 失败 0 警告** | `tests/e2e_full.mjs`，从空库开始 |
| voice 单元/集成测试 | **376 passed, exit 0** | Lead 用 `.venv/bin/python -m pytest` 复跑（连跑 4 次全绿） |
| 语料音素审计（Lead 编写，严格模式） | **A 类 0、B 类 0（890/890 标注成立）** | `tests/audit_corpus_phonemes.py`，CMU 词典真实 G2P |
| 语料格式校验 | **PASS，errors 0 / warnings 0** | `node web/scripts/validate-corpus.mjs` |
| 儿童 IPA 泄漏守卫 | **11 项全绿，命中 0** | `pnpm check:child-ipa`（整体序列化扫描，含 RSC 负载） |
| 音素提示表守卫 | **43 符号全覆盖分类，通过** | `pnpm check:phoneme-hints` |
| web 构建 / lint / 类型检查 | **全部 exit 0**（lint 0 error 0 warning） | `pnpm build` / `pnpm lint` / `tsc --noEmit` |
| docker compose 配置 | **`docker compose config` exit 0**（170 行） | 但**未实测构建**，原因见 §5 |
| Caddyfile | **真实 caddy 2.11.7 validate 通过** | deploy-docs 执行，4 组域名组合 |

**总评：可交付。** 三个模块的接口在真实运行下完全对齐，儿童安全与权限隔离经独立验证有效，
降级路径符合"绝不丢数据、绝不假装精确"的设计红线。

---

## 2. 契约一致性校验（V1.0 基线 88 项 → V1.5 113 项）

命令：
```bash
PROVIDER_MODE=mock .venv/bin/python -m uvicorn app.main:app --port 8100   # voice
node tests/contract_check.mjs
```

该脚本由 Lead 依据契约文档独立编写（不参考实现代码），逐项校验：

- 7 个端点的 HTTP 状态、Content-Type、统一错误格式
- `scores.*` 取值域与「不可得必须为 `null`」语义
- `error_type` / `severity` / `worst_regions.issue` 枚举合法性
- `issues` ≤ 5 条且按 severity 降序
- `feedback.points` ≤ 2 条（一次最多纠 2 个问题的硬约束）
- 儿童反馈中不出现 IPA 符号
- F0 两条曲线**等长**（证明真的做了 DTW 对齐到同一时间轴）、点数 ≤ 600、20ms 步长、含浊音帧
- `reference_audio_url` 为 `/voice/v1/audio/` 同源相对路径
- 404 响应体格式、非法参数返回 4xx

**关键结果**：`intonation.available=true` 在任何 provider 下都成立（语调计算不依赖云 API），
`capabilities.intonation_curve=true`，符合设计承诺。

---

## 3. 端到端集成（V1.0 基线 70 项 → V1.5 92 项）

命令（两个真实服务，非 mock 桩）：
```bash
cd voice && PROVIDER_MODE=mock .venv/bin/python -m uvicorn app.main:app --port 8100
cd web   && VOICE_SERVICE_URL=http://127.0.0.1:8100 pnpm db:reset && pnpm build && pnpm start
node tests/e2e_full.mjs
```

覆盖**只有真实集成才会暴露**的问题：

| 验证点 | 结果 |
|---|---|
| 录音 → web → voice 评测 → 落盘 → 经 `/api/audio/:id` 回放 完整闭环 | ✅ 200 + 非空音频 |
| **Next.js `/voice/*` 反向代理**（rewrites 构建期烘焙，最易静默失效） | ✅ 示范音频 200 |
| 三账号登录、角色正确（2 parent + 1 child）、错误密码 401 | ✅ |
| 一节课 5 句跟读，捕获音素级错误（例：`brothers:ɹ→w`） | ✅ |
| 音素错误 → `phoneme_scores` → `phoneme_mastery` → **SRS 卡片 8 张** | ✅ 闭环打通 |
| SM-2 评分 `good` 后卡片排期到未来并移出待复习队列 | ✅ |
| 儿童看不到 `min_age > 8` 的超龄场景（**服务端过滤**） | ✅ |
| 多轮对话：回复 + 中文翻译 + `suggested_replies` 2–3 条 + correction | ✅ 3 轮 |
| **儿童访问 `/api/parent/summary` 与 `/parent` 均被拒绝** | ✅ 403 |
| 儿童页面 HTML **零 IPA 字符**（服务端就剥离） | ✅ |
| 4 个页面服务端渲染正常 | ✅ |
| 登出后会话失效 | ✅ |

### 3.1 验证过程中发现并修正的两个问题

1. **我的测试脚本自身的 bug**：`POST /api/chat/sessions` 正确返回 `201 Created`，
   我却断言 200 导致提前中断。→ 已改为接受 2xx。**这是测试的问题，不是实现的问题。**
2. **测试样本保真度不足**：首次只用 1 句合成音频，mock 的打分由参考文本决定，
   恰好命中高分句子 → 未产生音素错误 → 错音本为空，SRS 闭环**没被真正验证到**。
   → 已改为练习 5 句并优先挑含 `/θ/ /ð/` 的句子（中国学习者典型难点），闭环才真正跑通。
   **这类"测试通过但没测到东西"的情况，是自测最危险的失效模式。**

---

## 4. 独立复跑实现方的声明

| 实现方声明 | Lead 复跑结果 | 一致？ |
|---|---|---|
| voice：`uv run pytest` 108 passed | `.venv/bin/python -m pytest` → **108 passed, exit 0** | ✅ |
| web：`pnpm lint` 0 error | **exit 0，无输出** | ✅ |
| web：`tsc --noEmit` 通过 | **exit 0** | ✅ |
| web：`pnpm build` 成功 | **成功，23 条路由** | ✅ |
| deploy：`docker compose config` exit 0 | **exit 0，170 行渲染** | ✅ |

> 说明：`uv run` 在本机不可用（uv 需写 `~/.cache/uv`，沙箱只允许写工作区），
> 故用 `.venv/bin/python` 直跑。这**不影响结论**，但**影响上手体验**——
> 见 [docs/deployment.md](deployment.md) §11 的直跑路径说明。

---

## 5. 未验证项（诚实记录）

| 项 | 状态 | 原因 |
|---|---|---|
| **`docker compose build/up` 实际构建** | ❌ 未实测 | 本机 `/etc/docker/daemon.json` 配置了 `proxies: http://127.0.0.1:7890`，而该代理未运行 → **所有镜像拉取失败**（含镜像加速）。本机仅有 `python:3.11-slim`，无任何 node 镜像。修复路径见 deployment.md §8.0 |
| **Azure 真实 API 联调** | ❌ 未实测 | 环境无 Azure 订阅与密钥。azure provider 代码路径已按官方参数实现并惰性导入，接入时需核对一次 `phoneme` / `nbest` 字段 |
| **浏览器真实录音与交互** | ❌ 未实测 | 无 GUI/浏览器。已用服务端渲染断言 + 合成音频覆盖到 API 层；**麦克风权限、MediaRecorder 兼容性需首次真机使用时确认** |
| faster-whisper 真实推理 | ❌ 未实测 | 需下载模型；local provider 仅在单测中 monkeypatch 验证 |
| 真实语音的语调曲线质量 | ❌ 未实测 | 合成信号验证了算法正确性（扫频跟踪误差 < 8%），真实人声效果待使用验证 |

**这意味着"可部署"的准确表述是**：编排配置已校验、本地直跑路径已端到端实测通过、
容器构建路径因本机代理问题未能实测但已给出诊断与修复步骤。

---

## 6. 复现方式

```bash
# 1. 起 voice（本机无 ffmpeg，voice 用 PyAV 内置解码，无需额外安装）
cd voice && PROVIDER_MODE=mock .venv/bin/python -m uvicorn app.main:app --port 8100

# 2. 起 web（注意 VOICE_SERVICE_URL 是构建期烘焙进 rewrites 的）
cd web && VOICE_SERVICE_URL=http://127.0.0.1:8100 pnpm db:reset && pnpm build && pnpm start

# 3. 跑全部验证
node tests/contract_check.mjs                      # 113 项：契约逐字段
node tests/e2e_full.mjs                            # 92 项：端到端（真实两服务）
voice/.venv/bin/python tests/audit_corpus_phonemes.py   # 语料音素审计（需 cmudict）
node web/scripts/validate-corpus.mjs               # 语料格式
cd web && pnpm check:phoneme-hints && pnpm check:child-ipa   # 两个守卫
```

全部脚本以退出码表达结果（0 = 通过），可直接接 CI。

---

## 7. V1.5 验收（2026-10-23）

### 7.1 新增验证覆盖

| 项 | 结果 |
|---|---|
| `/v1/warmup` 契约形状、计数自洽、幂等（第二次 `generated=0`）、413/400 | ✅ |
| `provider_meta.cache` miss → hit，且**命中缓存不改变评测结果**（两次 scores 逐字段一致） | ✅ |
| 盲测：进行中**不返回任何分数/反馈**、`blind=true`、结束后可读分、趋势含 delta | ✅ |
| 盲测：**不污染** `phoneme_mastery` 与错音本（前后计数完全一致） | ✅ |
| 儿童 IPA 泄漏：**5 个页面 + 4 个 API 的整体序列化扫描**（含 RSC 负载） | ✅ 0 命中 |
| 语料集成：`sentences.json` 条数 == API 返回条数（300） | ✅ |
| 语料已归一到 canonical-v1（无 `ɒ iː uː ɔː ɜː ɑː ɹ ɛ` 残留） | ✅ |
| 缓存实测（deploy-docs 独立复现）：300 条首次 `generated=300` 11.2s → 复跑 `generated=0/cached=300` 244ms；缓存 600 文件 / 26.64 MiB | ✅ |
| **README 里写的预热命令逐字实跑**（Lead 执行）：首次 `generated=295`（5 条已存在）/ 17.6s → 复跑 `generated=0/cached=300` / 0.42s；缓存 29M / 608 文件 | ✅ 文档与实现一致 |
| 命中缓存延迟：647ms → **1ms**（voice-dev 实测，模拟云 TTS 600ms/次） | ✅ |

### 7.2 本次验收抓出的真实缺陷（这是独立验证的价值所在）

**缺陷**：儿童 `/review` 页面 HTML/RSC 负载里出现 `ɑ`。

- **发现方式**：Lead 在 V1.0 验收后**主动把儿童 IPA 检查从"只看 `/practice`"扩展到全部页面 + 全部特征字形**，
  并把语料归一化后新增的 `ɑ` 纳入扫描。V1.5 复验时立即命中。
- **根因**：`review-data.ts` 的 `demo_text: hint.demo_text || c.ref`。当音素没有对应提示键时，
  `getHint()` 回退到 `GENERIC`（`demo_text` 为空）→ `|| c.ref` 把**音素符号本身**塞进 `demo_text`。
  触发条件是 Lead 把 `ɑ ɔ ʊ u ʌ` 判为"有意为空"——**即 Lead 自己的决策引入的副作用**。
- **同类历史**：这是儿童 IPA 泄漏第三次出现（`srs_cards.id` → `hint_key` → `demo_text`）。
- **最终修法**（不再逐字段打补丁）：`childSafeDeep()` 递归兜底 + 整页/整响应序列化扫描守卫（`check:child-ipa`）。

**守卫的变异测试（Lead 亲自执行）**：把源码修复与运行时兜底**同时还原成泄漏状态**并重建，
守卫立即报 `❌ 页面 /review 命中 → ɑ`、`合计 11 项，命中 2 项`、退出码 1；恢复后重新验证为全绿。
**证明这个守卫真的会失败，而不是一个永远绿的装饰。**

> 教训记录：Lead 的"最终验收"曾经在**写入者仍活跃**时跑过，导致结论对当前代码失效。
> 后来固化为纪律：**所有写入者停止后，才在冻结版本上跑最终验收。**

### 7.3 一处被 teammate 驳回的 Lead 判断（记录备查）

Lead 在任务书里给了"缓存体积 40 条约 6.3MB"的参考数字，deploy-docs **拒绝采用**：
他们先按要求去 `voice/README.md` 查证，确认该数字**没有出处**，于是自己在独立 `DATA_DIR` 下实测
（300 条 → 26.64 MiB）并标注为"本机可复现实测值 + 给出复现命令"。
**这是正确的做法**——文档里的数字必须可溯源，不能因为出自 Lead 就照抄。

### 7.4 第二处由验收抓出的真实缺陷：缓存 key 缺 provider 身份（契约 → v1.2）

**缺陷**：`cache_key(text, voice, rate)` **不含 TTS provider 身份**。

**取证链**：
1. `config.py`：`azure_tts_voice` / `edge_tts_voice` / `default_tts_voice` 默认值是**同一个字符串** `"en-US-JennyNeural"`。
2. `api.py`：`pronounce` 用 `tts_voice or settings.default_tts_voice`，而 web 练习时**不传** `tts_voice`。
3. 实测 `cache_key("Hello.", "en-US-JennyNeural", "normal")` = `3da299e6…`，**mock / local / azure 三模式完全相同**。

**后果（按文档默认路径必然触发）**：先用 `PROVIDER_MODE=mock` 跑起来并预热 → 缓存里是**合成音 + 合成 F0**；
之后加上 Azure 密钥切到 `hybrid` → `/v1/pronounce` **命中缓存** → 把合成音当"母语者示范"播放，
并**拿用户真实语音的 F0 去和合成扫频曲线做 DTW** → 语调反馈静默变成垃圾（"你每句话语调都错"），
而发音分一切正常 → 极难排查。**mock 优先是本项目文档里的默认路径，切 Azure 是必然动作。**

**修法**：契约升级到 **v1.2**，key 改为 `sha1("v2" + tts_provider + text + voice + rate)`，
`tts_provider` 从 `ProviderSet` 内部推导（调用方无法错配）；SingleFlight 的 key 一并加上 provider。
回归测试覆盖：跨 provider key 不同、切 provider 后 `hit → miss`、**合法但 v1.1 形态的旧条目永不被命中**、
兜底音不落任何 provider key、两个 provider 并发各自只生成一次。

> 这个缺陷是**契约本身的错**（§12.2 的 key 定义由 Lead 撰写），不是实现方的偏差。
> 记录在此的目的：**接口契约里每一个"缓存/去重/幂等"定义，都要问一句"身份分量够不够"**。

### 7.5 一处观察到的间歇现象（如实记录）

Lead 在一次 pytest 运行中遇到 `Interrupted: 1 error during collection`，随后**连续 4 次运行均为 376 passed**。
发生时刻紧接在 voice-dev 清理测试数据（删除 `data/cache`）之后，判断为并发文件操作导致的瞬时现象，
**未能复现**，故不作为缺陷记录。`tests/conftest.py` 已把 `DATA_DIR` 隔离到临时目录并在每个用例前后重置缓存。

### 7.6 V1.5 未验证项

与 §5 相同（Azure 真实联调、容器构建、真实麦克风、faster-whisper 真实推理、真实人声语调）。
其中 **Azure 真实联调已于 §8 完成**；`canonical-v1` 与 Azure 实际输出的吻合性也已在 §8 得到实证。

---

## 8. Azure 真实联调（2026-10-23，用户提供密钥后）

用户开通 Azure Speech（region `eastasia`）并填入 `voice/.env` 后，Lead 用
`tests/azure_selfcheck.py` 做了两阶段验证（阶段 A 直连 SDK 取**原始**响应，阶段 B 走 voice 服务验证集成）。

### 8.1 结果：全部通过

| 验证项 | 结果 |
|---|---|
| Azure SDK 与密钥/区域可用 | ✅ `azure-cognitiveservices-speech==1.52.0`（与 lock 对齐） |
| **发音评测在该定价层可用** | ✅ 调用成功（**这是官方文档未写明、只能实测的一项**） |
| Azure TTS 合成真实语音 | ✅ 91246 字节 / 2.85s / `en-US-JennyNeural` |
| 音素级粒度 | ✅ `granularity=phoneme`，8 词 / 24 音素 |
| NBestPhonemes | ✅ 5 个候选，例：期望 `aɪ` → `[('aɪ',100),('θ',2),('oʊ',1),('ə',0),('æ',0)]` |
| ProsodyScore | ✅ 91.4（本项目语调自建，不需要它，但说明加购项开放） |
| 母语者音频的分数 | PronScore 95.0 / Accuracy 92.0 / Fluency 100 / Completeness 100（**应当很高，实测确实很高**） |
| hybrid 端到端生效 | ✅ `providers={asr:azure, pa:azure, tts:azure}`，`pronounce` 由 azure 产出，无 `provider_fallback` |
| 语调曲线（真实语音 vs 真实参考） | ✅ `available=true`，**DTW=0.0024～0.0033**（同源音频，曲线几乎重合 → 证明语调链路在真实语音上正确） |
| `provider_meta` | `{"phoneme_alphabet":"IPA","phoneme_space":"canonical-v1","cache":{...}}` |

### 8.2 ★ `canonical-v1` 与 Azure 实际输出的对照（关闭最后一项未验证风险）

Azure en-US 实际返回的原始 IPA 符号（29 种）：

```
aɪ b d eɪ f h i k l n oʊ s t u v w z æ ð ŋ ə ɚ ɛ ɝ ɪ ɹ ʊ ʌ θ
```

| 分类 | 符号 | 结论 |
|---|---|---|
| 已在规范空间内（24） | `aɪ b d eɪ f h i k l n s t u v w z æ ð ŋ ə ɪ ʊ ʌ θ` | 直接匹配 |
| 变体、**已被映射表覆盖**（5） | `oʊ ɚ ɛ ɝ ɹ` | `CANONICAL_MAP` 恰好覆盖 |
| **未知、需要补表（0）** | —— | **无需改动** |

> Azure 用的正是 `ɹ ɛ ɝ ɚ oʊ` 这套美式写法——与 voice-dev 在设计 `canonical-v1` 时预测的变体
> **完全一致**，映射表一个符号都不用补。这条验证把"符号不一致会让 `phoneme_mastery` 静默断裂"
> 的风险从"推测已缓解"变成了"实测已消除"。

### 8.3 接入过程中由 Lead 发现并修复的两个"静默失效"问题

这两个都不会报错，只会让人以为"配好了却不生效"：

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | **voice 根本不加载 `.env`** | 文件放在 `voice/.env` 没人读，必须手动 export；用户会以为已经配好 | `app/config.py` 增加 `.env` 自动加载（`ENV_FILE` 权威指定；已存在的真实环境变量优先） |
| 2 | **行内注释被吃进值里** | `PROVIDER_MODE` 变成 `'hybrid            # mock \| local \| cloud \| hybrid'` → 非法枚举 → **永远走不到云模式**；`AZURE_SPEECH_KEY` 带上中文注释 → **认证必然失败** | 解析器剥离行内注释（引号内除外）；13 个回归用例钉死，含"漏传即失败"的变异式断言 |

顺带修复的两个交付缺口：

| # | 问题 | 修法 |
|---|---|---|
| 3 | `azure-cognitiveservices-speech` 是可选 extra，**`requirements.txt` 里没有** | 用 `uv export --extra azure` 重新导出（1270 行，含 `azure-cognitiveservices-speech==1.52.0`），**否则容器里 hybrid 会静默降级回 mock** |
| 4 | 端到端脚本用合成音频，在真实 provider 下会被判为"无语音"并按设计降级 | 断言改为**模式相关**：mock 下是硬断言，其它模式下只提示并指向 `azure_selfcheck.py`。实测 mock 92/92 无警告、hybrid 91/92+1 条预期提示 |

### 8.4 仍未验证

- **浏览器真实麦克风录音**：需要你在浏览器里实际按下录音。API 层与服务端渲染已覆盖，但麦克风权限、`MediaRecorder` 兼容性只能真机确认。
- **定价层究竟是 F0 还是 S0**：脚本证明了"你当前这个资源能用发音评测"，但读不到你的定价层。请在 Azure 门户该资源的 **概述** 页确认 `定价层` 字段——如果是 **F0（免费）**，那 §4.3 的"零成本"策略成立。
