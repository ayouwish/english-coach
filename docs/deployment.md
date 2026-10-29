# english-coach 部署手册

> 版本 v1.3 ｜ 更新 2026-10-29 ｜ 适用 `deploy/docker-compose.yml`
> 读者：能照着敲命令的家庭用户本人（不需要运维经验）
> 配套：[NAS 部署（群晖/威联通）](nas-deployment.md) · [飞牛 fnOS 部署](fnos-deployment.md) · [系统设计](architecture.md) · [接口契约](api-contract.md) · [硬件与成本](hardware-cost.md) · [验收记录](verification.md)

本文是**操作手册**：从上到下照着做，任何一步都有"怎么确认它成功了"。

> **想部署到 NAS（群晖 DSM / 威联通 QNAP）？直接看 [docs/nas-deployment.md](nas-deployment.md)。**
> 那份是 NAS 专属手册（架构差异、卷与 PUID/PGID 权限坑、反向代理、SQLite 一致性备份），
> 本文则是通用手册 + 本机直跑路径。

> **想给这个服务上一个域名 / 走 HTTPS 反代（Cloudflare + Nginx Proxy Manager）？**
> **（本仓库不含"我这套部署"的实例化多域名文档 —— 它含真实域名/局域网 IP，按约定放在 `local/` 且不进 git。）**
> 通用做法：新增一个域名的 7 步流程、
> 橙云/灰云决策、**后端绑定（`WEB_BIND`）这个最容易错的一步**、以及真实踩过的坑与排查表。
> 本文只讲"应用本身怎么起"，入口/TLS 那一层归那份文档管。

> ## ⚠️ 本手册的诚实边界（先读这一段再动手）
>
> | | 状态 |
> |---|---|
> | `docker compose config` 语法与引用校验 | ✅ **验证过**（exit 0，渲染 170 行） |
> | voice 全链路真实调用（Azure TTS → 音频 → 音素级评测 → 分数） | ✅ **实测过**（`pron=87.2`、`wav 24kHz`、5 个词；见 §10.4） |
> | 语料预热 / 缓存（幂等、体积） | ✅ **实测过**（§6.2、§10.4） |
> | 自检脚本 `scripts/check-deploy.sh` | ✅ **实跑过**（11 PASS / 0 FAIL / 4 SKIP，见 §10.6） |
> | Caddyfile | ✅ **验证过**（真实 caddy 2.11.7 `validate`，4 组域名组合） |
> | **`docker compose build` / `up`（四个镜像）** | ❌ **从未成功构建过**：交付本仓库的机器上 docker daemon 配了失效代理，任何 `docker pull` 都失败（§8.0）。**"能不能构建成功"是这套交付最大的未知数** |
> | 浏览器里真实录音 | ❌ 未实测（无 GUI；API 层与服务端渲染已覆盖） |
>
> 所以正确的心态是：**编排、脚本、接口、预热、备份这些"代码层"的东西是实测过的；
> 镜像构建与真机浏览器交互需要你这边第一次部署时确认。** 首次部署请把"先试构建"当第 0 步（§A.1）。

---

## 0. 30 秒速览

```
deploy/
├── docker-compose.yml   # web(:3000) + voice(:8100)；caddy 是可选的 ingress profile（默认不启动）
├── Caddyfile            # 可选内置入口（--profile ingress）；也可用 NAS 上的 NPM/Lucky 做统一反代
└── .env.example         # 所有 provider 开关与密钥；复制成 .env 后生效
scripts/
├── check-deploy.sh      # 部署自检：一条命令验证编排/健康/provider/TTS/评测（§10.6）
└── warm-corpus.sh       # 一键预热两种语速（开发机/直跑用；NAS 上用容器内命令，见 nas-deployment.md §4.6）
```

三个容器：

| 容器 | 作用 | 端口 | 谁访问它 |
|---|---|---|---|
| `caddy`（可选，`--profile ingress`） | TLS 终止 + 反向代理 | `443`（`CADDY_HTTPS_PORT`） | 浏览器；**也可由 NAS 上的 NPM/Lucky 替代** |
| `web` | Next.js：账号/会话/SQLite/SRS/家长面板 | `3000`（默认只绑 `127.0.0.1`；`WEB_BIND` 可改） | 反代（caddy/NPM/Lucky）与本机调试 |
| `voice` | FastAPI AI 网关：ASR/发音评测/TTS/LLM | `8100`（只绑 `127.0.0.1`） | 只有 web 服务端 |

**数据落盘**：host 的 `english-coach/data/` 同时挂给 web 和 voice（一个目录 = 备份就是打包一个目录）。
**模型缓存**：docker 命名卷 `english-coach_voice-models`，挂到容器内 `/models`。

**AI 组合（2026-10-25 定案）**：`asr=azure`、`pa=azure`、`tts=azure`、`llm=deepseek（远程）`；
本地 `piper`/`local`/`gop` 只作断网兜底（`gop` 经对照实验判定不达标，默认关闭）。
对应 `.env` 就是 `PROVIDER_MODE=hybrid` + Azure 密钥 + DeepSeek 密钥。

### 五条部署路径，选一条

| 路径 | 适合 | 首次投入 | 家人能用手机/平板吗 | 证书 |
|---|---|---|---|---|
> **推荐架构（2026-10 起）**：把"入口"交给 NAS 上的**通用反向代理**（Nginx Proxy Manager / Lucky / 系统 nginx），
> 而不是让每个应用各带一个 caddy。本项目只需对反代说三件事：
> 1) 反代目标 `http://<NAS局域网IP>:3000`（把 `web` 绑定到该 IP：`.env` 设 `WEB_BIND=192.168.x.x`——
>    因为 NPM/Lucky 通常是**桥接网络容器**，连不到宿主的 `127.0.0.1`）；
> 2) 反代带 `X-Forwarded-Proto: https`（NPM 默认就有），并保持 `.env` 的 `TRUST_PROXY=1`、`COOKIE_SECURE=1`；
> 3) 证书在反代里签（NPM 内置 Let's Encrypt/ZeroSSL，建议 DNS-01 通配符 `*.example.com`，以后加子域名免重签）。
>
> 这样以后新增任何服务只改反代，不动本项目；`caddy` 仅在没有现成反代时用 `--profile ingress` 启用。

| **A. 本机 docker compose** | 先跑起来看看 / 已经有电脑 | 0 元 | 能，但要装一次自签根证书 | Caddy internal CA |
| **B. 家用迷你主机常驻** | 想在客厅随手用、不想占主力机 | 约 800–1600 元 | 能 | Caddy internal CA |
| **C. 公网域名** | 要在外面也能用 | 域名约 50 元/年 + 云服务器 | 能，无需装证书 | Let's Encrypt 自动 |
| **D. 不用 Docker，本机直跑** | 没有 Docker / 镜像拉不下来 / 只想先验证功能 | 0 元 | **不能**（只能本机 `http://localhost:3000`） | 不需要 |
| **E. NAS（群晖/威联通）** | 已经有 NAS，想 7×24 常驻、全家共享 | 0 元（用现有 NAS） | 能，NAS 反代签公信证书后**无需装证书** | NAS 反代（推荐）或 Caddy |

> **有 NAS 就走 E**（[nas-deployment.md](nas-deployment.md)）；没有 NAS、只想先看看效果就走 **A**，
> 稳定两周后再考虑 B。路径 C 只在"出门也想练"时才需要，而且多了一份公网暴露面（见 §9）。
> 路径 D 是 Docker 修不好时的兜底，只能本机用。

> ⭐ **所有路径首次部署都有一件必做的事：预热语料缓存（§6.2）。**
> 它把每条语料的示范音与参考 F0 预生成一次 —— **首次跟读就是快的，而且每条语料的云 TTS 只花一次钱**。
> 跳过它的后果不是报错，而是"首次跟读要等（Azure 合成新文本实测 1–11 秒、波动很大；
> S0 升级后 normal 中位约 1.8 秒、slow 中位约 4.2 秒）+ 每条语料反复产生云 TTS 费用"。
> 各路径的落点：路径 A → §A.1 末尾；路径 B → §3 末尾；路径 C → §4；路径 D → §11.1；
> 路径 E → [nas-deployment.md §4.6](nas-deployment.md)。

> ⚠️ **如果你的 `docker pull` 报 `proxyconnect tcp: ... connection refused`，先跳到 §8.0。**
> 这是本机已实测的环境问题（docker daemon 配了失效代理），会让**任何** `docker compose build` 失败。
> 一时修不好也没关系：**§11「不用 Docker 的本地直跑」几分钟就能把功能跑起来**
> （代价是只能在本机 `http://localhost:3000` 用，局域网/平板用不了麦克风）。

---

## 1. 前置条件与 5 分钟自检

**必需**：docker + docker compose（本环境实测版本：Docker 29.1.3 / Compose v5.2.0）、约 10GB 空闲磁盘、2GB+ 空闲内存（走本地模型建议 8GB+）。

```bash
docker --version           # 期望 Docker version 29.x
docker compose version     # 期望 Docker Compose version v2.2x 以上（本环境 v5.2.0）

# 两条最容易踩的坑，先查掉：
ss -lntp | grep -E ':(80|443|3000|8100)\b'   # 期望无输出；有输出说明端口被占，见 §8.6
lsof /home/*/project/dsh/english-coach/data/app.db 2>/dev/null  # 期望无输出（没有别的进程占着库）
```

镜像仓库连通性（国内网络常卡在这一步）：

```bash
docker pull hello-world      # 期望 "Hello from Docker!"
```

> ⚠️ **如果 `docker pull` 报 `proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused`**，
> 说明 docker daemon 配了一个当前没在运行的 HTTP 代理，**任何**镜像都拉不下来（`docker info` 会显示一切正常，
> 很有迷惑性）。两条修复路径与镜像加速的备选见 §8.0。修好之前 `docker compose build` 一定失败，
> 但 `docker compose config`（本文的验收标准）不受影响。

---

## 2. 路径 A：本机 docker compose（推荐第一步）

### A.1 首次启动

```bash
cd /home/wangsimeng/project/dsh/english-coach/deploy

# 1) 生成配置文件（必做；.env 不进 git）
cp .env.example .env

# 2) 改两处：访问地址 与 provider 开关
$EDITOR .env
```

`.env` 里**至少**确认这几项：

```ini
SITE_ADDRESS=192.168.1.23     # ← 改成你本机的局域网 IP（见下），或先写 localhost 只在本机试
TLS_CERT_MODE=internal        # ← 家庭/局域网保持 internal

# AI 组合（2026-10-25 定案：asr/pa/tts=azure、llm=deepseek）
PROVIDER_MODE=hybrid          # ← 目标配置：云为主 + 本地兜底
AZURE_SPEECH_KEY=<你的密钥>    # ← hybrid/cloud 必填
AZURE_SPEECH_REGION=eastasia  # ← 你的资源区域
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=<你的密钥>         # ← 不填也能跑，但反馈会降级成模板（providers.llm=template）
LLM_MODEL=deepseek-flash
```

> 想**先零密钥跑通**（验证部署与账号，不花一分钱）：把上面改成 `PROVIDER_MODE=mock`、
> 注释掉 Azure / LLM 密钥即可 —— mock 模式确定性、离线、不下载任何模型，全链路可用。
> 确认部署没问题后再切回 `hybrid`。**注意**：切换 provider 会让已有参考音缓存全部失效（缓存键含
> `tts_provider`，契约 v1.4 §12.2），需要重跑一次预热（§6.2）—— 这是有意的设计，不是故障。

怎么知道自己机器的局域网 IP：

```bash
ip -4 addr show scope global | grep -oP 'inet \K[\d.]+'   # 例如 192.168.1.23
```

> **为什么建议直接写 IP 而不是 localhost**：写 `localhost` 时只有"这台电脑自己"能访问，
> 而且浏览器对 `http://localhost` 有安全上下文特例、**手机和平板没有**。
> 想让孩子用平板练，就必须让 `SITE_ADDRESS` 等于一个手机也能访问到的地址（IP 或局域网域名）。

校验 → 预拉基础镜像 → 启动 → 看状态：

```bash
docker compose config >/dev/null && echo "语法 OK"     # 只校验，不启动（本文的验收标准）

# 先单独把两个基础镜像拉下来：失败时能立刻定位是网络问题还是构建问题（见 §8.0）
docker pull node:22-alpine
docker pull python:3.11-slim

docker compose up -d --build                          # 首次构建约 5–15 分钟
docker compose ps                                     # 三个容器都应是 running / healthy
docker compose logs -f voice                          # 观察首次启动日志（按 Ctrl-C 退出，不影响容器）
```

**首次启动 voice 可能要下载模型**（`PROVIDER_MODE=local/hybrid` 时）：tiny ≈ 75MB、small ≈ 480MB。
日志里看到下载进度是正常的；看到 `Downloading` 卡住不动见 §8.3。`PROVIDER_MODE=mock` 不下载任何模型。

**预热语料缓存（首次部署必做一次，别跳过）**：把每条语料的示范音与参考 F0 预生成一次 ——
这样首次跟读就是快的，而且**每条语料的云 TTS 只花一次钱**（不预热的话，同一条语料每被跟读一次就再烧一次）。

```bash
cd /home/wangsimeng/project/dsh/english-coach

# 从语料抽出 text → data/warmup-items.json
python3 -c "import json;d=json.load(open('web/src/data/sentences.json'));json.dump([s['text'] for s in d['sentences']],open('data/warmup-items.json','w'),ensure_ascii=False)"

# 打 voice 的 HTTP 端点批量预热（完整命令与判据见 §6.2）
python3 -c "
import json,urllib.request
items=json.load(open('data/warmup-items.json'))
body={'items':[{'text':t,'rate':'normal'} for t in items],'concurrency':2}
req=urllib.request.Request('http://127.0.0.1:8100/v1/warmup',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
r=json.load(urllib.request.urlopen(req,timeout=1800))
print('requested=%s generated=%s cached=%s failed=%s'%(r['requested'],r['generated'],r['cached'],len(r['failed'])))
"
# 期望第一次：generated = 语料条数、cached = 0、failed = 0
# 再跑一次：generated = 0、cached = 语料条数（幂等，可安全重跑）
```

详细说明（含 CLI 写法、预期输出、踩过的坑）见 **§6.2**；改语料后要做什么见 **§6.3**；缓存体积与管理见 **§6.4**。

### A.2 让局域网设备能用麦克风（HTTPS 硬需求，必须做）

先看**为什么**（这是本文最重要的一段）：

> 浏览器的录音 API `navigator.mediaDevices.getUserMedia()` 只在 **secure context** 下存在。
> secure context 只有两种可能：
> 1. 页面是 `https://`；
> 2. 页面是 `http://localhost` 或 `http://127.0.0.1`（浏览器对"本机"的**特例**，仅此一个）。
>
> 也就是说：`http://192.168.1.23:3000`、`http://coach.lan`、`http://你的公网IP` 全部**不是**
> secure context。在这些页面里 `navigator.mediaDevices` 直接是 `undefined`：
> 点"开始录音"**不会弹权限框**，只会静默失败，控制台报
> `TypeError: Cannot read properties of undefined (reading 'getUserMedia')`。
>
> 这不是代码 bug，也无法用任何前端技巧绕过。**这个 App 的核心功能是录音评测，
> 所以局域网访问必须 TLS。** 顺带地，`MediaRecorder`、Service Worker、部分 Web Crypto
> 也受同样的限制。
>
> 结论：localhost 只是"开发时能跑"，**家庭正式用法必须有证书**。

Caddy 用**内置 CA（internal CA）**给局域网地址签一张证书。因为这张证书不是公网 CA 签的，
**每一台要用的设备都要导入一次 Caddy 的根证书**（一次性，5 分钟，之后永久有效）。

**第 1 步：导出根证书**

```bash
cd /home/wangsimeng/project/dsh/english-coach/deploy
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
ls -l caddy-root.crt      # 期望：几百字节到 1KB 的 .crt 文件
```

> 常见误解：`docker compose exec caddy caddy trust` **只把证书装进 caddy 容器自己**，
> 对你电脑上的浏览器毫无作用。必须导出 + 手动导入。

**第 2 步：把 `caddy-root.crt` 发到每台设备**（微信/邮件/AirDrop/U 盘都行），然后按平台导入：

**macOS**

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ./caddy-root.crt
```
或图形界面：双击 `caddy-root.crt` → 钥匙串访问 → 找到 "Caddy Local Authority" →
双击 → 信任 → **使用此证书时：始终信任** → 关闭（输入密码）。

**Windows（管理员 PowerShell）**

```powershell
certutil -addstore -f "ROOT" caddy-root.crt
```
或：双击 → 安装证书 → 本地计算机 → 将所有的证书都放入下列存储 → **受信任的根证书颁发机构** → 完成。

**iPhone / iPad**

1. 把 `caddy-root.crt` 通过 AirDrop 或邮件发到设备，点开 → 允许下载描述文件；
2. 设置 → 通用 → VPN 与设备管理 → 安装该描述文件；
3. **关键一步**：设置 → 通用 → 关于本机 → **证书信任设置** → 打开 "Caddy Local Authority" 的完全信任开关。
   （只做第 2 步不做第 3 步，Safari 依然报证书错误。）

**Android**

设置 → 安全 → 更多安全设置 → 加密与凭据 → **安装证书 → CA 证书** → 选择 `caddy-root.crt` → 确认。
（Chrome 认用户安装的 CA；但某些 App 只认系统 CA。）

**Firefox**（所有平台）：Firefox 用自己的证书库，独立于系统。
设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构 → **导入** → 勾选"信任由此 CA 标识的网站"。

**Linux**：`sudo cp caddy-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`

**第 3 步：验证**

```bash
# 在宿主机：
curl -v https://192.168.1.23/healthz        # 期望：SSL certificate verify ok + 输出 ok
# 若报 "self-signed certificate"：说明 CA 还没导入（宿主机也要导一次，步骤同上）

# 在手机/平板上：浏览器打开 https://192.168.1.23
#   期望：地址栏是锁头、没有警告 → 说明证书已受信
#   然后打开 https://192.168.1.23/healthz，期望页面显示 ok
```

**第 4 步：确认麦克风真的可用**（不要靠"感觉"，用一行命令验证）

在 `https://<SITE_ADDRESS>` 页面上按 F12 → Console 粘贴：

```js
navigator.mediaDevices ? 'OK: secure context' : 'FAIL: 不是安全上下文'
```

期望输出 `OK: secure context`。若输出 `FAIL`：地址栏一定是 `http://` 或证书没受信，回到第 1 步。

**（不推荐）临时替代方案**：手机上装 CA 麻烦时，可以临时用端口转发把局域网访问变成 localhost：

```bash
ssh -L 3000:127.0.0.1:3000 wangsimeng@192.168.1.23   # 然后在电脑上访问 http://localhost:3000
```
这能绕过证书问题，但**平板上没有任何办法伪装成 localhost**，所以这只适合"用电脑临时试一下"。
Chrome 的 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 同理只在单机有效，别当作方案。

### A.3 探活

```bash
cd /home/wangsimeng/project/dsh/english-coach/deploy

# ① 容器自身健康（compose healthcheck 就是查这两个）
docker compose ps                       # 看 STATUS 列是否为 (healthy)

# ② voice：接口契约 §1
curl -s http://127.0.0.1:8100/v1/health | python3 -m json.tool
# 期望关键字段：
#   "status": "ok"
#   "mode":   "mock" | "local" | "cloud" | "hybrid"   ← 和你 .env 里 PROVIDER_MODE 一致
#   "providers": {"asr": "...", "pa": "...", "tts": "...", "llm": "..."}  ← 实际生效的 provider
#   "capabilities": {"phoneme_level": true/false, ...}  ← 决定 UI 显不显示 IPA

# ③ web：web-dev 提供的探活路径（voice 不可达时也返回 200，body 里标 unreachable）
curl -s http://127.0.0.1:3000/api/health | python3 -m json.tool

# ④ 经过 caddy 的完整链路（这才是家人实际走的路径）
curl -s https://192.168.1.23/healthz                     # 期望 ok
curl -s https://192.168.1.23/api/health | python3 -m json.tool
curl -s https://192.168.1.23/v1/health | python3 -m json.tool   # 走 web 的 /voice/* 反向代理
```

**四条全绿才算"部署成功"。** 记录一下 `mode` 与 `providers`，排查问题时第一眼看它们。

一键复制的探活脚本：

```bash
set -e; SITE=$(grep -E '^SITE_ADDRESS=' .env | cut -d= -f2)
for u in "http://127.0.0.1:8100/v1/health" "http://127.0.0.1:3000/api/health" "https://$SITE/healthz"; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' "$u"); echo "$code  $u"
done
# 期望：200 / 200 / 200
```

### A.4 三账号初始化（爸爸 / 妈妈 / 女儿）

**机制**：web 进程**第一次收到请求时**自动建表（幂等 `CREATE TABLE IF NOT EXISTS` + `_migrations` 记账），
并且 **`users` 表为空时自动灌种子账号**（爸爸 / 妈妈 / 女儿三个）。所以启动后**直接打开网页就算初始化完成**，
不需要跑任何命令。两个前提：`AUTO_SEED` 没被设为 `0`，且你在 `.env` 里填了（或接受内置默认的）账号密码。

```bash
cd /home/wangsimeng/project/dsh/english-coach/deploy

# ── 步骤 0：先在 .env 里定好三个账号（推荐，一次到位）──
#   BOOTSTRAP_DAD_EMAIL / BOOTSTRAP_DAD_PASSWORD
#   BOOTSTRAP_MOM_EMAIL / BOOTSTRAP_MOM_PASSWORD
#   BOOTSTRAP_CHILD_EMAIL / BOOTSTRAP_CHILD_PASSWORD
#   不填也能跑，但用的是公开的内置默认密码 —— 开放给局域网访问前请务必改掉。
$EDITOR .env && grep -E '^BOOTSTRAP_' .env

# ── 步骤 1：触发初始化（随便访问一次即可；下面用探活接口就够）──
curl -s http://127.0.0.1:3000/api/health >/dev/null        # 第一次请求会建表 + 灌种子
docker compose logs web | grep -i -E 'migrat|seed|user'     # 期望能看到建表/种子日志

# ── 步骤 2（备选）：不想用自动种子，就手动跑 CLI ──
#   AUTO_SEED=0 关掉自动灌种子，然后：
docker compose exec web node scripts/seed.mjs              # 幂等；已存在的账号不会重复创建
docker compose exec web node scripts/migrate.mjs           # 只跑建表/迁移，不灌种子
docker compose exec web node scripts/migrate.mjs --reset   # ⚠️ 清库重来，会删掉所有练习记录

# ── 步骤 3：验证三个账号都落库了 ──
docker compose exec web node -e "
const db=require('better-sqlite3')(process.env.DATA_DIR+'/app.db');
console.table(db.prepare('select id,email,display_name,role,age_band,cefr_level,daily_limit_minutes from users').all());
"
# 期望三行：dad(role=parent, adult) / mom(role=parent, adult) / girl(role=child, child, 20 分钟)

# ── 步骤 4：用爸爸的账号登录 https://<SITE_ADDRESS>/ ──
#   登录不上见 §8.7（最常见原因是 COOKIE_SECURE=1 而访问的是 http，cookie 被浏览器丢掉）
```

**V1 的账号边界（重要，别找不存在的功能）**：

| 想做的事 | V1 怎么做 |
|---|---|
| 新增/修改成员 | 改 `.env` 的 `BOOTSTRAP_*` 后重建容器，或 `docker compose exec web node scripts/seed.mjs`。**V1 没有"家长面板建账号"功能**（刻意不做） |
| 改密码 | 走 seed 的环境变量重建，或直接在家长面板的个人设置里改（若面板未提供，就用 seed 变量） |
| 女儿账号的固定设定 | `birth_year=2018`（→ `age_band=child`）、`daily_limit_minutes=20`、`allow_free_chat=false`，由 seed 落库 |
| 关闭自动灌种子 | `.env` 里 `AUTO_SEED=0`（例如你只想手工控制账号时） |

> 数据库表名与字段名是**冻结**的（契约 §10），上面那条 `select` 里的字段名可以放心直接查。

**女儿账号的三条儿童模式约束**（部署后确认生效，不是部署时配置）：

| 约束 | 在哪实现 | 怎么验证 |
|---|---|---|
| 不显示 IPA 符号 | 前端按 `/v1/health` 的 `capabilities` + `age_band` 自适应 | 用女儿账号做一次跟读，页面不应出现 θ/ð 这类符号 |
| 单次练习时长上限 15 分钟 | web 侧计时 | 家长面板能看到"今日剩余时长" |
| `/parent` 返回 403 | web 侧鉴权 | 用女儿账号访问 `/parent`，期望 403 |

### A.5 备份 / 恢复 `data/`

**备份就是打包 `data/` + `.env`**（模型缓存不用备，能重下）。

```bash
cd /home/wangsimeng/project/dsh/english-coach

# 一致备份（推荐）：先停写，再打包，再起
docker compose -f deploy/docker-compose.yml stop web
tar czf ~/english-coach-backup-$(date +%F-%H%M).tar.gz \
    --exclude='data/audio/**/tmp*' data deploy/.env
docker compose -f deploy/docker-compose.yml start web
```

> 为什么不用 `cp -r data/` 热拷贝：SQLite 在写入时数据分散在 `app.db` + `app.db-wal` +
> `app.db-shm` 三个文件里，热拷贝可能拿到不自洽的快照。停 web 1 秒是最省事的正确做法。
> 如果不想停服务，用 SQLite 自己的在线备份：
> ```bash
> docker compose -f deploy/docker-compose.yml exec web node -e "
> const db=require('better-sqlite3')(process.env.DATA_DIR+'/app.db');
> db.exec(\"VACUUM INTO '/data/backup-'+Date.now()+'.db'\");"
> ```

自动备份（每天 3:00，保留 14 天）：

```bash
crontab -e
# 加入一行：
0 3 * * * cd /home/wangsimeng/project/dsh/english-coach && docker compose -f deploy/docker-compose.yml stop web >/dev/null && tar czf /home/wangsimeng/backups/ec-$(date +\%F).tar.gz data deploy/.env && docker compose -f deploy/docker-compose.yml start web >/dev/null
```
（记得先 `mkdir -p ~/backups`。）

**恢复**

```bash
cd /home/wangsimeng/project/dsh/english-coach
docker compose -f deploy/docker-compose.yml down          # 停全部，保留卷
mv data data.broken-$(date +%F)                           # 先留现场，别直接删
tar xzf ~/english-coach-backup-2026-10-22.tar.gz          # 还原出 data/ 与 deploy/.env
docker compose -f deploy/docker-compose.yml up -d
curl -s http://127.0.0.1:3000/api/health | python3 -m json.tool
```

**恢复演练建议**：装好当天就演练一次（备份 → 删一条测试记录 → 恢复 → 确认记录回来）。
没演练过的备份等于没有备份。

### A.6 升级

```bash
cd /home/wangsimeng/project/dsh/english-coach
git pull                                       # 或替换代码目录
docker compose -f deploy/docker-compose.yml stop web
tar czf ~/ec-pre-upgrade-$(date +%F).tar.gz data deploy/.env   # 升级前必做
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps      # 等 healthy
```

回滚：`git checkout <上一个提交> && docker compose build && docker compose up -d`。
镜像有 tag（`english-coach-web:0.1.0`），也可以 `docker tag` 出旧版本再切回去。

---

## 3. 路径 B：一台家用迷你主机常驻

和路径 A **只有三点不同**，其余步骤照抄 §2。

**① 硬件**：一台 N100/N150 迷你主机 + 16GB 内存 + 512GB SSD（约 800–1600 元，见
[硬件与成本](hardware-cost.md)），装 Ubuntu Server 24.04 LTS，接网线，开 SSH。

**② 固定 IP**：在路由器里给这台机器的 MAC 绑定固定 IP（例如 `192.168.1.50`），
否则重启后 `SITE_ADDRESS` 就失效了。
`.env` 改成 `SITE_ADDRESS=192.168.1.50`，证书 SAN 自然跟着变（重新 `docker compose up -d caddy`，
再重新导出一次 `caddy-root.crt` 并导入各设备）。

**③ 开机自启**：compose 已设 `restart: unless-stopped`，docker 服务本身自启即可：

```bash
sudo systemctl enable --now docker
```

**额外两件小事**：

```bash
# 关掉省电休眠导致的服务中断
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# 给 docker 日志设上限，避免小硬盘被日志写满（compose 里每个服务已加 max-size，这里是 daemon 级兜底）
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
sudo systemctl restart docker
```

用平板练就不用开主力机了，家里人也不会因为"那台电脑被占用"而放弃练习——这是路径 B 的核心价值。

**还有一件事**：这台机器会长期开着，**首次部署完请跑一次语料预热（§6.2）**。
理由和路径 A 一样，但在这条路径上更值得做：常驻机器一旦被家人用起来，就不适合再"边用边生成示范音"了 ——
预热之后每次跟读都直接命中本地缓存，**延迟更稳，云 TTS 也只花一次钱**。

---

## 4. 路径 C：公网域名

只在"出门也想练"时才做。公网暴露会带来真实的安全责任，先读 §9。

```ini
SITE_ADDRESS=coach.example.com
TLS_CERT_MODE=you@example.com      # ← 填真实邮箱，Caddy 走 Let's Encrypt 自动申请
```

前置：域名 A 记录指向你的公网 IP；路由器把 **80 和 443** 端口转发到这台机器
（443 同时转发 TCP 和 UDP，UDP 是 HTTP/3）；`docker-compose.yml` 里 caddy 已映射 `443/udp`。

然后取消 `deploy/Caddyfile` 里 HSTS 那一行的注释（仅公网域名场景）：

```caddyfile
header Strict-Transport-Security "max-age=31536000; includeSubDomains"
```

```bash
docker compose up -d caddy
docker compose logs -f caddy | grep -i -E 'certificate|acme|error'   # 观察证书签发
curl -sI https://coach.example.com/healthz | head -1                 # 期望 HTTP/2 200
```

证书 90 天自动续期，Caddy 无需人工干预。

**公网部署别忘了预热**：公网用户对延迟更敏感（家里出口带宽、跨网 RTT 都更差），
而预热后示范音与参考 F0 全部走本地缓存，**跟读路径上不再有"出网调 TTS"这一步**。
按 §6.2 跑一次即可（这条路径同样用 `http://127.0.0.1:8100/v1/warmup`，不需要额外开端口）。

> **国内家庭宽带的两点现实**：① 多数地区家宽 80/443 入站被封，公网方案通常要一台便宜的
> 云服务器做反代；② 域名在国内需备案才能用 80/443 提供服务。若只是为了"在外面也能用"，
> 更省事的做法是回家用路径 A/B，出门用 Tailscale/WireGuard 之类的内网穿透组网
> —— 但注意：**通过 VPN 访问 `http://` 地址依然不是 secure context，麦克风仍然不可用**，
> 所以穿透方案也要把 `SITE_ADDRESS` 设成 VPN 内可达的地址并安装 internal CA 证书。
> 不想要证书麻烦的话，公网域名 + Let's Encrypt 反而是最省心的。

---

## 5. 探活速查（贴墙上一份）

| 检查 | 命令 | 期望 |
|---|---|---|
| 容器健康 | `docker compose ps` | 三个 `(healthy)` |
| voice 契约探活 | `curl -s localhost:8100/v1/health` | `status=ok`，`providers` 与 `.env` 一致 |
| web 探活 | `curl -s localhost:3000/api/health` | 200 JSON |
| caddy→web | `curl -s https://$SITE/healthz` | `ok` |
| 端到端（含 /voice 反代） | `curl -s https://$SITE/v1/health` | `status=ok` |
| 证书是否受信 | 浏览器打开 `https://$SITE` | 锁头、无警告 |
| 麦克风可用 | 页面 Console 跑 `[isSecureContext, typeof navigator.mediaDevices]` | `[true, 'object']` |
| 语料缓存已预热 | 重跑一次 §6.2 的预热 | `generated=0`、`cached=语料条数`、`failed=[]` |
| 缓存体积 | `du -sh data/cache` | 两种语速 600 条 ≈ 86 MiB（Azure WAV，§6.4） |
| provider 组合 | `curl -s localhost:8100/v1/health` | `asr/pa/tts=azure`、`llm=deepseek` |
| 一键自检（推荐） | `./scripts/check-deploy.sh` | 无 FAIL（见 §10.6） |
| 最近错误日志 | `docker compose logs --since 10m web voice caddy \| grep -i error` | 无 |

---

## 6. 数据布局、缓存与语料维护

### 6.1 数据布局与"哪些必须备份"

```
english-coach/
├── data/                          ← ★ 基本上就是要备份的全部东西
│   ├── app.db  app.db-wal  app.db-shm      # SQLite：账号、练习、错音本、SRS
│   ├── audio/<user_id>/<yyyy-mm>/<id>.webm # 用户练习录音（契约 §10）
│   └── cache/                              # 示范音 + 参考 F0 缓存（可删、可重生成 → §6.2/§6.4）
│       ├── audio/<hash>.<ext>              #   TTS 示范音（一次生成，永久复用）
│       └── f0/<hash>.json                  #   参考 F0 曲线
└── deploy/.env                    ← ★ 要备份（密钥丢了要重新申请）
```

| 目录 / 卷 | 必须备份？ | 丢了会怎样 |
|---|---|---|
| `data/app.db` | ✅ **必须** | 账号、练习记录、错音本、SRS 排期全丢 —— 这是最不可替代的资产 |
| `data/audio/` | ✅ 建议 | 历史练习录音丢失（分数与反馈仍留在库里） |
| `data/cache/` | ❌ **不必需** | 只是要重跑一次预热（§6.2）。业务数据完全不受影响 |
| `deploy/.env` | ✅ **必须** | 密钥要重新申请 |
| docker 卷 `voice-models` / `caddy-data` / `caddy-config` | ❌ | 模型能重下；`caddy-data` 里的 internal CA 私钥丢了，只需重新导出并重新给各设备导一次证书 |

> `data/audio/` 是 v1.0 的参考音落盘位置，v1.1 起示范音改落 `data/cache/audio/`；
> 旧的 `data/audio/` **仍可被读**，作为兼容/兜底路径（`/v1/audio/*` 优先查缓存，其次回落到这里）。

### 6.2 预热语料缓存（首次部署必做一次）★

**为什么必须做**：跟读语料的示范音（云 TTS）与参考 F0 都是 `(text, voice, rate)` 的**纯函数**，
预生成一次即可永久复用。预热带来两个直接收益：

- **省延迟**：Azure 合成**新文本**慢且波动很大 —— 早期实测 **1–11 秒**（服务端出现过 `RTF=9.84` 的合成超时）；
  **升到 S0 之后**（项目 Lead 实测）：全新文本 `normal` 中位 **≈1.8 s**（最坏 ≈4.4 s）、
  `slow` 中位 **≈4.2 s**（最坏 ≈9.7 s）。预热后同一句直接命中本地缓存，实测降到 **12–22 ms** 量级 ——
  也就是"跟读反馈 < 4 秒"这个体验目标（[架构文档 §3.3](architecture.md)）**基本由缓存决定**。
- **省钱**：每条语料只调用**一次**云 TTS，之后全部命中本地缓存。
  **不预热的话，同一条语料每被跟读一次就会再烧一次云 TTS 的钱。**

**标准做法：从 `web/src/data/sentences.json` 抽出 `text`，批量打 `POST /v1/warmup`（契约 v1.4 §12）。**

> 下面第 1 步会生成一个临时清单文件 `data/warmup-items.json`（约 10KB）。它只是给预热用的输入，
> **预热完可以删掉**；留在那里也无害（备份时想干净就一并 `rm`）。

```bash
cd /home/wangsimeng/project/dsh/english-coach

# 1) 抽出 text 清单。直接写进 data/ —— 容器里就是 /data/warmup-items.json
python3 -c "import json;d=json.load(open('web/src/data/sentences.json'));json.dump([s['text'] for s in d['sentences']],open('data/warmup-items.json','w'),ensure_ascii=False)"
python3 -c "import json;print('语料条数:',len(json.load(open('data/warmup-items.json'))))"

# 2) 预热。compose 已把 voice 的 8100 绑在宿主机 127.0.0.1，直接打 HTTP 端点即可 ——
#    不依赖容器里有没有 CLI 脚本（原因见下面的「注意」）
python3 - <<'PY'
import json, urllib.request
items = json.load(open('data/warmup-items.json'))
body = {"items": [{"text": t, "rate": "normal"} for t in items], "concurrency": 2}
req = urllib.request.Request("http://127.0.0.1:8100/v1/warmup",
    data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
r = json.load(urllib.request.urlopen(req, timeout=1800))
print(json.dumps(r, ensure_ascii=False, indent=2))
assert r["requested"] == r["generated"] + r["cached"] + len(r["failed"]) + r["skipped_duplicates"]
PY
```

**预期输出与判据**（`requested = generated + cached + failed + skipped_duplicates`，契约 v1.4 §12.4）：

| 第几次跑 | `generated` | `cached` | `failed` | 含义 |
|---|---|---|---|---|
| 第一次 | = 语料条数 | 0 | `[]` | 真正生成。300 条语料本机实测约 **11–18 秒**（mock；Azure 取决于云 TTS） |
| 第二次 | **0** | = 语料条数 | `[]` | **幂等** —— 可以放心重跑，不会重复烧云 TTS |

**一键脚本 `scripts/warm-corpus.sh`（推荐日常用）**：它会自动从
`web/src/data/sentences.json` 生成清单，并**把两种语速都预热**：

```bash
./scripts/warm-corpus.sh                 # normal + slow
./scripts/warm-corpus.sh --rate slow     # 只补儿童用的慢速
```

> **为什么要预热两种语速**：`normal` 是成人的示范音 + `pronounce` 参考音分析（内部固定用 normal）；
> `slow` 是**儿童模式的默认示范音**。只预热 normal 的话，孩子那边每次仍然要现合成。
> 注意这个脚本依赖**宿主机**的 `voice/.venv/bin/python`，所以它是给开发机/本机直跑用的；
> **NAS 上要用容器内命令**，见 [nas-deployment.md §4.6](nas-deployment.md)。

**也可以直接调 CLI**（`voice/scripts/warmup.py`，README §8.2），
支持 `--items` / `--text-file` / `--url` / `--concurrency` / `--voice` / `--rate` / `--json`
（前四个见 README §8.2；后三个见 `voice/scripts/warmup.py --help`）：

```bash
cd voice
# (a) 进程内直接预热（不需要起服务；适合 §11 的本机直跑场景）
.venv/bin/python scripts/warmup.py --items ../data/warmup-items.json --concurrency 2
.venv/bin/python scripts/warmup.py --text-file ../data/warmup-corpus.txt --concurrency 2   # 纯文本清单也行

# (b) 打一个已经在跑的服务（compose 部署用，宿主机的 8100 已发布）
.venv/bin/python scripts/warmup.py --items ../data/warmup-items.json --url http://127.0.0.1:8100 --concurrency 2
```

> **容器内也能跑 CLI 了**：`voice/Dockerfile` 现在会 `COPY scripts ./scripts`（放在 `/app/scripts`，
> 正好让脚本内部的 `Path(__file__).parent.parent` 解析到 `/app`），所以
> `docker compose exec -T voice python scripts/warmup.py ...` 是可用的。
> （早期版本的 Dockerfile 只 COPY `app/`，容器里没有脚本 —— 那个缺口已经补掉了。）
>
> `concurrency` 别贪大：契约 §12.3 建议 1–8、默认 2，云 TTS 有限流，预热是后台任务不是用户请求。

### 6.3 语料变化后要做什么

语料库在 `web/src/data/sentences.json`。**改完语料必须重跑一次预热** ——
因为缓存键是（契约 v1.4 §12.2）：

```
sha1("v3" + "\x1f" + tts_provider + "\x1f" + fmt + "\x1f" + text + "\x1f" + voice + "\x1f" + rate)
```

**文本一变就是一个全新的键**，旧缓存不会被复用。

标准三步：

```bash
cd /home/wangsimeng/project/dsh/english-coach

# 1) 改语料
$EDITOR web/src/data/sentences.json

# 2) 重新灌库（web 的 package.json 脚本）
cd web && pnpm db:seed && cd ..

# 3) 重跑一次预热（§6.2 的命令 / 或 ./scripts/warm-corpus.sh）。增量即可：
#    已缓存的算 cached，只有新增/改动的条目才真正生成
```

**不预热会怎样？** —— **功能不会坏，只是变慢 + 产生云 TTS 费用。**
新句子的示范音会在第一次跟读时现场合成（Azure 上按 1–11 秒量级等），而且在这之后如果缓存没落上，
每被跟读一次就可能再调用一次云 TTS。所以"改语料 → 预热"要成对做。
（[nas-deployment.md §9](nas-deployment.md) 的排查表里也把"第一次慢、第二次快"标成了**正常现象**。）

同样需要重跑预热的情况（它们都在缓存键 v3 里，等于一批全新条目）：

- **改了 `rate`**（例如新增一批 `slow`）；
- **换了 `DEFAULT_TTS_VOICE` / `AZURE_TTS_VOICE`**；
- **换了 TTS provider**（`VOICE_TTS_PROVIDER`，比如 Azure ↔ piper/edge-tts）；
- **换了音频格式 `fmt`**（mp3 ↔ wav）。

> 缓存键带 provider 与格式是本项目踩过的一个真实坑的修复：早期键里没有 provider 身份，
> 导致"先用 mock 预热、再切 Azure"时会**命中合成音缓存**，把它当母语者示范播放（[verification.md §7.4](verification.md)）。
> 所以**切换 provider 后缓存必然全部失效，这是设计而不是 bug**。

### 6.4 缓存管理

| 项目 | 实际情况 |
|---|---|
| 位置 | `DATA_DIR/cache/` → compose 下就是 host 的 `data/cache/`（`DATA_DIR=/data`） |
| 组成 | `cache/audio/<hash>.<ext>`（示范音）+ `cache/f0/<hash>.json`（参考 F0 曲线） |
| **键** | `sha1("v3" + "\x1f" + tts_provider + "\x1f" + fmt + "\x1f" + text + "\x1f" + voice + "\x1f" + rate)`（契约 **v1.4** §12.2）。**换 provider、换格式、换音色、换语速、改文本 → 旧缓存全部不命中**（有意设计，避免把合成音当母语者示范复用） |
| **体积（本机实测）** | Azure WAV 24 kHz：单条示范音**平均 144 KB**（955 个样本：中位 137 KB / 最小 27 KB / 最大 394 KB），参考 F0 平均 **3 KB**。满语料 **300 句 × 2 语速 = 600 条 ≈ 86 MiB**<br>早期 mock 合成音（WAV 16 kHz）实测：600 文件 / 26.6 MiB / 平均 93 KB —— 换 provider 与格式后体积会变，**以 `du -sh data/cache` 为准** |
| 上限 | `CACHE_MAX_BYTES` 默认 `524288000`（500MB）；`CACHE_MAX_ENTRIES` 默认 `2000`（audio + f0 合计） |
| 淘汰 | **LRU**：超限时按文件 mtime 从旧到新删 |
| 开关 | `CACHE_ENABLED` 默认 `true`；设为 `false` 回退 v1.0 行为（不写缓存，`provider_meta.cache` 全为 `disabled`） |
| 坏缓存 | 校验后使用：JSON 解析失败、点数 <2 或 >600、时间轴非递增、全清音 —— 一律视为**未命中并重新生成**，绝不会拿坏缓存算分 |
| 失败不落盘 | TTS 全挂时的本地兜底音**不会**写进缓存，下次仍会尝试云 TTS（避免把"降级音"永久固化） |
| 并发 | 同一 key 的并发请求只会生成一次（预热与跟读共用 SingleFlight），不会重复烧云 TTS |

> 体积数字都是**本机实测值**，可自行复现：跑一次 §6.2 的预热后 `du -sh data/cache`。
> 它取决于 `tts_provider` 与 `fmt`（WAV 比 mp3 大得多），所以别把某个具体数字当成跨配置的常数。
> 实测方式：`find data/cache/audio -type f | wc -l` 数条数、`du -sh data/cache` 看总量。

**什么时候可以安全删除？—— 随时。** 删掉唯一的后果是"下次跟读要现场生成示范音"
（变慢一点 + 一小笔云 TTS 费用）。**练习记录、分数、错音本、SRS 排期一条都不会丢**（它们在 `app.db` 里，与缓存无关）。

```bash
# 查看缓存体积
du -sh data/cache && find data/cache -type f | wc -l

# 清空缓存（安全，可重生成；清完重跑一次 §6.2 即可恢复）
rm -rf data/cache/audio/* data/cache/f0/*
```

**备份要不要包含它？不必需** —— 参考音与参考 F0 完全可再生（§6.2 一条命令）。
体积敏感时直接排除：

```bash
tar czf ~/english-coach-backup-$(date +%F).tar.gz --exclude='data/cache' data deploy/.env
```

---

## 7. 三账号日常运维（家长视角）

| 想做的事 | 在哪做 |
|---|---|
| 看女儿这周练了多久 / 高频错音 TOP10 | `/parent` 家长面板 |
| 改女儿每日时长上限（默认 20 分钟） | 家长面板 → 成员管理 → 女儿 → `daily_limit_minutes` |
| 删掉某次录音 | 家长面板 → 练习记录 → 删除（同时删 `data/audio/` 下对应文件） |
| 一键删除某人的全部语音 | 家长面板 → 隐私 → "删除我的所有语音" |
| 看某次评测的原始 JSON | 家长面板 → 记录详情（对应 `attempts.scores_json` / `issues_json`） |

---

## 8. 故障排查

排查心态：**先分层定位**，别一上来就重建。分层顺序固定为
`浏览器 → caddy → web → voice → 云 API/本地模型`，每层都有一条命令能证明它是活的（§5）。

### 8.0 镜像拉不下来：`docker pull` 全部失败 ★本机已实测，会阻塞一切构建

**症状**：`docker compose up --build` 或任何 `docker pull` 都失败，报

```
Error response from daemon: Get "https://registry-1.docker.io/v2/":
proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused
```

有迷惑性的是 `docker info` 一切正常（daemon 活着、overlay2、cgroup v2），`docker images` 也能看，
**只有需要联网的一步会挂**。

**病因**：docker daemon 配了 HTTP 代理，而那个代理当前没在运行。

```bash
# 确诊三连
docker info | grep -i -A3 proxy                 # 期望能打印出 http-proxy/https-proxy
cat /etc/docker/daemon.json                     # 常见内容：{"proxies":{"http-proxy":"http://127.0.0.1:7890", ...}}
curl -sI https://registry-1.docker.io/v2/ | head -1   # 直连返回 401 说明网络本身是通的（401 = 正常鉴权响应）
```

若 `curl` 直连返回 `401`，说明**网络没问题，是 docker 的代理配置过期了** —— 走修复 (b)。

**修复路径 (a)：把用户自己的代理开起来**

```bash
# 检查 7890 端口是否有程序在听
ss -lntp | grep 7890
# 有 Clash/v2ray 之类的客户端就启动它，然后验证：
docker pull hello-world
```
适合"本来就有代理、只是这次没开"的情况。

**修复路径 (b)：从 daemon 配置里去掉失效的代理（推荐，本机验证过网络可直连）**

```bash
sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.bak-$(date +%F)   # 先备份
sudo $EDITOR /etc/docker/daemon.json      # 删掉整个 "proxies": { ... } 段（注意保留合法 JSON，逗号别留尾巴）
sudo systemctl daemon-reload
sudo systemctl restart docker
docker info | grep -i proxy               # 期望无输出
docker pull node:22-alpine                # 期望成功
```

**修复路径 (c)：走国内镜像加速（前两条都不方便时）**

```jsonc
// /etc/docker/daemon.json
{
  "registry-mirrors": ["https://docker.m.daocloud.io"]
}
```
配好后同样 `sudo systemctl restart docker`，然后：

```bash
docker pull docker.m.daocloud.io/library/node:22-alpine
```

> **注意本机实测结论**：如果 `proxies` 段还在且代理没起，**镜像加速也拉不动**
> （请求照样被塞给那个死代理）。所以优先级是：先按 (a)/(b) 解决代理，再考虑 (c)。

**修复后，构建前先单独预拉基础镜像**（把"网络问题"和"构建问题"分开，出错的定位成本天差地别）：

```bash
docker pull node:22-alpine      # web 构建用
docker pull python:3.11-slim    # voice 构建用（本机已有此镜像）
docker pull caddy:2-alpine
```

**兜底**：一时修不好 docker，**功能验证不必等它** —— 直接跳到 §11「不用 Docker 的本地直跑」，
用 `uv run uvicorn` + `pnpm build && pnpm start` 几分钟就能把三账号和跟读闭环跑起来。

### 8.1 麦克风权限被拒 / 点录音没有反应 ★最常见

**症状**：点"开始录音"没有权限弹窗；Console 报
`Cannot read properties of undefined (reading 'getUserMedia')` 或
`NotAllowedError: Permission denied`。

**先分清楚是哪一种**——这两种的修法完全不同：

```js
// 在出问题的页面的 Console 里跑：
console.log('secure:', window.isSecureContext);
console.log('mediaDevices:', typeof navigator.mediaDevices);
```

| 输出 | 病因 | 修法 |
|---|---|---|
| `secure: false` / `mediaDevices: undefined` | **不是安全上下文**（地址是 `http://` 或证书不受信） | 见 §8.2；确认地址栏是 `https://` 且锁头正常 |
| `secure: true` 但报 `NotAllowedError` | 浏览器或系统层面拒绝了权限 | 见下面 ①②③④ |

① **站点级**：地址栏左侧图标 → 网站设置 → 麦克风 → "允许"；或
`chrome://settings/content/microphone` 里把该地址从"不允许"里删掉。
Safari：设置 → 网站 → 麦克风。

② **系统级**：
- macOS：系统设置 → 隐私与安全性 → **麦克风** → 勾选你的浏览器（改完要**完全退出浏览器**再打开）；
- Windows：设置 → 隐私和安全性 → 麦克风 → "让应用访问麦克风"打开，并允许浏览器；
- iOS/iPadOS：Safari 权限弹窗必须点"允许"；设置 → Safari → 麦克风 → 允许。

③ **设备被别的程序独占**：会议软件（腾讯会议/Zoom）或另一个标签页占用麦克风时会直接失败。
关掉它们，并检查是否有多个标签页同时开着练习页。

④ **请求方式不对**：必须在**用户点击**的回调里调用 `getUserMedia`（浏览器要求 user gesture），
且页面已是 https。若确认前端代码没问题却仍失败，用"无痕窗口"排除扩展干扰（某些录音类扩展会抢权限）。

⑤ **Permissions-Policy 把麦克风禁掉了**（自建部署常见）：`deploy/Caddyfile` 里已显式允许同源：
`Permissions-Policy "microphone=(self), camera=(), geolocation=()"`。如果你改过这行、
或在前面又加了一层 nginx/其它反代，检查是否被改成了 `microphone=()`。

⑥ 还是没有？看 caddy 是否把响应头覆盖了：`curl -sI https://$SITE/ | grep -i permissions-policy`。

### 8.2 证书不受信 ★第二常见

**症状**：`NET::ERR_CERT_AUTHORITY_INVALID` / "你的连接不是私密连接" / iOS"此服务器的证书无效"。

先看证书到底长什么样：

```bash
SITE=$(grep -E '^SITE_ADDRESS=' deploy/.env | cut -d= -f2)
openssl s_client -connect $SITE:443 -servername $SITE </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName -dates
```

| 输出里的线索 | 病因 | 修法 |
|---|---|---|
| `issuer=Caddy Local Authority` 且 `subjectAltName` **不含**你在用的地址 | 证书没覆盖这个地址 | `.env` 的 `SITE_ADDRESS` 必须**等于**你浏览器里输入的地址；改完 `docker compose up -d caddy`，重新导出根证书并重新导入各设备 |
| `issuer=Caddy Local Authority`，SAN 正确 | 设备没导入根证书（或 iOS 只装了描述文件没开完全信任） | 回到 §A.2 第 2 步；**iOS 特别注意"证书信任设置"那个开关**；Firefox 要单独导入 |
| `issuer=Let's Encrypt` 但报错 | ACME 签发失败（80/443 没通） | `docker compose logs caddy \| grep -i acme`；检查端口转发与 DNS |
| 证书链不完整 | 公网场景少配了中间证书 | Caddy 会自动处理；若前面有别的反代，检查它是否透传完整链 |

**踩坑预警**：如果你在公网域名场景开过 HSTS，然后又把域名指回自签环境，浏览器会**硬失败**
（不给"继续访问"）。清除办法：Chrome 打开 `chrome://net-internals/#hsts` →
Delete domain security policies 里填入该域名。所以 `deploy/Caddyfile` 里 HSTS **默认是注释掉的**。

**应急通道**：证书还没弄好但要先验证功能，用本机 `http://localhost:3000`
（浏览器对 localhost 有安全上下文特例，麦克风可用）。这只在宿主机本机有效。

### 8.3 模型下载失败

**症状**：`voice` 日志里 `Downloading model ...` 卡在 0%，或 `ConnectionError` /
`huggingface.co` 超时 / `SSL: CERTIFICATE_VERIFY_FAILED`；容器反复重启。

```bash
docker compose logs voice | tail -50          # 看具体是哪个模型、哪个域名
docker compose exec voice ls -la /models      # 看缓存卷里已下了多少
df -h /var/lib/docker                          # 看是不是磁盘满了（模型 + 镜像很占地方）
```

| 原因 | 修法 |
|---|---|
| 到 huggingface.co 网络不稳 | 用国内镜像：在 `.env` 里加 `HF_ENDPOINT=https://hf-mirror.com`，然后 `docker compose up -d --force-recreate voice` |
| 企业/校园网需要代理 | `.env` 里加 `HTTPS_PROXY=http://你的代理:端口`（compose 会把 .env 传进容器） |
| 磁盘满 | `docker system prune -a` 清无用镜像；确认 `df -h` 有 5GB+ 空闲 |
| 下载到一半的残包导致反复失败 | `docker compose down` → `docker volume rm english-coach_voice-models` → `up -d`（会重新下） |
| 就是下不动 | **降级绕过**：`.env` 设 `PROVIDER_MODE=mock`（零下载、零密钥、全链路可跑），先把产品和三账号跑通；同时把 TTS 切到 `edge-tts`（走微软公共接口，不需要下载模型）或本地 `piper`（`VOICE_TTS_PROVIDER=piper`，需先下载 Piper 音色） |

> **最重要的一点：本项目定案的组合（`asr/pa/tts=azure` + `llm=deepseek`）压根不需要下载任何本地模型。**
> 本地模型（faster-whisper / Piper / GOP）只是**断网兜底**，全部惰性加载 —— 不装、不下载也不影响主流程。
> 所以"模型下不动"不该阻塞你上线：确认 `provider_meta` 里 provider 是 azure、缓存预热过，就可以用了。
> 只有在你确实想用本地兜底（`PROVIDER_MODE=local`）时，才需要 `voice/requirements-local.txt` 里的依赖与模型
> （实测量级 888 MB，见 [nas-deployment.md §2.2](nas-deployment.md)）。

**一个重要判断**：如果你本来就要用云评测（`PROVIDER_MODE=cloud`），本地模型**根本不需要下载**。
"模型下不动"不该阻塞你上线，切 `cloud` 或 `mock` 即可。

### 8.4 显存 / 内存不足

**症状**：容器被 OOM Killer 杀掉（`docker compose ps` 里 status `Exited (137)`）；
`voice` 日志出现 `Killed`、`MemoryError`、`CUDA out of memory`；
整机变卡、鼠标一顿一顿；`dmesg` 里有 `Out of memory: Killed process ...`。

```bash
free -h                                   # 看还剩多少
docker stats --no-stream                  # 看每个容器实时占用（重点看 voice 的 MEM USAGE）
docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' $(docker compose ps -q voice)
dmesg | tail -30 | grep -i -E 'oom|killed'
```

| 场景 | 修法 |
|---|---|
| 主机 15GB 内存、voice 吃满 | compose 里 voice 已限 `memory: 8g`（web `2g`）。本地 ASR 换更小的模型：`.env` 里 `WHISPER_MODEL=tiny`（75MB，最省）；CPU 上别用 `small` 以上 |
| 有独显但报 `CUDA out of memory` | 显存被别的程序占了（浏览器/游戏）；把批大小降到 1；或把 `WHISPER_DEVICE=cpu` + `WHISPER_COMPUTE_TYPE=int8` 走 CPU（慢但稳） |
| 8GB 内存的老机器 | 同时只跑 `web + voice + caddy`，**不要**开 `--profile local-llm`（Ollama 要 6GB+）；`PROVIDER_MODE=hybrid` 且 LLM 走云 |
| 加内存条 | 迷你主机大多可加内存；这是比换 CPU 更划算的升级（16GB→32GB 约 200–400 元） |
| 想看是谁吃的 | `docker stats` 里 `MEM USAGE / LIMIT`；voice 常驻内存主要是 ASR 模型 |

**容量参考**（无 GPU、CPU 推理）：
`mock` ≈ 200MB；`cloud`（只做音频转码 + HTTP 转发）≈ 400MB；
`local` + `faster-whisper tiny/int8` ≈ 1GB；`local` + `small/int8` ≈ 1.5–2GB；
再加 Ollama 7B ≈ +5GB。**15GB 内存跑"cloud 为主 + local 兜底"非常宽裕**，
真正吃资源的是"全本地 + 本地 LLM"。

### 8.5 voice 502

**症状**：页面报 `502 Bad Gateway`，或接口返回
`{"error":{"code":"provider_error"|"no_provider", ...}}`。

502 是**网关（caddy 或 web）连不上上游**，不是 voice 自己算错。按层查：

```bash
# ① voice 到底活着吗
docker compose ps voice
curl -s -m 3 http://127.0.0.1:8100/v1/health      # 期望 200 JSON

# ② 从 web 容器里能不能连上 voice（这是实际调用路径）
docker compose exec web node -e "
fetch('http://voice:8100/v1/health').then(r=>r.text()).then(t=>console.log('web->voice OK',t)).catch(e=>console.log('web->voice FAIL',e.message))"

# ③ 从 caddy 容器里看 web
docker compose exec caddy wget -qO- http://web:3000/api/health

# ④ 看日志
docker compose logs --since 5m voice web caddy
```

| 现象 | 病因 | 修法 |
|---|---|---|
| `curl localhost:8100/v1/health` 也不通 | voice 挂了或还在冷启动 | `docker compose logs voice`；首次启动下载模型时 `start_period` 是 180s，多等一会 |
| ①②通、③不通 | web 挂了 | `docker compose logs web`；看是不是 DB 迁移失败 |
| 都通但页面 502 | 只有超时（评测 60s / TTS 20s，见契约 §9） | `docker compose logs voice \| grep -i timeout`；provider 变慢时正常降级到模板结果，不该 502。持续 502 说明 voice 在异常路径上崩了，看 traceback |
| 日志里有 `no_provider` | `.env` 里 provider 开关与密钥不匹配 | 云模式必须有 `AZURE_SPEECH_KEY`；`PROVIDER_MODE=hybrid` 时即使云挂也应回落本地，仍在报错说明本地兜底也没装好（见 §8.3 的降级建议） |
| 只有 `/v1/pronounce` 502 | 评测接口不可重试（契约 §9：避免重复计费） | 这是设计行为：web 会保存音频与参考文本并提示"稍后可重试"，**不丢数据**。确认 `data/audio/` 里有那条录音即可 |

**重启的正确姿势**（不要动不动 `down -v`，那会删卷）：

```bash
docker compose restart voice          # 只重启 voice
docker compose up -d --force-recreate voice   # 改过 .env 后重建
docker compose down                   # 全停（保留数据）
# docker compose down -v              # ⚠️ 会删掉模型缓存卷，非必要不要用
```

### 8.6 端口被占 / 起不来

```bash
ss -lntp | grep -E ':(80|443|3000|8100)\b'
```
- `80/443` 被占：常见是装了 nginx/apache。`sudo systemctl disable --now nginx`。
- `3000/8100` 被占：这两个端口只绑 `127.0.0.1`，说明有本地开发进程在跑（`pnpm dev` / `uvicorn`）。
  停掉它，或改 compose 里的 host 端口映射。

### 8.7 登录失败 / 登录后立刻掉线 ★内网部署最常踩

**症状**：密码明明对，点登录没反应或立刻跳回登录页；Network 里 `POST /api/auth/login` 返回 200
但下一条请求又是 401。

**病因**：`COOKIE_SECURE=1` 时浏览器只接受 **HTTPS** 下发的 cookie。内网用 `http://` 或者证书不受信时，
登录 cookie 会被浏览器直接丢掉。

```bash
grep -E '^COOKIE_SECURE' deploy/.env      # 内网 http 场景必须是 0 或注释掉
curl -si http://127.0.0.1:3000/api/auth/login -X POST \
  -H 'content-type: application/json' -d '{"email":"...","password":"..."}' | grep -i set-cookie
# 看 Set-Cookie 里有没有 Secure 属性：内网 http 下有 Secure = 一定会登录失败
```

| 场景 | `COOKIE_SECURE` |
|---|---|
| `http://localhost:3000` 直跑（§11） | `0` |
| 局域网自签 TLS，但设备的根证书还没导入（浏览器报证书警告） | `0`（先修证书，再改 1） |
| 局域网自签 TLS 且证书已受信 | `1` |
| 公网域名（路径 C，全程 HTTPS） | `1` |

改完 `.env` 要 `docker compose up -d --force-recreate web`。

### 8.8 示范音频播放 404/502，但页面其它功能都正常 ★构建期陷阱

**症状**：跟读评测出分正常、文字反馈正常，就是"听示范音"按钮无声，Network 里
`/voice/v1/audio/ref_xxx.wav` 返回 404 或 502（而 `/api/*` 全部正常）。

**病因**：Next.js 的 `rewrites()` 是**构建期**求值的，`/voice/:path*` 的目标地址会被烘焙进
`.next/routes-manifest.json`，`next start` 运行时**只读 manifest，不再读环境变量**。
如果构建时 `VOICE_SERVICE_URL` 是空的，它就 fallback 成 `http://127.0.0.1:8100` ——
在 web 容器内部，`127.0.0.1` 指的是 **web 自己**，于是 `/voice/*` 全部打不通。
（这就是 `deploy/docker-compose.yml` 里 web 服务同时有 `build.args.VOICE_SERVICE_URL`
和 `environment.VOICE_SERVICE_URL` 的原因：前者给 rewrite，后者给服务端 HTTP 调用。）

**定位命令**（一眼看出烘焙进去的到底是什么）：

```bash
docker compose exec web grep -o '"destination":"[^"]*"' .next/routes-manifest.json | grep -i voice
# 期望： "destination":"http://voice:8100/:path*"  之类
# 若出现 127.0.0.1:8100 → 就是这个问题
```

**修法**：确认 compose 里 web 的 `build.args.VOICE_SERVICE_URL=http://voice:8100` 存在，
然后**必须重新构建**（改运行时环境变量没用，因为 manifest 是烘焙的）：

```bash
docker compose build --no-cache web && docker compose up -d --force-recreate web
docker compose exec web grep -o '"destination":"[^"]*"' .next/routes-manifest.json | grep -i voice
```

顺带确认 voice 侧音频真的生成了：`docker compose exec voice ls -la /data/audio`。

### 8.9 预热报 `provider_timeout` / 部分失败

**症状**：跑 §6.2 的预热后，`failed` 数组非空，例如

```json
"failed": [ { "text": "…", "voice": "en-US-JennyNeural", "rate": "slow", "error": "provider_timeout" } ]
```

CLI 形式还会以**退出码 1** 结束（这是设计好的，方便 CI 卡门禁）。

**先别慌 —— 这是设计好的行为，不是整体失败。** 契约 §12.4 明确要求
「单条失败不能让整个预热失败」：失败项只进 `failed` 数组，**HTTP 仍返回 200**，
其余条目照常生成并落缓存。

```bash
# ① 看是单条还是大面积
docker compose logs --since 10m voice | grep -i -E 'timeout|provider_error|warmup'

# ② 确认缓存到底进去了多少（cache.bytes 与 audio_entries 会告诉你）
curl -s -X POST http://127.0.0.1:8100/v1/warmup -H 'Content-Type: application/json' \
  -d '{"items":[{"text":"Hello! My name is Lily.","rate":"normal"}],"concurrency":2}' | python3 -m json.tool

# ③ 直接重跑一次（幂等）：已成功的会算 cached，只有失败的那些才重新生成
```

| 原因 | 修法 |
|---|---|
| 云 TTS 被限流 / 偶发超时（最常见） | **直接重跑**。已成功的条目命中缓存（`cached`），不会重复计费；重跑通常就过了 |
| `concurrency` 开太大把云 TTS 打限流 | 降到 `2`（契约 §12.3 默认值）；预热是后台任务，不需要快 |
| 网络到云 API 不稳 | 换 `edge-tts` 或本地 TTS 先跑通（`VOICE_TTS_PROVIDER`），或在网络好的时段重跑 |
| 大面积失败（`failed` 接近 `requested`） | 这不是单条问题，按 §8.5 查 provider：多半是 `AZURE_SPEECH_KEY`/`REGION` 不对或欠费 |
| 想确认"到底哪几条没过" | 用 `--json` 打印原始响应（CLI 形式），`failed[].text` 就是那几条 |

> **失败不会污染缓存**：TTS 全挂时用的本地兜底音**不会**写进缓存（README §8.1），
> 所以下次仍会尝试云 TTS —— 不用担心"降级音被永久固化"。

### 8.10 缓存目录巨大

**症状**：`data/` 越来越大；`du -sh data/cache` 明显超过预期。

```bash
du -sh data/cache                        # 总占用
find data/cache -type f | wc -l          # 文件数（audio + f0 合计）
du -sh data/cache/audio data/cache/f0    # 分别看
ls -lt data/cache/audio | head           # 最近生成的（LRU 按 mtime 从旧到新淘汰）
```

**正常量级参考（本机实测）**：满语料 **300 句 × 2 语速 = 600 条 ≈ 86 MiB**（Azure WAV 24 kHz；
单条示范音平均 144 KB、参考 F0 平均 3 KB）。早期 mock 合成音实测是 600 文件 / 26.6 MiB ——
**体积随 `tts_provider` 与 `fmt` 变化**，所以以 `du -sh data/cache` 为准（§6.4）。
"300 条语料却占了几个 GB"一定不正常，通常是下面几种情况：

| 原因 | 修法 |
|---|---|
| 缓存上限被调大了 | 检查 `.env` 的 `CACHE_MAX_BYTES`（默认 `524288000` = 500MB）/ `CACHE_MAX_ENTRIES`（默认 `2000`），改回默认 |
| 换过多次音色 / 语速 / provider，历史条目堆积 | 每次换 `voice`/`rate`/`tts_provider`/`fmt` 都会产生**一批新键**（缓存键 v3 含这些分量）。确认不需要旧的就清空（见下） |
| 只预热了一种语速，运行中又补了另一种 | 正常，属于两批条目 |
| 语料反复试读产生大量一次性条目 | 正常，交给 LRU；也可以手动清 |
| 把 `data/audio/`（用户录音）误当成缓存 | 那是**用户练习录音**，属于要备份的数据，别删（§6.1） |

```bash
# 手动清理（安全：删了只是要重新预热）
rm -rf data/cache/audio/* data/cache/f0/*
# 清完重跑一次 §6.2 的预热即可恢复
```

> 上限与淘汰是**自动**的：超出 `CACHE_MAX_BYTES` 或 `CACHE_MAX_ENTRIES` 时按文件 mtime
> 从旧到新删（LRU）。所以正常情况下它**不会无限增长**，你不用定期手工清理。

### 8.11 跟读第一次慢、第二次很快 —— 这是**正常**的，不是 bug

**症状**：同一条语料，第一次跟读明显要等（Azure 上按 1–11 秒量级），之后同一句快得多。

**这正是缓存生效的表现**，是 V1.5 刻意做的优化，不要当故障排查：

| 时刻 | 发生了什么 | 耗时 |
|---|---|---|
| 第一次跟读（该句未预热） | 现场调云 TTS 合成示范音 + 跑 praat 提参考 F0，然后落缓存 | 与文本长度和云服务负载有关。早期实测 **1–11 秒**（`RTF=9.84` 超时）；**S0 后**：`normal` 中位 ≈1.8 s（最坏 ≈4.4 s）、`slow` 中位 ≈4.2 s（最坏 ≈9.7 s） |
| 之后每次跟读 | 示范音与参考 F0 直接命中 `data/cache/`；只剩"用户音频的归一化 + DTW"要算 | 缓存读取实测 **12–22 ms**（早期口径 10–30 ms）；整条评测通常在 1–2 秒内 |

想确认缓存真的命中了，看 `/v1/pronounce` 响应里的 `provider_meta`（契约 §12.5，可选字段）：

```json
"provider_meta": { "cache": { "reference_audio": "hit", "reference_f0": "hit" } }
```

取值 `hit` / `miss` / `disabled`（`with_intonation=false` 或 `CACHE_ENABLED=false` 时为 `disabled`）。
还有一种**半命中**：音频命中但 F0 缺失时只补算 F0，**不会重新调 TTS**（所以也不会重复花钱）。

**如果你希望"第一次就快"** —— 那就把 §6.2 的预热跑掉。预热的目的就是让所有语料都处于"第二次"的状态。

> 相关：如果**每次**都慢、`cache` 一直是 `miss`，那才是问题 —— 检查 `CACHE_ENABLED` 是否为 `true`、
> `data/cache` 是否可写（容器内是 `/data/cache`），以及 `data/` 挂载是否丢了（§8.5）。

### 8.12 其它

| 症状 | 病因 | 修法 |
|---|---|---|
| 登录后过一段时间掉线 | 宿主机时间不对 / 时区不对（容器与宿主共享时钟） | `timedatectl`；`sudo timedatectl set-timezone Asia/Shanghai` |
| `database is locked` | 同时有两个 web 进程写同一个 `app.db`（例如本机 `pnpm dev` 和容器同时开） | 只保留一个写入方；SQLite 单机场景足够，见架构文档 §4 |
| 页面白屏 / 静态资源 404 | web 镜像没按 standalone 构建 | `docker compose build --no-cache web && docker compose up -d web` |
| 评测接口报"稍后可重试" | provider 挂了（契约 §9：评测不重试，避免重复计费） | 这是**设计行为**，不是 bug：音频与参考文本已存 `data/audio/`，不会丢数据。查 `docker compose logs voice` 定位是云 API 还是本地模型的问题 |
| 修改 `.env` 后不生效 | compose 不会自动重读；且 `next build` 烘焙的值必须重建镜像 | `docker compose up -d --force-recreate <服务名>`；涉及 `VOICE_SERVICE_URL` 的见 §8.8 |
| 想彻底重来（**会删数据**） | — | `docker compose down`（保留数据）→ 确认无误后才用 `down -v` + 手动备份恢复 |

---

## 9. 安全清单

> ⚠️ **这是给孩子的应用：三个人的账号 + 孩子的练习录音 + 家长面板。别把它裸奔在公网。**
> 详细取舍（只局域网 / VPN 回连 / 公网反代各自的代价）见 [nas-deployment.md §6.4](nas-deployment.md) ——
> 那一段对非 NAS 部署同样适用。

- [ ] `deploy/.env` **不要**提交到 git（`.gitignore` 里确认有 `.env`）；密钥只存在于 voice 容器环境里。
- [ ] `deploy/.env` 权限设 `600`；`.env.example` 里**只能有占位符**，绝不出现真实密钥。
- [ ] `3000` / `8100` 只绑 `127.0.0.1`（compose 已如此）。**不要**改成 `0.0.0.0` —— 那等于绕过 TLS 暴露 AI 网关，
      也等于把 Azure/DeepSeek 的额度送人。
- [ ] 首次部署就把 `.env` 里的 `BOOTSTRAP_*` 示例密码改掉（默认密码是公开的）。
- [ ] **优先只在局域网用**；要从外面访问就上 VPN（WireGuard / Tailscale / NAS 自带 VPN Server），
      比直接暴露 443 更省事也更安全。
- [ ] 公网路径：给 caddy（或 NAS 反向代理）加访问控制（最简单的办法是只允许家里出口 IP），
      并确保 `/v1/pronounce` 不会被陌生人当免费 API 刷。
- [ ] 定期备份并**做过一次恢复演练**。
- [ ] 女儿的音频是敏感数据：家长面板的"删除全部语音"要真的能用；不需要长期留存就走删。
- [ ] 升级前备份（§A.6）。

---

## 10. 附录：本次交付的自测证据（2026-10-22）

### 10.1 `docker compose config` 通过

```
$ cd english-coach/deploy && docker compose config; echo "exit=$?"
name: english-coach
services:
  caddy:   image=caddy:2-alpine     ports: 80->80, 443->443(tcp), 443->443(udp)
           healthcheck: caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
           volumes: ./Caddyfile->/etc/caddy/Caddyfile(ro), caddy-data->/data, caddy-config->/config
  voice:   build=../voice/Dockerfile  image=english-coach-voice:0.1.0
           ports: 127.0.0.1:8100->8100
           healthcheck: python -c "...urlopen('http://127.0.0.1:8100/v1/health')..."   # 契约 §1
           volumes: ../data->/data, voice-models->/models
  web:     build=../web/Dockerfile    image=english-coach-web:0.1.0
           ports: 127.0.0.1:3000->3000
           healthcheck: node -e "fetch('http://127.0.0.1:3000/api/health')..."
           volumes: ../data->/data
volumes: caddy-config, caddy-data, voice-models
networks: appnet
exit=0
```

**V1.5 复核（2026-10-22，task-8）**：`deploy/docker-compose.yml` **未发生任何改动**
（mtime `2026-10-22 01:24:53`、大小 8391 字节、sha256 前缀 `fa91e7d3353351e1`），
重跑 `docker compose config` 仍 **exit=0**、渲染 170 行。缓存与预热全部由 voice 侧的环境变量与
`data/cache/` 目录承载，**不需要改编排**，因此本节渲染输出保持原样。

### 10.2 构建上下文与挂载路径真实存在

```
OK   ../web         (directory)      # web/Dockerfile 已存在（web-dev 交付）
OK   ../voice       (directory)      # voice/Dockerfile 已存在（voice-dev 交付，python:3.11-slim + uv）
OK   ../data        (directory)      # SQLite + 音频 + cache/
OK   ./Caddyfile    (regular file)
OK   ./.env.example (regular file)
```

### 10.3 `Caddyfile` 用真实 caddy 2.11.7 二进制校验通过

```
$ caddy validate --config Caddyfile --adapter caddyfile        # SITE_ADDRESS / TLS_CERT_MODE 三种组合
[SITE_ADDRESS=localhost      | TLS_CERT_MODE=internal]        Valid configuration
[SITE_ADDRESS=192.168.1.23   | TLS_CERT_MODE=internal]        Valid configuration
[SITE_ADDRESS=coach.lan      | TLS_CERT_MODE=internal]        Valid configuration
[SITE_ADDRESS=coach.example.com | TLS_CERT_MODE=admin@example.com]  Valid configuration

$ caddy adapt ... | jq '.apps.tls.automation.policies[0]'
{ "subjects": ["192.168.1.23"], "issuers": [{ "module": "internal" }] }   # 自签 SAN 正确
```

### 10.4 预热与缓存实测（V1.5 · 本机真实跑过）

在**独立临时 `DATA_DIR`**（不污染 `voice/` 的工作数据）下，用 `web/src/data/sentences.json` 的
**全部 300 条语料**真实跑了一遍预热，并验证了两种调用方式与幂等性：

```
# ① CLI（README §8.2 形式，进程内预热）—— 300 条，concurrency 2
$ DATA_DIR=<临时目录> PROVIDER_MODE=mock .venv/bin/python scripts/warmup.py \
      --items <从 sentences.json 抽出的 300 条 text> --concurrency 2
requested          : 300
generated          : 300      ← 第一次：全部真实生成
cached             : 0
failed             : 0
skipped_duplicates : 0
real 0m11.957s

# ② 第二次（验证幂等）
requested : 300   generated : 0   cached : 300   failed : 0   elapsed_ms : 244
$ echo $?  → 0

# ③ HTTP 端点 POST /v1/warmup（起服务后从宿主机打已发布端口）
{"requested":5,"generated":5,"cached":0,"failed":[],"skipped_duplicates":0,
 "elapsed_ms":140,"cache":{"audio_entries":5,"f0_entries":5,"bytes":412931}}

# ④ CLI 的 --url 模式（打同一个已运行服务，验证幂等）
requested : 5   generated : 0   cached : 5   failed : 0   elapsed_ms : 5   → exit 0
```

**缓存体积实测** —— 两组数字，都来自本机真实缓存目录：

```
A) 早期 mock 合成示范音（WAV 16 kHz），300 条语料：
   cache/audio : 300 files, 27,189,040 bytes = 25.93 MiB
   cache/f0    : 300 files,    740,888 bytes =  0.71 MiB
   TOTAL       : 600 files, 27,929,928 bytes = 26.64 MiB   →  平均每条 ≈ 93 KB

B) 当前 Azure TTS（WAV 24 kHz，`fmt=wav`）真实缓存目录：
   cache/audio : 955 files, 140,619,830 bytes = 134.1 MiB  →  平均 144 KB/条
                 （中位 137 KB、最小 27 KB、最大 394 KB；含 936 个 .wav + 19 个 .mp3）
   cache/f0    : 911 files,   2,568,321 bytes =   2.4 MiB  →  平均 3 KB/条
   折算满语料  ：300 句 × 2 语速 = 600 条 ≈ 86 MiB
```

> **别把 (A) 当常数**：体积随 `tts_provider` 与 `fmt` 变化（缓存键 v3 把这两者都算进去了）。
> 复现方法：跑一次 §6.2 的预热后 `du -sh data/cache`；或 `find data/cache/audio -type f | wc -l` 数条数。

**一键脚本 `scripts/warm-corpus.sh` 也整条跑过**（对着本机 mock voice，零 API 费用）：

```
$ VOICE_URL=http://127.0.0.1:8199 ./scripts/warm-corpus.sh --concurrency 4
voice: http://127.0.0.1:8199
providers: {'asr': 'mock', 'pa': 'mock', 'tts': 'mock', 'llm': 'template'}
语料清单: 300 句 → /…/.warmup-corpus.txt

── 预热 rate=normal ──
requested 300 / generated 300 / cached 0 / failed 0 / elapsed_ms 29335
cache: audio_entries=300 f0_entries=300 bytes=27929928

── 预热 rate=slow ──
requested 300 / generated 300 / cached 0 / failed 0 / elapsed_ms 35855
cache: audio_entries=600 f0_entries=600 bytes=68425535

完成。已缓存的句子下次会直接跳过（幂等）。
$ echo $?  → 0
```

要点：脚本自己从 `web/src/data/sentences.json` 生成清单（300 句）、**两种语速都预热**、退出码 0。
本轮 300 条耗时约 29 s（mock，本机 10 核）；**换成 Azure 会慢得多**（受云 TTS 影响，一次全量建议预留 5–15 分钟），
但因为是幂等的，中途中断后再跑只会补缺失项。

**同时确认的事实**：

1. `voice/Dockerfile` **会** `COPY scripts ./scripts`（放在 `/app/scripts`，正好让脚本内部的
   `Path(__file__).parent.parent` 解析到 `/app`），所以 **`docker compose exec -T voice python scripts/warmup.py ...` 是可用的**。
   （早期版本只 COPY `app/`，容器里没有脚本 —— 这个缺口已经被补掉；[nas-deployment.md §4.6](nas-deployment.md) 用的就是容器内形式。）
2. 缓存键是 **v3** 且包含 `tts_provider` 与 `fmt`（契约 v1.4 §12.2），所以切换 provider / 格式后
   缓存必然全部失效 —— **这是修复过一个真实缺陷后的有意设计**（见 [verification.md §7.4](verification.md)）。
3. `voice/README.md` §8 未给出体积数字；上面两组都是本机可复现的实测值。

### 10.5 未在本机实测的部分（诚实说明）

| 项 | 状态 | 原因 |
|---|---|---|
| `docker compose build` / `up` 端到端 | ⚠️ 未实测 | 本机 docker daemon 配了一个失效的 HTTP 代理（`127.0.0.1:7890` 拒绝连接），任何 `docker pull` 都失败；属宿主环境问题，非编排文件问题。修法见 §8.0。**四个镜像至今没有被构建出来过** —— 这是本交付最大的未知数 |
| `web` / `voice` 的 Dockerfile | ✅ 文件已交付（未构建） | `web/Dockerfile`（多阶段 standalone，构建期 `ARG VOICE_SERVICE_URL`，`USER node`，COPY `migrations`/`src/data`/`scripts`）与 `voice/Dockerfile`（python:3.11-slim + uv，不装系统 ffmpeg，COPY `app` 与 `scripts`） |
| **voice 全链路真实调用（Azure）** | ✅ **已实测** | 真实 Azure 密钥联调：TTS 出 `audio/wav` 163 KB（`x-cache: hit`）、`/v1/pronounce` 返回 `provider=azure`、`granularity=phoneme`、`pron=87.2`、5 个词、`intonation.available=true`（见 §10.4 与 [verification.md §8](verification.md)） |
| 预热 / 缓存 | ✅ 已实测 | §10.4：300 条语料真实预热、幂等复跑、CLI 与 HTTP 两种方式、体积两轮实测 |
| **自检脚本 `scripts/check-deploy.sh`** | ✅ **已实跑** | §10.6：11 PASS / 0 FAIL / 4 SKIP，退出码 0；并做过变异测试确认断言会失败 |
| 浏览器真实录音 / 麦克风权限 | ❌ 未实测 | 无 GUI 环境；API 层与服务端渲染已覆盖，麦克风需要你第一次真机使用时确认（§8.1） |
| 真实云 API 计费对齐 | 见 [硬件与成本](hardware-cost.md) | 价格为官网核实值，实际账单以官网为准 |

**验收标准的口径（明确区分）**：

- ✅ **已验证**：`docker compose config` 语法与引用校验通过（exit=0，170 行）；构建上下文与 bind 路径真实存在；
  `Caddyfile` 用真实 caddy 2.11.7 在 4 种 `SITE_ADDRESS`/`TLS_CERT_MODE` 组合下 `validate` 通过；
  预热与缓存在本机真实跑通（§10.4）；**Azure 全链路（TTS + 音素级评测）在真实密钥下调用成功**（§10.4）；
  自检脚本实跑通过且经变异测试（§10.6）。
- ❌ **未在本机验证**：`docker compose build` 与 `docker compose up` 的完整启动。
  原因：本机 docker daemon 配了失效代理，**任何**镜像都拉不下来（§8.0 已收录该 case 与修复路径），
  且本机没有 node 镜像。**这是宿主环境问题，不是编排文件的问题；修好 §8.0 后即可构建。**
- ❌ **未验证**：NAS 上的构建与运行、arm64 架构、浏览器真实麦克风 —— 见 [nas-deployment.md §0](nas-deployment.md)。
- 🔁 **替代验证路径**：§11「不用 Docker 的本地直跑」随时可用，可完整验证三账号与跟读闭环（含 §11.1 的预热步骤）。

### 10.6 部署自检脚本（`scripts/check-deploy.sh`）

一条命令验证"这套部署到底通不通"，**每项都是真断言**（不是打印 OK），失败时给可操作提示，
当前环境验证不了的项**明确 SKIP 并说明原因**。它只做只读探测（唯一的写请求是 1 次 TTS + 1 次评测，
且用的是**语料里已有的句子**，TTS 通常直接命中缓存）。

```bash
./scripts/check-deploy.sh                                  # 默认 127.0.0.1:8100 / :3000
EXPECT_SERVICES="voice web" EXTERNAL_URL=https://你的域名 ./scripts/check-deploy.sh   # NAS（TLS 交给 NAS 反代）
CHECK_LLM=0 ./scripts/check-deploy.sh                      # 有意只用模板反馈时
```

覆盖：compose 配置 → 容器健康 → `/v1/health` 与 `/api/health`（含 `db.ok`）→ **provider 组合**
→ **TTS 真的出音频** → **评测真的出分数** → 数据目录可写（NAS 权限坑）→ 缓存覆盖度 → HTTPS → 镜像构建。

**本机实跑输出**（2026-10-25，对着真实运行中的 hybrid 服务；完整输出见 [nas-deployment.md §8](nas-deployment.md)）：

```
── 3. 两个健康端点 ──  PASS voice /v1/health status=ok  mode=hybrid providers=asr=azure,llm=deepseek,pa=azure,tts=azure
                       PASS web /api/health ok 且数据库可用
                       PASS web → voice 连通
── 4. provider 组合 ──  PASS 符合预期（mode=hybrid）· PASS LLM 可用 llm=deepseek
── 5. 示范音 ──         PASS POST /v1/tts  provider=azure cache=hit bytes=163246 type=audio/wav
── 6. 评测 ──           PASS POST /v1/pronounce  granularity=phoneme pron=87.2 acc=96.0 flu=75.0 comp=100.0 words=5
── 汇总 ──  PASS 11   FAIL 0   WARN 0   SKIP 4    退出码 0
```

**变异测试**（证明断言不是装饰）：voice 地址指向死端口 → `FAIL voice .../v1/health` + 退出码 2；
`EXPECT_PROVIDERS` 故意写成 `local/local/piper` → `FAIL provider 组合`，逐项列出
`asr: 期望 local / 实际 azure` 等差异 + 退出码 1。

`bash -n scripts/check-deploy.sh` 通过。本机**没有 shellcheck**，故未做 shellcheck 检查。

---

## 11. 附：不用 Docker 的本地直跑（这台机器上立刻可用的方式）

**什么时候用它**：`docker pull` 修不好（§8.0）、或者你只想先验证"这东西到底有没有用"。
**代价**：只能在本机 `http://localhost:3000` 使用，**手机和平板用不了**（原因见下）。

### 11.1 起 voice（:8100）

```bash
cd /home/wangsimeng/project/dsh/english-coach/voice
cp .env.example .env          # 先用 PROVIDER_MODE=mock（零密钥、零模型下载）
# 想跑本地兜底再加 extras：uv sync --extra local
uv --version                  # 本机实测：uv 0.8.12（已在 PATH，无需手动激活 venv）
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8100
```

另开一个终端探活：

```bash
curl -s http://127.0.0.1:8100/v1/health | python3 -m json.tool   # 期望 "status": "ok"
```

**直跑同样要预热一次语料缓存**（否则首次跟读慢、而且每条语料每次都重复调云 TTS）。
直跑有一个现成的一键脚本（**它依赖宿主机 `voice/.venv`，所以只适合这种直跑场景，NAS 上不适用**）：

```bash
cd /home/wangsimeng/project/dsh/english-coach

# 方式一（推荐）：一键脚本，两种语速都预热，幂等
./scripts/warm-corpus.sh
./scripts/warm-corpus.sh --rate slow        # 只补儿童用的慢速

# 方式二：手动两步（等价于脚本内部做的事）
python3 -c "import json;d=json.load(open('web/src/data/sentences.json'));json.dump([s['text'] for s in d['sentences']],open('data/warmup-items.json','w'),ensure_ascii=False)"
cd voice
DATA_DIR=$PWD/../data .venv/bin/python scripts/warmup.py --items ../data/warmup-items.json --concurrency 2
# 期望：generated = 语料条数、cached = 0、failed = 0；再跑一次 → generated = 0、cached = 语料条数
```

> 直跑时 `DATA_DIR` 默认是 `voice/data`（见 `voice/.env.example`），所以上面显式指到项目根的 `data/`，
> 与 §6 的路径说明保持一致。若你希望直跑也写在 `voice/data`，去掉 `DATA_DIR=...` 即可，
> 但要记得备份的是 `voice/data/`。
>
> 注意 `warm-corpus.sh` 内部用 `--url http://127.0.0.1:8100` 打**正在运行的服务**，所以要先按 §11.1 起 voice；
> 它还会在仓库根生成一个临时清单 `.warmup-corpus.txt`（可删）。

### 11.2 起 web（:3000）

```bash
cd /home/wangsimeng/project/dsh/english-coach/web

# ★ 关键：VOICE_SERVICE_URL 必须在 `pnpm build` 之前就有值。
#    Next.js 的 rewrites() 是构建期求值的，烘焙进 .next/routes-manifest.json（详见 §8.8）。
export VOICE_SERVICE_URL=http://127.0.0.1:8100

pnpm install
pnpm build
pnpm start                     # 监听 http://localhost:3000
```

第一次打开 `http://localhost:3000` 时会自动建表 + 灌种子账号（§A.4 同一套机制）。
账号密码在 `deploy/.env.example` 第 7 节有说明；直跑时也可以直接写进 `web/.env`：

```bash
cat >> .env <<'ENV'
BOOTSTRAP_DAD_EMAIL=dad@example.com
BOOTSTRAP_DAD_PASSWORD=change-me-dad-please
BOOTSTRAP_MOM_EMAIL=mom@example.com
BOOTSTRAP_MOM_PASSWORD=change-me-mom-please
BOOTSTRAP_CHILD_EMAIL=girl@example.com
BOOTSTRAP_CHILD_PASSWORD=change-me-girl-please
COOKIE_SECURE=0
VOICE_SERVICE_URL=http://127.0.0.1:8100
ENV
```

数据落在 `web/data/`（`app.db` + `audio/`），直跑期间**要单独备份这个目录**
（docker 路径下备份的是项目根的 `data/`，两者不是同一个目录）。

### 11.3 为什么只能本机用（这一段是本文的第二次强调，因为它值得）

| 访问方式 | 是不是 secure context | 麦克风 | 能用吗 |
|---|---|---|---|
| `http://localhost:3000` | ✅ 是（浏览器对"本机"的唯一特例） | ✅ 可用 | **直跑就用这个** |
| `http://127.0.0.1:3000` | ✅ 是 | ✅ 可用 | 可以 |
| `http://192.168.1.23:3000` | ❌ 不是 | ❌ `getUserMedia` 是 `undefined` | **不行**（点录音静默失败） |
| `https://192.168.1.23`（局域网自签） | ✅ 是（前提：设备已导入根证书） | ✅ 可用 | 行，但要按 §A.2 导证书 |

所以直跑的正确姿势是**"只在宿主机本机、只开一个浏览器标签、用 localhost"**。
一旦想让女儿用平板练，就必须回到 TLS 方案（§2 的路径 A，或本地装一个 caddy）。

### 11.4 想不用 Docker 但又要局域网 + HTTPS

本地装一个 caddy 二进制即可（不需要容器）：

```bash
# 1) 复制 Caddyfile 并改上游：deploy/Caddyfile 里 `reverse_proxy web:3000` → `reverse_proxy 127.0.0.1:3000`
sed 's|web:3000|127.0.0.1:3000|' deploy/Caddyfile > /tmp/Caddyfile.local

# 2) 以局域网 IP 为站点地址启动
SITE_ADDRESS=192.168.1.23 TLS_CERT_MODE=internal caddy run --config /tmp/Caddyfile.local

# 3) 导出根证书并导入各设备（步骤完全同 §A.2 第 1、2 步）
docker compose -f deploy/docker-compose.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
#    ↑ 若没跑过容器，根证书在宿主机的 ~/.local/share/caddy/pki/authorities/local/root.crt
```

然后 `https://192.168.1.23` 就能用了，`COOKIE_SECURE` 在证书受信后可以设 1。

### 11.5 直跑 vs docker：一张对照表

| 能力 | 本地直跑（§11） | docker（§2 路径 A） |
|---|---|---|
| 三账号 / 跟读闭环 / 对话 / 家长面板 | ✅ 全部可用 | ✅ |
| 本机浏览器录音 | ✅（localhost 特例，无需证书） | ✅ |
| 手机 / 平板使用 | ❌ 必须先解决 TLS | ✅（导一次根证书） |
| 开机自启 / 常驻 | ❌ 手动起两个进程 | ✅ `restart: unless-stopped` |
| 一键备份 | ⚠️ 备份 `web/data/` | ✅ 备份项目根 `data/` |
| 依赖 | **本机已实测具备**：uv 0.8.12 + pnpm 11.28.5 + node v24.15.0 | docker + 能拉镜像的网络 |
| 适合 | 开发、验证功能、docker 修不好时的兜底 | 家庭正式使用 |
