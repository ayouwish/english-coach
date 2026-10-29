# english-coach｜家庭英语口语教练

[![CI](https://github.com/ayouwish/english-coach/actions/workflows/ci.yml/badge.svg)](https://github.com/ayouwish/english-coach/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**给一家人自用的英语口语陪练 Web 应用**：音素级发音纠正 · 语调曲线对比 · 情景对话角色扮演 ·
错音本与间隔复习 · 薄弱音素自动诊断与口型动画微课 · 儿童模式。

> **English**: A self-hosted English speaking coach for a family — phoneme-level pronunciation
> feedback, F0 intonation comparison, LLM role-play conversation, SRS review, automatic weak-phoneme
> diagnosis with parametrized mouth-position animations, and a dedicated child mode that never
> exposes IPA. Two services (Next.js + FastAPI), SQLite storage, runs on a NAS via Docker Compose.
> All AI providers are pluggable and can fall back to local/offline implementations.

---

## 它解决什么问题

市面上的口语 App 大多是"给你打个分"，但这个分数对孩子没有指导意义。这个项目想做的是
**把分数翻译成"舌头顶在哪里、气流怎么走"**，并且顺着孩子的真实错误去安排练习：

> **整体不错，节奏很自然 👍 有两点可以改进：**
> 1️⃣ `think` 里的 /θ/ 你发成了 /s/。舌尖要轻轻伸到上下齿之间，让气流从缝隙摩擦而出。
>    练一下：think / thank / three
> 2️⃣ "really nice" 这里语调偏平 —— 你看这条曲线，母语者是往上挑的，你这里是平的。

而且它**认识你的孩子**：练一段时间后，系统会自己发现"她最薄弱的音是 /z/ 和 /θ/，
而且 /θ/ 总是读成 /s/"，然后生成对应的口型动画微课与强化练习队列。

## 功能

| 功能 | 说明 |
|---|---|
| **跟读练习** | 300 句语料（A1/A2/B1 各 100，含 7 组中国学习者难点最小对立对）· 家长可录入自己的句子 |
| **音素级纠正** | 逐词逐音素评分，指出"哪个音读错了、错成了什么"（如 /θ/→/s/），并给出**可执行的口型动作** |
| **语调对比** | 自研 F0 提取 + DTW 对齐，画出母语者与孩子的音高曲线差异，标出最需要改的区段 |
| **情景对话** | 11 个日常场景，LLM 扮演角色；**必须回应孩子上一句**、一次只问一个问题、给出可直接照说的建议回复 |
| **拍照识别连读** | 拍一张书页照片 → **DeepSeek 多模态**识别英文（实测一整页 8/8 句全对）→ 自动切句 → 连读+异步评分。服务端**不保存图片**；照片会临时上传到你配置的 AI 服务。想完全离线可装可选的本地 OCR 兜底 |
| **语音朗读** | AI 回复自动朗读（原生 `<audio>` 兜底，永远可点）· 可调语速 · 可回放自己的录音 |
| **错音本 + SRS** | 错词自动进间隔复习，按遗忘曲线排期 |
| **薄弱音素诊断** | 从历史数据自动聚合出薄弱音素，分 weak/watch/ok 三档，带趋势与关联错误词 |
| **口型动画微课** | 43 个音素的**参数化**侧面剖面动画（舌位/唇形/气流/声带/鼻腔），支持两个音对比高亮差异 |
| **强化练习队列** | 一键筛出含薄弱音素的句子，最小对立对优先 |
| **儿童模式** | 语速放慢、大按钮、语音输入默认展开、**绝不出现 IPA 符号**（有守卫脚本强制）· 每日时长上限 |
| **家长面板** | 孩子练了什么、错在哪、趋势如何（只读） |

## 架构

```
浏览器
  │
  ├── web (Next.js 15 · TS · Tailwind · SQLite)     :3000
  │     页面 / 会话 / 数据 / 儿童模式 / 家长面板
  │
  └── voice (FastAPI · AI 网关)                      :8100
        ├─ 发音评测 PA     Azure Pronunciation Assessment（音素级 + NBest + Prosody）
        ├─ 语音识别 ASR    Azure / faster-whisper（离线兜底）
        ├─ 语音合成 TTS    Azure / Piper（离线兜底）
        ├─ 语调分析        自研 F0(parselmouth) + DTW —— **不依赖任何 provider**
        ├─ 对话 LLM        任意 OpenAI 兼容端点（DeepSeek / Qwen / Ollama / …）
        └─ 缓存            内容寻址参考音 + F0 缓存 + 批量预热
```

**为什么拆成两个服务**：模型密钥只放在 `voice`，浏览器和 `web` 都不持有；
评测/合成这类重活与页面渲染解耦，可以独立重启和降级。网络边界即安全边界。

**为什么语调是自己写的**：F0 提取 + DTW 对齐与"谁给的分"无关，自研之后
**换任何评测 provider 都能保留语调对比能力**，也让评分逻辑可解释、可测试。

## 快速开始

### 方式一：Docker / NAS 部署（推荐）

```bash
git clone https://github.com/ayouwish/english-coach.git
cd english-coach/deploy
cp .env.example .env          # 填入 Azure 与 LLM 的密钥
docker compose up -d
```

详细的 NAS（群晖 / 威联通）部署、HTTPS、备份恢复、升级回滚、故障排查见
**[docs/nas-deployment.md](docs/nas-deployment.md)**；通用部署见 [docs/deployment.md](docs/deployment.md)。

部署后自检：

```bash
./scripts/check-deploy.sh     # 容器健康 / provider 组合 / 示范音 / 评测
```

### 方式二：本地开发

```bash
# 后端
cd voice
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # 不填密钥也能跑：PROVIDER_MODE=mock 全链路离线
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8100

# 前端（另开一个终端）
cd web
pnpm install && pnpm build && pnpm start
```

首次使用建议**预热语料缓存**（Azure 合成新文本较慢，预热后示范音是毫秒级）：

```bash
./scripts/warm-corpus.sh      # 两种语速一起预热，幂等可重跑
```

## 配置

所有密钥都在 `voice/.env`（或 `deploy/.env`），**不要提交**（已在 `.gitignore` 中）。

| 变量 | 作用 |
|---|---|
| `PROVIDER_MODE` | `mock` / `local` / `cloud` / `hybrid`（默认 mock，全链路离线可跑） |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | 发音评测 + 识别 + 合成 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 对话模型（任意 OpenAI 兼容端点；Ollama 无需 key） |
| `VOICE_PA_PROVIDER` | 覆盖评测 provider（`azure` / `local` / `gop`） |
| `VOICE_TTS_PROVIDER` | 覆盖合成 provider（`azure` / `piper`） |

> 镜像体积提示：**默认 OCR 走 LLM 视觉，voice 镜像只比原来多 ~7MB**（pillow，用于图片预处理）。
> 只有需要"完全离线的本地 OCR 兜底"时，才额外装 `requirements-ocr-local.txt`（约 +157MB 镜像 / +165MB 常驻内存）。

> **建议给 Speech 资源用 S0（按量付费）而非 F0（免费层）**：免费层的合成吞吐被限得很死，
> 实测出现过 `RTF=9.84`（合成速度只有实时的 1/10）并直接超时失败。按本项目的用量，
> S0 的聊天合成成本每月不到 1 元。

## 隐私与安全（这是给孩子的应用，所以做得比较较真）

- **麦克风只在明确操作时开启**（点录音 / 点「跟我读」），录完**立即释放**。早期版本为了消除
  "开头丢词"改成常驻复用麦克风，结果 USB 耳麦会切到通话模式、**示范音放不出来**，因此回退了。
- **密钥只存在于 `voice` 进程**；浏览器只与 `web` 通信，`web` 只与 `voice` 通信。
- **儿童绝不接触 IPA 符号**：这不只是"前端不显示"——路由的 RSC 负载、`key` 属性、
  API 响应都做过全量扫描（历史上 IPA 曾通过 `srs_cards.id → hint_key → demo_text` 泄漏三次，
  现在由 `check:child-ipa` 守卫逐页 + 逐 API 扫描，并用变异测试验证守卫本身有效）。
- **儿童内容过滤**：服务端对 LLM 输出再兜一层不当内容过滤，不信任 provider 的自律。
- **数据都在你自己机器上**：SQLite + 录音文件存本地；除调用云 API 的音频外不外传。
- **拍照识别会让图片离开家**：走 DeepSeek 多模态路径时，书页照片会临时上传到所配置的 AI 服务用于识别
  （服务端**不留存**）。在意这一点的话：用「自己输入一段」代替拍照，或装本地 OCR 兜底（`requirements-ocr-local.txt`）。

## 目录结构

```
english-coach/
├── web/                  Next.js 应用（页面 / API / SQLite / 儿童模式 / 家长面板）
│   ├── src/app/          路由与页面
│   ├── src/lib/          业务逻辑（含 articulation.ts：43 音素发音参数表）
│   ├── src/data/         300 句语料 + 场景定义
│   ├── migrations/       数据库迁移（启动时按序执行）
│   └── scripts/          守卫脚本（check:child-ipa 等）
├── voice/                FastAPI AI 网关
│   ├── app/providers/    azure / mock / local / piper / gop（可插拔）
│   ├── app/phonemes.py   canonical-v1 音素符号空间（43 符号）
│   ├── app/warmup.py     参考音与 F0 缓存 + 批量预热
│   └── tests/            496 个单元测试
├── deploy/               docker compose（caddy 为可选 ingress）/ 环境变量模板
├── docs/                 架构 / 契约 / 部署 / 验收 / 成本
├── tests/                契约校验 · 端到端 · 语料审计 · 各 provider 自检
└── scripts/              一键预热（warm-corpus.sh）· 部署自检
```

## 三种运行模式

由 `voice/.env` 的 `PROVIDER_MODE` 决定，**改一个词就能切换**：

| 模式 | 评测 / 识别 / 合成 | 用途 |
|---|---|---|
| `mock` | 全假数据，**零密钥、零网络** | CI、离线开发、验收基线 |
| `local` | 本地 Piper（合成）/ faster-whisper（识别） | 断网或不想花钱；PA 降级为词级 |
| `cloud` | 全 Azure | 只用云 |
| `hybrid` | Azure 优先，**失败自动回落本地再回落 mock** | 默认推荐（云端挂了也不会哑） |

**降级是设计的一部分，不是故障**：调用链保证任何一环挂掉都能返回可用的结果，
并把降级事实写进响应的 `warnings` / `degraded_llm` / `provider` 字段——
**不伪装成正常结果**。前端据此提示"这次是离线话术"，而不是让用户以为模型变笨了。

## 三个账号

首次启动会种入三个演示账号（密码见 `web/README.md`，**部署后请立即修改**）：

| 账号 | 角色 | 特点 |
|---|---|---|
| 爸爸 / 妈妈 | parent | 完整功能 + 家长面板（只读） |
| 女儿 | child | 儿童模式：语速放慢、大按钮、**零 IPA**、每日时长上限 |

## 上手建议

1. **先跑 `mock` 模式**把整条链路走通（不需要任何密钥），再换成 `hybrid`。
2. **接上真实密钥后先预热语料**（`./scripts/warm-corpus.sh`）——这是体验差距最大的一步：
   示范音从"等几秒"变成"毫秒级"。
3. 给孩子用之前，**自己先用成人账号练几句**，看看反馈措辞是否符合预期。
4. 关注 `/report` 页：练够 20 条左右，薄弱音素诊断才有统计意义（样本 <2 的音素不参与）。

## 测试与守卫

这个项目的测试写得比代码多——因为发音评测这种东西"看起来对"和"真的对"差别很大。

```bash
# 后端单元测试
cd voice && .venv/bin/python -m pytest          # 496 passed

# 契约一致性（逐字段校验 voice 的真实响应）
node tests/contract_check.mjs                    # 106 项

# 端到端（真实两个服务，mock 模式）
node tests/e2e_full.mjs

# 前端守卫
cd web
pnpm check:child-ipa        # 儿童可见载荷零 IPA（含 RSC 负载）
pnpm check:phoneme-hints    # 音素提示表覆盖 43 个规范音素
pnpm check:diagnosis        # 薄弱音素诊断 / 微课 / 强化练习
pnpm check:chat-speech      # 对话语音（语速偏好、原生播放器、降级提示）

# 语料审计
python tests/audit_corpus_phonemes.py
```

对外的接口契约冻结在 **[docs/api-contract.md](docs/api-contract.md)**（当前 v1.4），
每个版本变更都记录了对客户端的影响。

## 已知限制（诚实清单）

- **本地发音评测不可行（已用数据证伪）**：实现过完整的 GOP 方案（wav2vec2 音素 CTC +
  CTC Viterbi 强制对齐 + 后验打分），但对照实验显示与 Azure 的相关性
  **Pearson r=0.350 / Spearman ρ=0.360**（<0.4 阈值），"最差 5 个音素"重合仅 1.85/5（随机约 1.4）。
  4 种打分公式都试过，天花板在模型本身（60 语言识别模型、非英语评分模型）。
  **因此评测继续使用 Azure**，本地 GOP 仅作显式实验开关。
- **Docker 镜像未在真实环境构建验证**：开发机 docker 因代理故障无法拉取基础镜像，
  `docker compose config` 通过但**未做过完整部署演练**。
- **浏览器端交互未自动化**：麦克风、自动播放策略、录音时序依赖真实浏览器，
  由使用者在真机验证；无 GUI 环境无法覆盖。
- **`local` / `piper` provider 未在生产使用**（已实现并测试，但默认不走）。
- **拍照识别依赖 LLM 视觉，有网络与延迟成本**：实测一整页（1200×1600 / 8 句）约 **2.9s**、
  ~1600 tokens（每页成本远低于 1 分钱）；短页面 0.7–1.5s。偶发数秒属正常。
  真实书页照片尚未在 NAS 上大量验证（光线不足/大角度倾斜/反光会降低准确率），**识别结果可手动编辑**。
- 音频端点不支持 HTTP Range；家长面板只读；无分布式缓存锁。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构设计与关键取舍（含踩坑记录） |
| [docs/api-contract.md](docs/api-contract.md) | 接口契约 v1.4（冻结） |
| [docs/nas-deployment.md](docs/nas-deployment.md) | NAS 部署完整流程（群晖 / 威联通） |
| [docs/fnos-deployment.md](docs/fnos-deployment.md) | **飞牛 fnOS 部署指南**（端口冲突 / HTTPS 与麦克风 / 国内镜像） |
| [docs/deployment.md](docs/deployment.md) | 通用部署与运维 |
| [docs/verification.md](docs/verification.md) | 验收记录与真实 Azure 联调数据 |
| [docs/hardware-cost.md](docs/hardware-cost.md) | 硬件与成本核算 |

## 贡献

欢迎 issue 与 PR。请先读 [CONTRIBUTING.md](CONTRIBUTING.md)——
特别地，**改动评测或评分逻辑时必须附对照实验数据**，不接受"看起来更准了"。

## 许可证

[MIT](LICENSE) © 2026 ayouwish

> 语料为本项目自行编写；示例中的姓名、邮箱均为虚构占位符。
> 使用前请自行确认所在地区对语音服务与数据存储的合规要求。
