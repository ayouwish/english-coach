# 在 NAS 上部署 english-coach（群晖 DSM / 威联通 QNAP）

> 如果你用的是 **飞牛 fnOS**，请看 [fnos-deployment.md](fnos-deployment.md) ——
> 它的端口与目录约定和群晖/威联通差别较大（自带 Nginx 占 80/443）。

> 版本 v1.0 ｜ 2026-10-25 ｜ 适用 `deploy/docker-compose.yml`（205 行）
> 配套：[部署手册](deployment.md)（通用 + 本机直跑）· [系统设计](architecture.md) · [接口契约](api-contract.md) · [硬件与成本](hardware-cost.md)

面向**群晖 DSM 7.2（Container Manager）**与**威联通 QTS（Container Station）**。
目标是"照着做就能跑起来"，所以每一条命令都标了**是否在本机实测过**。

---

## 0. 先看这个：哪些验证过、哪些没有 ★

这份文档是诚实的，不是营销页。**在 NAS 上真正跑起来之前，请不要把它当"已验证可用"。**

| 项目 | 状态 | 说明 |
|---|---|---|
| `docker compose config` 语法/引用校验 | ✅ **已验证** | 反复执行，exit 0、渲染 170 行 |
| 编排引用的路径（`../web`、`../voice`、`../data`、`./Caddyfile`） | ✅ **已验证**存在 | 见 [deployment.md §10](deployment.md) |
| 自检脚本 `scripts/check-deploy.sh` | ✅ **已实跑** | 在本机对**真实运行中**的 hybrid 服务跑通：11 PASS / 0 FAIL / 4 SKIP，见 §8 |
| voice 端到端（Azure TTS → 音频 → 发音评测 → 分数） | ✅ **已实测** | 真实调用 Azure：`x-tts-provider: azure`、`pron=87.2`、5 个词、音素级 |
| 语料预热命令（`--text-file` / `--items`、幂等） | ✅ **已实测** | 首次 `generated=5` → 复跑 `generated=0/cached=5` |
| SQLite 热备份（`VACUUM INTO`） | ✅ **已实测** | better-sqlite3 13.0.3，备份可独立打开读取 |
| Caddyfile | ✅ **已验证** | 真实 caddy 2.11.7 `validate`，4 组域名组合 |
| **镜像构建（`docker compose build`）** | ❌ **未实测** | 交付本仓库的机器上 docker daemon 配了失效代理，任何 `docker pull` 都失败（[deployment.md §8.0](deployment.md)）。**四个镜像从未真正构建过** |
| **在 NAS 上运行容器** | ❌ **未实测** | 本机没有 NAS 环境 |
| **arm64（ARM 机型）** | ❌ **未实测** | 本机是 x86_64；见 §2.3 的风险说明 |
| **DSM / QNAP 图形界面步骤** | ❌ **未实测** | 按官方文档与社区实践编写（来源见 §10） |

> **结论**：编排、接口、脚本、预热、备份这些"代码层"的东西是实测过的；
> **"镜像能不能在你那台 NAS 上构建成功"是本次交付唯一的大缺口**。
> 所以 §4 的首次启动清单把"先验证构建"单列为第 0 步 —— 别等全家用上了才发现构建不过。

---

## 1. 选哪条拓扑（先做决定，再动手）

| 拓扑 | 长什么样 | 适合 | 代价 |
|---|---|---|---|
| **A. NAS 跑 voice+web，TLS 交给 NAS**（推荐） | 容器只有 voice + web；NAS 自带反向代理 + Let's Encrypt 证书对外提供 HTTPS | 群晖/威联通绝大多数用户 | 需要在 NAS 面板里配一次反向代理 |
| **B. NAS 跑全套（含 Caddy）** | 三个容器都跑，Caddy 占 80/443 并自动签证书 | 80/443 空闲、或用白名单/端口转发 | NAS 的 80/443 常被 DSM/QTS 自己的 Web 服务占用，需先腾出来 |
| **C. 电脑构建，镜像搬到 NAS** | 在 PC 上 `docker build` → `docker save` → NAS `docker load` | NAS 是 ARM、或性能弱（构建 Node/Python 镜像很吃 CPU/内存） | 每次升级都要搬镜像 |

**怎么选：**

- 群晖用户 → **拓扑 A**。群晖的「登录门户 → 反向代理」自带 Let's Encrypt 自动续期，比在 NAS 上再跑一个 Caddy 更省事，也不会和 DSM 抢 80/443。
- 威联通用户 → 也用 **拓扑 A**（Container Station + QTS 反向代理），原理相同。
- 你要用 Caddy 的 internal CA 给局域网签证书（手机/平板都得导根证书）→ **拓扑 B**，并读 [deployment.md §A.2](deployment.md)。
- 你的 NAS 是 ARM 或只有 2 核/2GB → 先看 §7.3，很可能要走**拓扑 C**。

---

## 2. 前置条件

### 2.1 软件与网络

| 项 | 要求 | 怎么确认 |
|---|---|---|
| 容器套件 | 群晖：套件中心装 **Container Manager**（DSM 7.2+）；威联通：**Container Station** | 套件中心搜 Container |
| SSH | 建议开启，命令行比图形界面可靠得多 | 群晖：控制面板 → 终端和 SNMP → 启用 SSH |
| **可出网** | **必须**。所有 AI 能力都在云上 | 见下表 |
| 出网域名（HTTPS/443） | `*.api.cognitive.microsoft.com`、`*.stt.speech.microsoft.com`、`*.tts.speech.microsoft.com`（Azure Speech）；`api.deepseek.com`（LLM） | 在 NAS 上 `curl -sS -o /dev/null -w '%{http_code}\n' https://api.deepseek.com` 应返回 4xx/2xx 而不是超时 |
| 出网域名（拉镜像，仅首次构建） | `registry-1.docker.io` + `production.cloudflare.docker.com`（Docker Hub）或你的镜像加速地址 | `docker pull hello-world` |
| 局域网访问 | 手机/平板要用麦克风**必须 HTTPS**（`getUserMedia` 只在安全上下文可用） | 见 §6 |

> **域名清单是"够用列表"而不是"权威列表"**：Azure SDK 实际会打哪些子域由区域与 SDK 版本决定。
> 如果语音相关功能报网络错，最靠谱的做法是看 voice 容器日志里的具体域名，或在防火墙/路由的连接日志里找被拒的域名。
> 本项目 V1.5 **已用真实 Azure 密钥完成过端到端联调**（见 [verification.md §8](verification.md)），所以只要出网正常，调用链是通的。

### 2.2 磁盘空间估算

| 用途 | 量级 | 依据 |
|---|---|---|
| 基础镜像（node / python / caddy） | 约 **0.4 GB** | 官方镜像标签体积量级 |
| **web 镜像** | 约 **1.2–1.8 GB** | 实测本仓库 `web/node_modules` 517 MB、`.next` 232 MB、`web` 源码（未实测镜像，此为按依赖体积估算） |
| **voice 镜像** | 约 **0.5–0.9 GB** | 依赖含 `av`、`praat-parselmouth`、`numpy`、FastAPI（均带 cp311 manylinux wheel） |
| Docker 构建缓存 | 约 **1–3 GB**（构建后可用 `docker builder prune` 清掉） | 多阶段构建的中间层 |
| `data/`（= 一个共享目录） | `app.db` 几 MB～几百 MB（随练习记录增长）；`audio/` 每次练习几十 KB × 次数；`cache/` **实测约 86 MiB**（300 句 × 2 种语速，Azure WAV） | 本机实测：单条示范音平均 144 KB、参考 F0 平均 3 KB |
| 本地兜底模型（**可选，默认不装**） | 实测 `voice/.local-models` 已有 **888 MB**（含 whisper、Piper 音色、GOP 模型 318 MB） | 决策是**全部走 Azure**，所以默认路径**不需要**这些 |
| 日志 | 每个容器上限 10 MB × 3 个文件（compose 已设） | `deploy/docker-compose.yml` 的 logging 配置 |

**建议预留 10 GB**（构建期峰值）；跑起来之后的稳态占用大约 **3–4 GB 镜像 + 1 GB 以内的 data/**。

### 2.3 CPU 架构：x86_64 vs arm64 ★风险点

| 架构 | 现状 | 说明 |
|---|---|---|
| **x86_64**（Intel/AMD 机型，如群晖 DS923+、威联通 TS-464） | 预期可行，但**未实测** | `node:22-bookworm-slim`、`python:3.11-slim`、`caddy:2-alpine` 都提供 amd64 变体 |
| **arm64**（如群晖 DS223、TS-233 等 ARM 机型） | **未实测，风险明显更高** | 三个官方镜像都有 arm64 变体，但本项目有**原生编译依赖**：web 的 `better-sqlite3`、voice 的 `av` / `praat-parselmouth` / `numpy` 都需要 aarch64 的预编译 wheel。若缺 wheel 就要现场编译（慢且容易失败） |

**ARM 用户请先做这两件事，再决定拓扑：**

```bash
# ① 官方镜像有没有 arm64 变体（有输出 = 有）
docker manifest inspect node:22-bookworm-slim   | grep -c arm64
docker manifest inspect python:3.11-slim        | grep -c arm64
docker manifest inspect caddy:2-alpine          | grep -c arm64

# ② 直接在 NAS 上试构建 voice（最慢但最能说明问题的一步）
cd /volume1/docker/english-coach/deploy
docker compose build voice 2>&1 | tail -30
```

- 如果 voice 构建在编译 `av` / `praat-parselmouth` 时失败：`voice/Dockerfile` 里**已经预留**了安装 FFmpeg 开发库的注释行，
  取消注释后重试；或者在 PC 上按 §7.3 构建好镜像再 `docker load` 到 NAS。
- **不要**为了绕过构建问题去装本地模型：本项目默认**全部走 Azure**（见 §2.4），
  **不需要** `voice/.local-models`，也就不需要 aarch64 的 onnxruntime/piper wheel。

### 2.4 内存建议

| 组合 | 建议可用内存 | 理由 |
|---|---|---|
| **全 Azure + DeepSeek（本项目采用的组合）** | **≥ 2 GB** | voice 不加载任何本地模型（惰性导入），web 是 Next.js standalone；compose 里 voice 限 8g、web 限 2g 是**上限**不是需求 |
| 要开本地兜底（Piper / faster-whisper / GOP） | ≥ 4 GB，建议 8 GB | whisper small.en + Piper + GOP 会显著吃内存 |
| 想开 `--profile local-llm`（Ollama 7B） | ≥ 8 GB 且不推荐 | 7B 模型常驻内存，CPU 推理一轮 30–60 s |

> 上面是**估算**（NAS 上未实测）。compose 的内存上限已经写好，容器超限会被 OOM 杀掉 —— 遇到 `Exited (137)` 就是它，排查见 [deployment.md §8.4](deployment.md)。

**当前采用的 provider 组合**（2026-10-25 决定，实测运行中）：

```
asr=azure   pa=azure   tts=azure   llm=deepseek（远程）
```

对应 `.env` 就是 `PROVIDER_MODE=hybrid` + Azure 密钥 + DeepSeek 密钥。
本地 `piper`/`local`/`gop` 全部保留但**不在默认路径上**，只作断网兜底与实验开关
（`gop` 经对照实验判定质量不达标，默认关闭；详见 [voice/README.md](../voice/README.md) §15）。

---

## 3. 目录、卷与权限（NAS 上最容易翻车的一段）★

### 3.1 目录布局

compose 里的挂载关系（`deploy/docker-compose.yml`）：

```
<你在 NAS 上的项目目录>           例：/volume1/docker/english-coach
├── deploy/
│   ├── docker-compose.yml
│   ├── Caddyfile
│   ├── .env                      ← 你创建的，唯一的配置来源（含密钥，权限设 600）
│   └── .env.example              ← 模板，占位符，可提交
├── data/                         ← ★ 挂进两个容器：web 和 voice 都用它
│   ├── app.db  app.db-wal  app.db-shm     SQLite：账号 / 练习 / 错音本 / SRS
│   ├── audio/<user_id>/<年月>/<id>.webm   孩子的练习录音（敏感，需备份）
│   └── cache/audio|f0/                    示范音 + 参考 F0（可删、可重生成）
├── web/  voice/  docs/  scripts/  …        代码（构建上下文）
```

**要点**：

1. **只有一个 `data/`**，web 与 voice 共用（compose 把 `../data` 同时挂到两个容器的 `/data`）。
   所以**备份就是打包一个目录**，别被"web/data、voice/data"误导 ——
   那是**本机直跑**（非容器）时的路径，不是 compose 的路径。
2. `data/` 在仓库**外面一层**（compose 里写的是 `../data`）。所以 compose 文件必须在 `deploy/` 里执行，
   或者用 `-f deploy/docker-compose.yml` 并保持工作目录语义一致。
3. `cache/` 里有 140 MB 上下是常态（实测 600 条 ≈ 86 MiB），**它不是"垃圾"**：
   删了会退化成"每次跟读都现合成"。详见 §5。

### 3.2 权限：为什么大概率需要 `chown 1000:1000`

这是 NAS 部署的第一号坑，原因很具体：

| 容器 | 以谁的身份跑 | 依据 |
|---|---|---|
| **web** | **`node` 用户（uid 1000）** | `web/Dockerfile` 结尾有 `USER node`；`node` 的 uid=1000 是官方 `node:*` 镜像的固定约定 |
| voice | root（没有 `USER` 指令） | `voice/Dockerfile` 全文没有 `USER` |
| caddy | 镜像默认用户 | 官方 `caddy:2-alpine` 镜像 |

> 想自己确认 uid（本机无法拉镜像，所以这一步没在本仓库的交付环境里跑过）：
> ```bash
> docker run --rm node:22-bookworm-slim id     # 期望 uid=1000(node) gid=1000(node)
> docker run --rm python:3.11-slim id          # 期望 uid=0(root)
> ```

**后果**：`data/` 是你在 NAS 上创建的，属主通常是你自己（群晖常见 `PUID=1026, PGID=100`）。
web 容器以 **uid 1000** 去写 `/data`（要建 `app.db`、写录音）→ **权限拒绝 → 数据库开不了 → 页面报错或 /api/health 里 `db.ok=false`**。

**修法（推荐，一条命令）**：

```bash
# 群晖/威联通都适用：把 data/ 交给 uid 1000（web 容器的身份）
sudo mkdir -p /volume1/docker/english-coach/data
sudo chown -R 1000:1000 /volume1/docker/english-coach/data
sudo chmod 755 /volume1/docker/english-coach/data
```

**为什么不是改成你自己的 PUID**：容器里的身份是**镜像写死的** uid 1000，不是 NAS 用户。
（你可以反过来改 compose 给 web 加 `user: "1026:100"`，但那要求该 uid 对 `voice-models` 卷也有写权限，
容易在下一处再踩坑。**统一用 1000 是最省心的做法。**）

**自检**（`scripts/check-deploy.sh` 会替你做这一项）：

```bash
# 容器起来之后，确认 web 真的能写
docker compose -f /volume1/docker/english-coach/deploy/docker-compose.yml exec -T web sh -c 'test -w /data && echo "可写 OK" || echo "不可写 FAIL"'
```

`.env` 的权限也顺手收紧（里面有 Azure 与 DeepSeek 的密钥）：

```bash
chmod 600 /volume1/docker/english-coach/deploy/.env
```

> **关于 `PUID`/`PGID` 环境变量**：很多 NAS 镜像（linuxserver 系）支持 `PUID`/`PGID`，
> 但**本项目的镜像不支持**（Dockerfile 里没有相关逻辑）。所以别指望填了 `PUID=1026` 就好 —— 用 `chown 1000:1000`。
> 群晖的 `PUID=1026, PGID=100` 说法见社区文档（§10 来源），**与本项目无关，仅用于理解 NAS 上的属主惯例**。

### 3.3 命名卷（不用管，但知道它们在哪儿）

| 卷 | 挂到 | 内容 | 能删吗 |
|---|---|---|---|
| `english-coach_voice-models` | voice 的 `/models` | 本地模型下载缓存 | 能（默认全 Azure 时基本是空的） |
| `english-coach_caddy-data` | caddy 的 `/data` | internal CA 私钥与证书 | 能，但要重新给设备导证书 |
| `english-coach_caddy-config` | caddy 的 `/config` | Caddy 自动生成的配置 | 能 |
| `english-coach_ollama-models` | ollama 的 `/root/.ollama` | 本地 LLM | 能（不用 local-llm profile 时不存在） |

这些卷由 docker 管理，通常在 `/volume1/@docker/volumes/`（群晖）。
**它们都不需要备份**（可重建），唯一必须备份的是 `data/` 与 `deploy/.env`。

---

## 4. 首次启动清单（照着打勾）

> 建议全程用 SSH。图形界面（Container Manager 的"项目"）也能做，见 §4.4。

### 4.0 第 0 步：先验证"能构建"（★ 别跳过）

镜像从未在本仓库交付的环境中构建过，所以**先把最慢、最可能失败的一步单独跑掉**：

```bash
# 拉基础镜像（构建的前提；这一步失败通常是 NAS 的出网/镜像源问题）
docker pull node:22-bookworm-slim
docker pull python:3.11-slim
docker pull caddy:2-alpine

# 只构建 voice（依赖最重、最容易在 ARM 上出问题）
cd /volume1/docker/english-coach/deploy
docker compose build voice
```

- ✅ 成功 → 继续 §4.1。
- ❌ 失败在 `av` / `praat-parselmouth` 编译 → ARM 缺 wheel，见 §2.3 与 §7.3。
- ❌ 失败在拉基础镜像 → 配 NAS 的 Docker 镜像加速（群晖：Container Manager → 注册表 → 设置 → 启用镜像加速），或走 §7.3。

### 4.1 放代码与建目录

```bash
sudo mkdir -p /volume1/docker/english-coach
cd /volume1/docker/english-coach

# 方式一：git（推荐，升级方便）
sudo git clone https://github.com/ayouwish/english-coach.git .

# 方式二：从电脑 rsync（NAS 拉不到 GitHub / 还没推远端时）
# 在你自己的电脑上执行：
#   rsync -av --exclude node_modules --exclude .next --exclude .venv \
#         --exclude .local-models --exclude .model-cache \
#         ./english-coach/  admin@<NAS-IP>:/volume1/docker/english-coach/

sudo mkdir -p data
sudo chown -R 1000:1000 data          # ★ 见 §3.2
```

> **千万不要**把电脑上的 `web/node_modules`、`web/.next`、`voice/.venv`、`voice/.local-models` 一起 rsync 过去：
> 那是宿主机产物，容器里不用，还会白白占几个 GB、甚至在 ARM 上带来错误架构的二进制。

### 4.2 写 `.env`

```bash
cd /volume1/docker/english-coach/deploy
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

必须确认的几项（详细注释在 `.env.example` 里，逐项都写了默认值与是否必填）：

```ini
# ── 决定 AI 能力（本项目采用的组合）──
PROVIDER_MODE=hybrid                   # 云为主 + 本地兜底
AZURE_SPEECH_KEY=<你的 Azure 语音密钥>   # 必填（云评测/TTS）
AZURE_SPEECH_REGION=eastasia           # 你的资源区域
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=<你的 DeepSeek 密钥>
LLM_MODEL=deepseek-flash

# ── 决定访问方式与 TLS ──
SITE_ADDRESS=<NAS 的局域网 IP>          # 拓扑 A 用 IP 或局域网域名；拓扑 B 必须与证书 SAN 一致
TLS_CERT_MODE=internal                 # 拓扑 B 用 internal；拓扑 A（NAS 反代）这个值用不到

# ── web 侧 ──
COOKIE_SECURE=1                        # ★ 拓扑 A（反代已 HTTPS）设 1；纯内网 http 直连设 0
BOOTSTRAP_DAD_EMAIL=...
BOOTSTRAP_DAD_PASSWORD=...             # ★ 一定要改掉示例密码
BOOTSTRAP_MOM_EMAIL=...
BOOTSTRAP_MOM_PASSWORD=...
BOOTSTRAP_CHILD_EMAIL=...
BOOTSTRAP_CHILD_PASSWORD=...
```

> **`.env` 里绝不能出现别人的真实密钥**。`.env.example` 里只有占位符，可以放心提交。
> 你自己的 `.env` 不要提交（`.gitignore` 已忽略）。

### 4.3 启动（按拓扑选一条）

**拓扑 A：只起 voice + web，TLS 交给 NAS 反向代理**

```bash
cd /volume1/docker/english-coach/deploy
docker compose up -d voice web          # 故意不启动 caddy
docker compose ps                        # 两个容器都应是 Up (healthy)
curl -s localhost:8100/v1/health | head -c 120; echo
curl -s localhost:3000/api/health | head -c 200; echo
```

**拓扑 B：全套（含 Caddy）——先确认 80/443 是空的**

```bash
ss -lntp | grep -E ':(80|443)\b'        # 有输出说明被 DSM/QTS 占用了
cd /volume1/docker/english-coach/deploy
docker compose up -d --build
docker compose ps
```

若 80/443 被群晖占用：控制面板 → 登录门户 → 把 DSM 的 HTTP/HTTPS 端口改到 5000/5001（默认本来也是），
或直接改用拓扑 A。

### 4.4 （可选）用图形界面做同样的事

**群晖 DSM 7.2**：

1. 套件中心安装 **Container Manager**；
2. **项目 → 新增 → Docker Compose**；
3. 把 `deploy/docker-compose.yml` 的内容粘进去（项目目录选 `/volume1/docker/english-coach/deploy`，
   这样 `../data`、`./Caddyfile` 这些相对路径才有正确含义）；
4. 下一步 → 完成。

> ⚠️ 图形界面的"项目"**不会**帮你 `chown data/`，也不会帮你写 `.env`（`.env` 仍要自己放到 `deploy/` 下）。
> 这两件事做完再点"构建"。图形界面步骤**未在真机验证**（来源见 §10）。

**威联通 QTS**：

1. App Center 安装 **Container Station**；
2. **应用程序 → 创建 → 从 YAML 创建**，粘贴同一份 compose；
3. 同理先建好 `data/` 并 `chown 1000:1000`，`.env` 放到 compose 同目录。**未在真机验证。**

### 4.5 建三个账号

**机制**：web 进程**第一次收到请求时**自动建表（幂等，`_migrations` 记账），
并且 **`users` 表为空时**按 `.env` 的 `BOOTSTRAP_*` 灌三个种子账号。**不需要跑任何命令。**

```bash
curl -s localhost:3000/api/health >/dev/null     # 触发首次初始化
docker compose logs web | grep -i -E 'migrat|seed|user' | tail -5

# 验证三个账号落库（web 镜像里有 better-sqlite3）
docker compose exec -T web node -e "
const db=require('better-sqlite3')('/data/app.db');
console.table(db.prepare('select email,role,age_band,daily_limit_minutes from users').all());
"
```

期望三行：dad(parent/adult)、mom(parent/adult)、girl(child/child, 20 分钟)。
关闭自动灌种子用 `AUTO_SEED=0`；手动跑用 `docker compose exec -T web node scripts/seed.mjs`。

### 4.6 预热语料（★ 做了这一步体验才成立）

**为什么**：Azure 合成新文本**慢且波动大** —— 早期实测 **1–11 秒**（服务端出现过 `RTF=9.84` 的合成超时）；
**升到 S0 之后**：全新文本 `normal` 中位 ≈1.8 s、`slow` 中位 ≈4.2 s（项目 Lead 实测）。
把 300 句语料提前合成进本地缓存后，「只听示范」/「跟我读」降到 **12–22 ms**
（[voice/README.md](../voice/README.md) §15.2）。而且**每条语料的云 TTS 只花一次钱** ——
不预热的话，同一条语料每被跟读一次就再合成一次。

**两种语速都要预热**：`normal`（成人示范音 + `pronounce` 参考音分析）、`slow`（**儿童模式默认慢速**）。
只预热 normal 的话，孩子那边每次仍然要现合成。

NAS 上**推荐全程用容器**（NAS 的 Python 环境不适合装 voice 的依赖）：

```bash
cd /volume1/docker/english-coach/deploy

# ① 生成语料清单：web 容器里有 src/data/sentences.json，也自带 node
docker compose exec -T web node -e \
  'const d=require("/app/src/data/sentences.json");process.stdout.write((d.sentences||d).map(s=>s.text).join("\n"))' \
  > ../data/warmup-corpus.txt
wc -l ../data/warmup-corpus.txt        # 期望 300（文件末行无换行时 wc 显示 299，正常）

# ② 预热两种语速（voice 镜像里已包含 scripts/warmup.py）
docker compose exec -T voice python scripts/warmup.py \
  --text-file /data/warmup-corpus.txt --url http://127.0.0.1:8100 --rate normal --concurrency 3
docker compose exec -T voice python scripts/warmup.py \
  --text-file /data/warmup-corpus.txt --url http://127.0.0.1:8100 --rate slow   --concurrency 3
```

**预期输出（幂等）**：

| 第几次 | `generated` | `cached` | `failed` |
|---|---|---|---|
| 第一次 | = 语料条数 | 0 | `0` |
| 再跑一次 | **0** | = 语料条数 | `0` |

`requested = generated + cached + failed + skipped_duplicates` 必须自洽（契约 v1.4 §12.4）。

> **本仓库还有一键脚本** `scripts/warm-corpus.sh`（自动生成清单 + 两种语速 + 幂等，已实测跑通：
> mock 下 300 条 ×2 语速约 30 s/轮、退出码 0）。
> 但它依赖**宿主机**的 `voice/.venv/bin/python`，所以**在 NAS 上不适用**；
> 它是给开发机/本机直跑用的（见 [deployment.md §6.2](deployment.md)）。
>
> **耗时预期**：mock（本机）每 300 条约 30 秒；**换成 Azure 会慢得多**（受云 TTS 影响），
> 首次全量预热 600 条建议预留 **5–15 分钟**，并发保持 2–3。中途断了不要紧 —— 重跑只补缺失项。

**验证预热生效**：做一次跟读，看响应里的
`provider_meta.cache.reference_audio == "hit"`；或直接看缓存目录：

```bash
docker compose exec -T voice sh -c 'du -sh /data/cache && find /data/cache/audio -type f | wc -l'
```

### 4.7 跑一次自检

```bash
cd /volume1/docker/english-coach

# 拓扑 A（没有 caddy 容器）
EXPECT_SERVICES="voice web" EXTERNAL_URL=https://<你的访问域名或IP> ./scripts/check-deploy.sh

# 拓扑 B（含 caddy）
./scripts/check-deploy.sh
```

脚本会逐项真断言，并在失败时给可操作提示；当前环境验证不了的项目会明确 SKIP。
详见 §8。

---

## 5. 缓存管理（哪些能删、哪些不能）

| 路径 | 是什么 | 能删吗 | 备份 |
|---|---|---|---|
| `data/app.db`（+ `-wal`/`-shm`） | 账号、练习记录、音素掌握度、SRS 排期 | **绝不能删** | ✅ **必须** |
| `data/audio/` | 孩子的**练习录音**（敏感） | 删了就没了 | ✅ 建议 |
| `data/cache/audio/`、`data/cache/f0/` | 示范音（TTS 产物）+ 参考 F0 曲线 | ✅ **随时可删**，删了重跑预热即可 | ❌ 不必需（可再生，且体积不小） |
| `data/warmup-corpus.txt` | 预热用的临时清单 | ✅ 可删 | ❌ |

**缓存体积实测**：

- 本机实测（Azure TTS，WAV 24 kHz）：`cache/audio` 955 个文件 134 MB，平均 **144 KB/条**；
  `cache/f0` 911 个文件 2.4 MB，平均 **3 KB/条**。
- 折算满语料：**300 句 × 2 种语速 = 600 条 ≈ 86 MiB**。
- 上限由 `CACHE_MAX_BYTES`（默认 500 MB）与 `CACHE_MAX_ENTRIES`（默认 2000）控制，超出按 LRU（mtime 从旧到新）淘汰。

**缓存键是 `v3` 且含 provider 与格式**（契约 v1.4 §12.2）：

```
sha1("v3" + "\x1f" + tts_provider + "\x1f" + fmt + "\x1f" + text + "\x1f" + voice + "\x1f" + rate)
```

意思是：**换了 TTS provider、换了音频格式（mp3/wav）、换了音色、换了语速、改了句子文本 —— 旧缓存都不会命中**，
需要重新预热。这**不是故障**，是有意设计（避免把 mock/本地合成音当成 Azure 母语者示范复用，见 [verification.md §7.4](verification.md)）。

```bash
# 看缓存现状
docker compose exec -T voice sh -c 'du -sh /data/cache; find /data/cache/audio -type f | wc -l'

# 清空（安全：只影响示范音，练习记录与分数都在 app.db 里）
docker compose exec -T voice sh -c 'rm -rf /data/cache/audio/* /data/cache/f0/*'
# 然后重跑 §4.6 的预热
```

---

## 6. 网络与 HTTPS

### 6.1 端口一览

| 容器 | 容器内 | 发布到宿主 | 谁需要访问它 |
|---|---|---|---|
| voice | 8100 | `127.0.0.1:8100`（**仅本机回环**） | web 容器（走服务名 `voice:8100`）；你调试时 |
| web | 3000 | `127.0.0.1:3000`（**仅本机回环**） | NAS 的反向代理（就在宿主机上，所以能访问回环）；你调试时 |
| caddy（拓扑 B） | 80/443 | `0.0.0.0:80/443`（+443/udp） | 局域网浏览器 |

**voice/web 故意只绑 `127.0.0.1`**：这样局域网里没人能绕过 TLS 直接戳 AI 网关。
所以拓扑 A 里，反向代理**必须**指向 `http://127.0.0.1:3000`（而不是容器的内网 IP）—— DSM/QNAP 的反向代理运行在宿主机上，能访问。

### 6.2 拓扑 A：群晖反向代理 + Let's Encrypt

**群晖 DSM**（**界面步骤未在真机验证**，路径依据 DSM 7.x 官方文档）：

1. **控制面板 → 登录门户 → 高级 → 反向代理 → 新增**；
2. 来源：`协议=HTTPS`，`主机名=<你的域名或 DDNS 名>`，`端口=443`；
3. 目标：`协议=HTTP`，`主机名=localhost`，`端口=3000`；
4. **控制面板 → 安全性 → 证书 → 新增证书 → 从 Let's Encrypt 获取**，域名填同一个域名，然后把它指定给上面那条反向代理规则；
5. 路由器上把 **443** 转发到 NAS（**只在你确实要从公网访问时才做**，且请先读 §6.4）。

**威联通 QTS**：控制台 → 应用程序 → **反向代理** → 新增，原理相同（来源 https:443 → 目标 `localhost:3000`），
证书在「控制台 → 安全性 → SSL 证书」里申请。**未在真机验证。**

**验证**：

```bash
curl -sI https://<你的域名>/healthz | head -1        # 期望 200
EXTERNAL_URL=https://<你的域名> ./scripts/check-deploy.sh
```

### 6.3 为什么必须 HTTPS（不是"最好有"）

浏览器的录音 API `navigator.mediaDevices.getUserMedia()` **只在安全上下文里存在**，
而安全上下文只有两种：`https://` 开头的源，或 `http://localhost`（浏览器对"本机"的唯一特例）。

所以在 `http://192.168.1.50:3000` 这类地址上，`navigator.mediaDevices` 是 `undefined`：
点"开始录音"**不会有权限弹窗**，只会静默失败。**平板上没有 localhost 特例**，所以给孩子的设备必须走 HTTPS。

> 拓扑 A 由 NAS 的反向代理提供 HTTPS，**不需要**在设备上装任何根证书（Let's Encrypt 是公信 CA）。
> 拓扑 B 用 Caddy 的 internal CA，则**每台设备都要导入根证书** —— 步骤见 [deployment.md §A.2](deployment.md)。

浏览器里自查（这是唯一可信的判断）：

```js
// 在页面 Console 里跑
[window.isSecureContext, typeof navigator.mediaDevices]   // 期望 [true, 'object']
```

### 6.4 ★ 别把这个应用裸奔在公网

这是**给孩子用的应用**：里面有三个人的账号、孩子的练习录音、以及家长面板。
把它直接暴露到公网（端口转发 + 一个弱密码）是不可接受的。按下面的顺序做取舍：

| 做法 | 安全性 | 建议 |
|---|---|---|
| **只在局域网用**（不转发任何端口） | 高 | ✅ **推荐**。家里用完全够：手机/平板连家里 Wi-Fi 即可 |
| 局域网 + **出差时用 VPN 回连**（群晖 VPN Server / WireGuard / Tailscale） | 高 | ✅ **要外网访问就选这个** |
| 公网 + 反向代理 + Let's Encrypt + **强密码** | 中 | ⚠️ 可以，但要知道自己在暴露什么：至少要 ① 改掉所有示例密码 ② 关掉注册/自助改密 ③ 开启登录失败限制 ④ 只开 443，不开 3000/8100 |
| 公网 + 直接映射 3000/8100 | 极低 | ❌ **绝对不要**。这既绕过 TLS（麦克风不可用），又把 AI 网关裸奔（等于送人一个免费 Azure 额度） |

**几条硬规则**：

1. **`3000` / `8100` 永远不要映射到公网**（compose 已经把它们绑在 `127.0.0.1`，别改）。
2. 用 DDNS 域名时，**别用容易被猜到的子域**，并在反向代理上启用访问控制（群晖反向代理支持"访问控制配置文件"）。
3. `.env` 里的 `AZURE_SPEECH_KEY` / `LLM_API_KEY` 是**真金白银**：`.env` 权限 600，不要提交，不要贴群里。
4. 家长面板 `/parent` 只有 `role=parent` 能进（服务端已强制，`verification.md` 有验证记录），
   但**账号安全仍然是你的责任**：用强密码，别三家共用同一个。
5. 定期升级（§7）—— 里面有安全修复。

---

## 7. 备份、恢复、升级

### 7.1 备份（SQLite 不能直接 `cp`）

**为什么不能 `cp`**：SQLite 打开 WAL 模式后，数据分散在 `app.db`、`app.db-wal`、`app.db-shm` 三个文件里，
运行中直接拷 `app.db` 很可能拿到**不自洽的快照**（甚至一个打不开的库）。

**方式一：停容器再拷（最简单、永远正确）**

```bash
cd /volume1/docker/english-coach
docker compose -f deploy/docker-compose.yml stop web          # 只停 web（唯一的写入方）
sudo tar czf /volume1/backup/english-coach-$(date +%F).tar.gz \
     data deploy/.env
docker compose -f deploy/docker-compose.yml start web
```

**方式二：不停机热备份（推荐日常用）**

web 镜像里**没有 `sqlite3` 命令行**，但有 `better-sqlite3`。用 SQLite 自己的 `VACUUM INTO` 生成一致快照：

```bash
cd /volume1/docker/english-coach
docker compose -f deploy/docker-compose.yml exec -T web node -e "
const Database=require('better-sqlite3');
const db=new Database('/data/app.db');
db.exec(\"VACUUM INTO '/data/backup-' + Date.now() + '.db'\");
console.log('备份完成');
"
ls -lh data/backup-*.db          # 确认生成了非空文件
```

> 这两条 SQL 语义的命令**已在本机用 better-sqlite3 13.0.3 实测**（`VACUUM INTO` 生成的库可独立打开并读到数据）。
> `docker compose exec` 的包装形式未在容器里验证过（本机无法构建镜像），但命令主体是验证过的。

**备份内容清单**：

| 要备份 | 不要备份 |
|---|---|
| `data/app.db*`（或 `VACUUM INTO` 的快照） | `node_modules` / `.next` / `.venv` / `.local-models` |
| `data/audio/`（孩子的录音） | `data/cache/`（可再生，还占 ~86 MiB+） |
| `deploy/.env`（密钥，丢了要重配） | docker 命名卷（可重建） |

**群晖**：也可以用 **Hyper Backup** 备份 `/volume1/docker/english-coach/data`（配合方式一停容器更稳）。
**快照复制（Snapshot Replication）**对 Btrfs 卷有效，但它不能替代"一致性备份"，别把它当唯一手段。

### 7.2 恢复

```bash
cd /volume1/docker/english-coach
docker compose -f deploy/docker-compose.yml down          # 停全部（不动卷）
sudo mv data data.broken-$(date +%F)                      # 先留现场，别直接删
sudo tar xzf /volume1/backup/english-coach-2026-10-25.tar.gz   # 还原出 data/ 与 deploy/.env
sudo chown -R 1000:1000 data                              # ★ 别忘了这一步（见 §3.2）
docker compose -f deploy/docker-compose.yml up -d voice web
./scripts/check-deploy.sh
```

### 7.3 升级与回滚

**升级**（迁移**自动跑**，不需要手工执行 SQL）：

```bash
cd /volume1/docker/english-coach
# ① 先备份（§7.1）
# ② 取新代码
sudo git pull
# ③ 重建并启动
cd deploy && docker compose build && docker compose up -d voice web
docker compose ps
```

web 在**第一次收到请求时**幂等执行 `migrations/*.sql`（`_migrations` 表记账，
所以重复启动/多实例都安全）。数据库文件在 `data/app.db`，**不在镜像里**，所以重建镜像不会丢数据。
`MIGRATIONS_DIR` 默认指向镜像内的 `/app/migrations`，一般不用改。

**回滚**：

```bash
# 保留旧镜像再升级，回滚就只是切标签 + 重建容器
docker tag english-coach-web:0.1.0 english-coach-web:previous
docker tag english-coach-voice:0.1.0 english-coach-voice:previous
# ……升级之后发现问题……
cd /volume1/docker/english-coach && sudo git checkout <上一个提交>
cd deploy && docker compose build && docker compose up -d voice web
```

- **代码回滚**：`git checkout` 到上一个提交后重建即可。
- **数据回滚**：只有做了 §7.1 的备份才可能。**迁移通常只增不减**，所以"降级代码 + 新数据库"可能有兼容问题 ——
  真要回滚数据就得停容器 → 换回备份的 `data/` → 起容器。
- **缓存失效是正常的**：跨版本升级后若 `cache key` 版本变了（`v2`→`v3`），旧缓存全部不命中，
  重新跑一次预热即可（§4.6），**不是故障**。

**拓扑 C（在电脑上构建镜像再搬过去）**：

```bash
# 在 x86_64 电脑上（与 NAS 同架构时）
cd english-coach/deploy
docker compose build
docker save english-coach-web:0.1.0 english-coach-voice:0.1.0 -o ec-images.tar
# 传到 NAS
scp ec-images.tar admin@<NAS-IP>:/volume1/docker/
# NAS 上
ssh admin@<NAS-IP>
cd /volume1/docker && docker load -i ec-images.tar
```

> ⚠️ 跨架构不行：x86_64 上构建的镜像**不能**在 arm64 NAS 上跑。ARM NAS 要在同架构的机器上构建，
> 或者直接用 `docker buildx build --platform linux/arm64`（需要 buildx 与 QEMU，未验证）。

---

## 8. 部署自检脚本

```bash
cd /volume1/docker/english-coach
./scripts/check-deploy.sh                          # 拓扑 B（含 caddy）
EXPECT_SERVICES="voice web" EXTERNAL_URL=https://coach.example.com ./scripts/check-deploy.sh   # 拓扑 A
```

**它检查什么**（每项都是真断言，失败会给可操作提示）：

1. `deploy/docker-compose.yml` 存在 + `docker compose config` 通过 + 构建上下文存在
2. 容器是否在跑、healthcheck 是否 healthy（无容器时退化为"主机直跑"模式）
3. voice `/v1/health` 与 web `/api/health`（含 `db.ok` 与 `voice.reachable`）
4. **provider 组合**是否符合预期（按 `PROVIDER_MODE` 推导，可用 `EXPECT_PROVIDERS` 覆盖；`hybrid/cloud` 下还要求 `llm != template`）
5. **示范音真的能出音频**（POST `/v1/tts`，断言 HTTP 200 + `Content-Type: audio/*` + 字节数 > 1000，并打印 `X-Cache` 等观测头）
6. **评测真的能出分数**（把上一步拿到的音频喂给 POST `/v1/pronounce`，断言 `scores.pron` 是 0–100 的数）
7. 数据目录可写 + **容器内 `/data` 是否可写**（NAS 权限坑）+ 磁盘余量（<2 GB 报失败）
8. 缓存覆盖度（不足只 WARN，不阻断）
9. HTTPS（拓扑 A 用 `EXTERNAL_URL`；拓扑 B 用 `SITE_ADDRESS`）
10. 镜像构建：**本机验证不了时明确 SKIP 并说明原因**，不假装通过

**本机实跑结果**（2026-10-25，对着真实运行中的 hybrid 服务）：

```
── 1. 编排文件 / compose 配置 ──   PASS docker compose config 校验通过
                                   PASS 构建上下文存在：../web ｜ ../voice
── 2. 容器状态 ──                  SKIP 没有在跑的 compose 容器 → 按主机直跑模式继续
── 3. 两个健康端点 ──              PASS voice /v1/health status=ok  mode=hybrid providers=asr=azure,llm=deepseek,pa=azure,tts=azure
                                   PASS web /api/health ok 且数据库可用
                                   PASS web → voice 连通
── 4. provider 组合 ──             PASS 符合预期（mode=hybrid）· PASS LLM 可用 llm=deepseek
── 5. 示范音 ──                    PASS POST /v1/tts  provider=azure cache=hit bytes=163246 type=audio/wav
── 6. 评测 ──                      PASS POST /v1/pronounce  granularity=phoneme pron=87.2 acc=96.0 flu=75.0 comp=100.0 words=5
── 7. 数据目录与磁盘 ──            SKIP data/ 尚不存在（首次 up 时创建）
── 8. 参考音缓存 ──                PASS audio=955（目标 ≥600）f0=911 体积=140M
── 9. HTTPS ──                     SKIP 没有 caddy 容器（主机直跑用 http://localhost）
── 10. 镜像构建 ──                 SKIP 尚未构建过镜像（该项目交付时此项未经实测）
── 汇总 ──  PASS 11   FAIL 0   WARN 0   SKIP 4    退出码 0
```

**脚本本身也做过变异测试**（确认断言不是装饰）：把 voice 地址指到一个死端口 → `FAIL voice .../v1/health`、退出码 2；
把 `EXPECT_PROVIDERS` 故意写成 `local/local/piper` → `FAIL provider 组合`，并列出 `asr: 期望 local / 实际 azure` 等逐项差异、退出码 1。

`bash -n scripts/check-deploy.sh` 通过。本机**没有 shellcheck**，所以未做 shellcheck 检查。

---

## 9. 故障排查（NAS 专属）

先跑 `./scripts/check-deploy.sh`，它会把问题定位到具体一项。下面是 NAS 上最常见的几种。

| 症状 | 最可能的原因 | 怎么修 |
|---|---|---|
| 容器起不来：`port is already allocated` | 80/443 被 DSM/QTS 占用（拓扑 B） | `ss -lntp \| grep -E ':(80\|443)\b'`；改用拓扑 A（`docker compose up -d voice web`）或把 DSM 的 Web 端口挪走 |
| web 日志：`unable to open database file` / `SQLITE_CANTOPEN` / `EACCES` | **`data/` 属主不对**（web 是 uid 1000） | `sudo chown -R 1000:1000 data` 然后 `docker compose restart web`（§3.2） |
| `/api/health` 里 `db.ok=false` | 同上 | 同上；自检脚本第 7 项会直接报出来 |
| 容器 `Exited (137)` | 内存超限被 OOM 杀 | 关掉本地兜底模型/`local-llm` profile；或把 compose 里 voice 的 `memory: 8g` 调小到机器能承受的值 |
| 语音不可达（`voice 502` / `web 报告 voice 不可达`） | voice 还在冷启动；或 `VOICE_SERVICE_URL` 被改错 | `docker compose logs --tail=50 voice`；确认 web 的 `VOICE_SERVICE_URL=http://voice:8100`（服务名，不是 127.0.0.1） |
| 评测报 401 / `provider_error`（认证失败） | `AZURE_SPEECH_KEY` 或 `AZURE_SPEECH_REGION` 不对 | 用 `voice/.env.example` 的注释核对；注意**行内注释会被吃掉**这个坑已在实现里修掉，但**别把注释写在值后面**；改完 `docker compose up -d --force-recreate voice` |
| LLM 反馈变成"模板" | `LLM_API_KEY` 没配/失效/余额不足 | `curl -s localhost:8100/v1/health` 看 `providers.llm`；期望 `deepseek` 而不是 `template` |
| 跟读第一次很慢（2–10 秒）、之后很快 | **缓存没预热**（或刚清过缓存） | 跑 §4.6 的预热；这是本项目最值得做的运维动作 |
| 换了 provider/音色/语速后，缓存全部 miss | **正常**：缓存键含 `tts_provider` 与 `fmt`（v3） | 重新预热一次即可（§5） |
| 磁盘满（`no space left on device`） | 构建缓存 + 镜像 + 日志 + 缓存目录 | `docker system df` 看占用；`docker builder prune -f`（构建缓存，通常最大）；`docker image prune -f`；确认 `data/cache` 没被异常放大；日志上限 compose 已设 |
| ARM 上构建失败（编译 `av`/`praat-parselmouth`/`better-sqlite3`） | 缺 aarch64 wheel | 见 §2.3；或取消 `voice/Dockerfile` 里 FFmpeg 开发库那一行的注释；或走 §7.3 拓扑 C |
| 手机/平板打开能进页面，但点录音没反应 | **不是安全上下文**（用了 http，或证书不受信） | 在 Console 跑 `[isSecureContext, typeof navigator.mediaDevices]`；期望 `[true,'object']`。拓扑 A 检查 https 与证书；拓扑 B 要给设备导入根证书（[deployment.md §A.2](deployment.md)） |
| `docker compose config` 报错 | 前不久手改过 compose / `.env` 里有特殊字符 | `cd deploy && docker compose config` 看具体行；`.env` 的值不要带未转义的 `$`、引号要配对 |

更全的排查（麦克风权限、证书不受信、模型下载失败、显存/内存、voice 502、`docker pull` 全部失败等）
见 [deployment.md §8](deployment.md) —— 那份是通用手册，这篇只列 NAS 特有的。

---

## 10. 来源与未验证项

**参考来源**（NAS 相关，2026-10-25 查阅）：

- 群晖知识中心 · Container Manager「项目」：https://kb.synology.cn/zh-cn/DSM/help/ContainerManager/docker_project?version=7
- 社区实践（DSM 7.2 用 Docker Compose 部署、`/volume1/docker/<App>/` 目录惯例、群晖 `PUID=1026/PGID=100` 的说法）：
  https://github.com/estrellaxd/auto_bangumi/blob/master/docs/deploy/dsm.md
- 威联通 Container Station 部署示例（YAML 创建应用）：https://www.qnap.com.cn/zh-cn/how-to/faq/article/how-to-deploy-unifi-network-application-via-docker-on-qnap-nas

**本仓库内部的事实来源**（这些是权威的，优先于本文的转述）：

- 端口、卷、内存上限、healthcheck：`deploy/docker-compose.yml`
- 容器内用户与目录：`web/Dockerfile`（`USER node`、`DATA_DIR=/app/data`、`COPY migrations src/data scripts`）、`voice/Dockerfile`（无 `USER`、`COPY app` 与 `COPY scripts`）
- `DATA_DIR`/`DB_PATH`/`MIGRATIONS_DIR` 解析：`web/src/db/index.ts`
- 缓存键 v3、`/v1/warmup`、`provider_meta.cache`：`docs/api-contract.md` §12
- provider 组合与预热实测数字：`voice/README.md` §13、§15
- Azure 真实联调结果：`docs/verification.md` §8

**本文件明确未验证的项**（再说一遍，避免误读）：

1. `docker compose build` 从未成功过（本机 docker 拉不到基础镜像）→ **四个镜像都还没被构建出来过**。
2. 容器从未在 NAS（或任何机器）上真正启动过。
3. arm64 上的构建与运行完全未验证。
4. 群晖/威联通图形界面的每一步、以及群晖反向代理 + Let's Encrypt 的界面步骤，均按官方文档与社区实践编写，**未在真机点过**。
5. 内存/磁盘的"建议值"是估算（唯一实测的是缓存体积 86 MiB/600 条 与 单条 144 KB）。

---

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-25 | v1.0 | 初版。面向群晖 DSM / 威联通 QNAP：三种拓扑、arm64 风险、卷与 PUID/PGID 权限坑、首次启动清单、预热（容器内两条命令）、缓存管理（键 v3）、反向代理与"别裸奔公网"、SQLite 热备份（`VACUUM INTO`，已实测）、升级回滚、NAS 专属排查表；所有命令均标注已实测/未实测 |
