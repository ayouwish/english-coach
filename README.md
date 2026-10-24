# english-coach｜家庭英语口语教练

给一家三口（爸爸、妈妈、6–9 岁女儿）自用的英语练习 Web 应用。

**核心能力**：音素级发音纠正 · 语调（F0）对比曲线 · 日常对话角色扮演 · 错音本与间隔复习 · **盲测周报** · 家长面板 · 儿童模式

**语料**：300 句（A1/A2/B1 各 100，含 7 组中国学习者难点最小对立对）· **家长可录入自己课本上的句子**

---

## 30 秒看懂这是什么

打开网页，选一句话，按下录音跟读，系统告诉你：

> 「整体不错，节奏很自然 👍 有两点可以改进：
> 1️⃣ `think` 里的 /θ/ 你发成了 /s/。舌尖要轻轻伸到上下齿之间，让气流从缝隙摩擦而出。练一下：think / thank / three
> 2️⃣ "really nice" 这里语调偏平 —— 你看这条曲线，母语者是往上挑的，你这里是平的。我读一遍你跟读 🔊」

然后进入对话模式，陪女儿在"咖啡店点单"的场景里练 6 轮，她说不出来的时候点一下建议回答就行。

**为什么自己做而不是用 Duolingo**：内容可以自己定、能追踪每个音素三个月的进步曲线、儿童和成人用两套完全不同的交互、语音数据留在自己家里。

---

## 文档地图

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| [docs/architecture.md](docs/architecture.md) | **系统设计主文档**：需求边界、架构、选型理由、技术取舍、路线图、验收指标 | 想理解"为什么这么设计" |
| [docs/api-contract.md](docs/api-contract.md) | web ↔ voice 的冻结接口契约 + 数据库 schema | 要改代码 |
| [docs/hardware-cost.md](docs/hardware-cost.md) | **需要买什么硬件**、三档配置与价格、每月成本 | 决定要不要花钱 |
| [docs/deployment.md](docs/deployment.md) | 部署操作手册：本机 / 家用主机 / 公网域名 | 要把它跑起来 |
| [docs/verification.md](docs/verification.md) | **验收记录**：Lead 独立跑的 88 项契约校验 + 70 项端到端，含未验证项 | 关心"到底验没验过" |
| [web/README.md](web/README.md) | 前端模块、三账号密码 | 改界面 |
| [voice/README.md](voice/README.md) | AI 网关、provider 切换 | 换模型 / 接 Azure |

---

## 目录结构

```
english-coach/
├── docs/          设计与部署文档（先读这里）
├── web/           Next.js 15 应用：账号、跟读、对话、错音本、家长面板
├── voice/         FastAPI AI 网关：ASR / 发音评测 / TTS / LLM 反馈 / 对话
├── deploy/        docker compose + Caddy(TLS) + 环境变量模板
├── tests/         独立契约校验与端到端验证（Lead 维护，不属于任何单模块）
└── data/          docker 部署时的数据目录（SQLite + 音频）；本机直跑默认落在 web/data/
```

> 数据位置由 `DATA_DIR` 控制：docker 里是 `/data`（绑定到本目录 `data/`），
> 本机直跑时不设则是 `web/data/`。**备份就是把那个目录打包。**

**两条铁律**：
1. **模型密钥只在 `voice/`。** `web/` 和浏览器都不持有任何 API key。
2. **`PROVIDER_MODE=mock` 必须能全链路跑通。** 没有密钥、没有 GPU、完全离线时，产品依然可用可测。

---

## 快速开始

### 最快路径：本机直跑（不需要 docker）

```bash
# 终端 1 — AI 网关（默认 mock 模式，无需任何密钥）
cd voice
uv sync
PROVIDER_MODE=mock uv run uvicorn app.main:app --port 8100
# 若 uv 不可用（例如缓存目录不可写），退回：
#   .venv/bin/python -m uvicorn app.main:app --port 8100

# 终端 2 — Web 应用
cd web
pnpm install
pnpm db:reset          # 建库 + 灌入 300 句语料与 11 个对话场景
VOICE_SERVICE_URL=http://127.0.0.1:8100 pnpm build && pnpm start

# 终端 3（可选，但强烈建议做一次）— 预热语料缓存
cd voice
python3 -c "import json;print('\n'.join(s['text'] for s in json.load(open('../web/src/data/sentences.json'))['sentences']))" > /tmp/corpus.txt
.venv/bin/python scripts/warmup.py --text-file /tmp/corpus.txt
# 效果：示范音与参考 F0 曲线各生成一次，之后跟读不再调用云 TTS
# 实测：300 条首次约 11s；复跑 generated=0（幂等，可安全重跑）
# 命中缓存后跟读延迟 647ms → 1ms
```

> `VOICE_SERVICE_URL` 在 `pnpm build` 时就被烘焙进 Next.js 的 rewrites
> （`/voice/*` 反向代理）。**改了端口或地址必须重新 build，改运行时环境变量无效。**
> 自检：`grep -o '"destination":"[^"]*"' .next/routes-manifest.json`

浏览器打开 **http://localhost:3000** 登录。

> ⚠️ **必须用 `localhost` 访问，不要用局域网 IP。** 浏览器只在"安全上下文"下开放麦克风权限，
> `http://192.168.x.x` 不是安全上下文，录音按钮会直接失效。局域网/公网访问必须上 HTTPS，
> 见 [docs/deployment.md](docs/deployment.md)。

### 接上真实云 API（拿到音素级反馈）

**第 1 步：装 Azure SDK（不装的话 hybrid 会静默降级回 mock，你只会看到一条 warning）**

```bash
cd voice
UV_CACHE_DIR="$PWD/.uv-cache" uv pip install --python .venv/bin/python "azure-cognitiveservices-speech"
# 或者： uv sync --extra azure
```

> 这是**可选依赖**，默认不装（这样没有密钥的机器也能全链路跑 mock）。
> 装没装可以直接查：`.venv/bin/python -c "import azure.cognitiveservices.speech"`

**第 2 步：填 `voice/.env`**

```bash
cd voice && cp .env.example .env
```

```ini
PROVIDER_MODE=hybrid
AZURE_SPEECH_KEY=<你的 KEY 1>      # 值里不要带注释，或确保 # 前有空格
AZURE_SPEECH_REGION=eastasia
```

> `voice/.env` 会被服务**自动加载**（`ENV_FILE` 可指定其它路径；已存在的真实环境变量优先）。
> 行内注释（`KEY=value   # 说明`）会被正确剥离——这一点有回归测试钉着，因为它曾经让
> `PROVIDER_MODE` 变成非法枚举、让密钥带上中文注释，**两个都不报错，只是永远用不上 Azure**。

**第 3 步：一条命令验证**

```bash
cd voice && .venv/bin/python ../tests/azure_selfcheck.py
```

它会：直连 Azure 合成一句母语者示范音 → 把这段音频喂给发音评测 → 报告
① 你的定价层能不能用发音评测 ② 能否拿到音素级 + NBestPhonemes + Prosody
③ **Azure 返回的音素符号是否与项目的 `canonical-v1` 吻合**（不吻合会直接告诉你该补哪个符号）
④ 经 voice 服务时 hybrid 是否真的生效（而不是静默降级）。**脚本永不打印密钥。**

不填密钥也能用，只是发音评测会降级为**单词级粗评**，且界面上会明确标注 —— 见下节。

### 用 docker 部署（长期常驻）

```bash
cd deploy && cp .env.example .env && docker compose up -d --build
```

---

## 三种运行模式

| 模式 | `PROVIDER_MODE` | 需要什么 | 发音反馈精度 | 成本 |
|---|---|---|---|---|
| **mock** | `mock`（默认） | 什么都不需要 | 假数据（用于开发与自动化测试） | ¥0 |
| **local** | `local` | 首次下载模型 | **单词级粗评** + 精确的语调曲线 | ¥0（只花电费） |
| **hybrid** ⭐ | `hybrid` | Azure Speech 密钥 | **音素级** + "你实际发成了什么音" + 韵律分 | 约 ¥100–200/月 |

**推荐 `hybrid`**：音素级反馈是这款产品的核心价值，云端 API 目前是唯一能给出
"你把 /θ/ 读成了 /s/" 这种可执行结论的途径。`.env` 里一行配置即可切换，代码不用动。

### 降级是设计的一部分，不是故障

```
云 API 正常    → 音素级 + NBest + 韵律
云 API 超时/挂 → 自动降级到本地词级，界面标注「单词级粗评」，绝不假装精确
全都不可用     → 录音与文本照常入库，提示「稍后可重试」，一条数据都不丢
```

**红线**：绝不允许拿 ASR 置信度冒充音素级发音分 —— 那等于教错人。

---

## 三个账号

首次 `pnpm db:reset` 会创建（密码见 [web/README.md](web/README.md)）：

| 账号 | 角色 | 模式 |
|---|---|---|
| 爸爸 | parent | 完整音素级反馈 + 自由话题 |
| 妈妈 | parent | 完整音素级反馈 + 情景对话 |
| 女儿（约 8 岁，2018 年生） | child | 儿童模式：不显示 IPA、口型提示、每日 20 分钟上限、儿童安全过滤 |

家长账号还能看到 `/parent` 面板：学习时长、平均分趋势、高频错音 TOP10、女儿今日剩余时长。
儿童账号访问 `/parent` 会被服务端拒绝（403）。

---

## V1.5 新增

| 功能 | 说明 |
|---|---|
| **盲测周报** | 每周一次 10 句盲测，**全程不给任何分数**（一旦给了，用户就会立刻重读，测量随即失效——而且是静默失效），结束后才看周环比。这是唯一能诚实回答"到底有没有变好"的指标 |
| **缓存预热** | 示范音与参考 F0 曲线按 `(文本,音色,语速)` 预生成一次、永久复用。跟读延迟 **647ms → 1ms**，云 TTS 调用降到接近零（省延迟和省钱同时达成） |
| **语料 300 句** | A1/A2/B1 各 100 句，含 **7 组 139 句最小对立对**（θ-s / ð-z / r-l / v-w / n-ŋ / ɪ-i / æ-e）——这是为中国学习者的高频难点专门写的 |
| **家长自定义语料** | 把女儿课本上的句子录进来（支持整段粘贴），只有录入者与自己的孩子可见 |

### 两个不显眼但要紧的设计

- **音素符号空间 `canonical-v1`**：语料、voice 输出、SRS 卡片 key 必须在同一符号空间，否则同一个发音错误会生成两张卡，`phoneme_mastery` 的长期追踪会**静默断裂**。规范空间定义在 `voice/app/phonemes.py`，Azure 联调时只需改一张表。
- **儿童 IPA 安全网**：6–9 岁不该看到 IPA 符号，而 IPA 在这个项目里从三个不同路径漏出去过（卡片 id → 提示键 → 示范文本）。最终形态是"运行时递归兜底 + 整页序列化扫描守卫"两层，而不是逐字段打补丁。

---

## 验证

两个脚本都以退出码表达结果（0 = 通过），可直接接 CI。

```bash
# 1. 契约一致性：按 docs/api-contract.md 逐字段校验 voice 的 7 个端点
node tests/contract_check.mjs     # → 113 项通过

# 2. 端到端：真实 web + 真实 voice，覆盖三账号全流程与集成接缝
node tests/e2e_full.mjs           # → 92 项通过

# 3. 语料音素审计（用 CMU 词典做真实 G2P，需先装 cmudict）
voice/.venv/bin/python tests/audit_corpus_phonemes.py

# 4. 两个守卫
cd web && pnpm check:phoneme-hints && pnpm check:child-ipa
```

**当前验收状态**（详见 [docs/verification.md](docs/verification.md)）：

| 项 | 结果 |
|---|---|
| 契约一致性 | ✅ 113 / 113 |
| 端到端集成 | ✅ 92 / 92（0 警告） |
| voice 单元/集成测试 | ✅ 376 passed |
| 语料音素审计 / 格式校验 | ✅ A 类 0、B 类 0（890/890）／PASS |
| 儿童 IPA 泄漏 / 提示表守卫 | ✅ 11 项全绿 ／ 43 符号全覆盖 |
| web build / lint / typecheck | ✅ 全部 exit 0（lint 0 error 0 warning） |
| docker compose 配置 | ✅ 已校验；⚠️ 容器构建未实测（本机 docker 代理故障） |
| Azure 真实 API、真实麦克风交互 | ⚠️ 未实测（无密钥 / 无浏览器），首次真机使用时需确认 |

> 四个守卫都做过**变异测试**（人为制造缺陷确认它会变红），不是"永远绿"的装饰。

---

## 隐私

- **麦克风只在你主动录音时打开，录完立即释放**，没有常驻监听、没有后台录音、不落盘、不上传——音频只在你点「说完啦」后随评测请求发送。这是网页版相对常驻语音设备最大的隐私优势。
  - 实现细节：每次点「按这里开始说」/「跟我读」才申请麦克风，**停止后立刻 stop 掉音频轨道**。这样做不仅是为了隐私——**常开麦克风会占住音频输出**（USB 耳麦会切到通话模式），导致示范音播不出来，所以必须做到"用完就放"。
  - 代价：USB 耳麦冷启动有 1–3 秒延迟，所以按钮会显示「麦克风准备中…」，就绪后**自动开始录音**，看到变成「⏹️ 说完啦 0s」再开口即可。
- 音频默认只落本地 `data/audio/`，不上传第三方；密钥只在 `voice/` 的 `.env`。
- 儿童数据额外谨慎：家长可查看、可删除，不接入任何第三方分析 SDK。
- **备份 = 打包 `data/` 一个目录。**

---

## 上手建议

1. **先别买任何硬件。** 用现在的电脑 + 一副有线耳麦（约 ¥100）就能开始 ——
   发音评测的准确率第一瓶颈是**房间安静程度**，不是麦克风价格。
2. 跑通后**让女儿连续用两周**。如果两周后她还会主动打开，这个产品成立；
   如果不会，问题在教学闭环而不在硬件，加麦克风阵列只会更贵地失败。
3. 想要音素级反馈时再去开 Azure（有免费额度），按 [docs/hardware-cost.md](docs/hardware-cost.md) 的用量估算走。
