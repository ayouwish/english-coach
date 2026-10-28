# 飞牛 OS（fnOS）部署指南

> 面向 **飞牛 fnOS** 的部署说明。通用部署见 [deployment.md](deployment.md)，
> 群晖/威联通见 [nas-deployment.md](nas-deployment.md)。
>
> **诚实声明**：本文的每一条命令都在开发机上验证过（`docker compose config`、镜像构建方式、
> 备份脚本），但**没有在真实的飞牛设备上跑过完整流程** —— 我没有那台机器。
> 文中标了 🟡 的地方就是"需要你在 NAS 上确认一次"的步骤。

---

## 0. 先说结论

| 项 | 推荐 |
|---|---|
| 代码与数据位置 | **`/vol1/1000/docker/english-coach`**（存储空间 1，不是 `/home`） |
| 容器 | 只起 **`voice` + `web`** 两个；**不要**用 compose 里的 `caddy`（见 §2 端口冲突） |
| HTTPS | 必须有（见 §6，否则**手机/平板的麦克风会被浏览器禁用**） |
| 反向代理 | 优先用飞牛自带的 Nginx（它已占 443）；备选是 Caddy 改用 **8443** 端口 |
| 首次验证 | 先用 `PROVIDER_MODE=mock` 跑通，再切 `hybrid` |

---

## 1. 飞牛上必须知道的五件事

| 事实 | 对我们的影响 |
|---|---|
| `/vol1` 是第一块存储空间；**`/vol1/1000` 是默认管理员用户（uid 1000）** | 代码和数据都放这里。**不要放 `/home`** —— 飞牛的 home 跟着系统盘走，容量小 |
| 飞牛**自带 Nginx 占用了 `80` / `443` / `8000` / `8001`** | 我们 compose 里的 `caddy` 抢不到 80/443，会直接起不来（见 §2） |
| web 容器以 **uid 1000** 运行（`USER node`） | 飞牛默认管理员**正好是 uid 1000**，所以 `data/` 属主天然匹配 —— 省掉了其他 NAS 上最烦的 `chown` 坑（仍建议按 §4 验证一次） |
| Docker 有**图形界面**，也有完整 CLI（SSH 后 `sudo -i`） | 两种方式都行；本文用 CLI，因为 compose 更可控 |
| compose 版本可能较旧 | 仓库的 compose 文件用了 `env_file: {path, required}`，**需要 Docker Compose ≥ v2.24**，旧版会解析失败（见 §3） |

---

## 2. 端口冲突：为什么不能用 compose 里的 caddy

飞牛自带 Nginx 监听 `80/443/8000/8001`（配置在 `/usr/trim/nginx/conf/nginx.conf`，
它是系统文件，**不要手改** —— 系统更新可能覆盖，且会影响飞牛自己的 Web 界面）。

所以有两条路：

### 方案 A（推荐）：只起 voice + web，HTTPS 交给飞牛自带 Nginx

```bash
docker compose up -d voice web
```

- 好处：不动飞牛任何系统文件；证书由飞牛管理；未来系统更新不受影响
- 前提：飞牛提供"反向代理"配置入口（**请在你的 fnOS 版本里确认** 🟡：
  设置 → 或者在应用中心搜"反向代理"/"Web 服务"）
- 反代目标填：`http://127.0.0.1:3000`（web 已绑回环，见 §5）
- 反代**必须带 WebSocket/长连接支持**，否则页面能开但 SSE/流式响应会断

> 如果飞牛没有反代入口，走方案 B。

### 方案 B：用 Caddy，但把它挪到 8443

在 `deploy/docker-compose.yml` 里把 caddy 的端口映射改掉：

```yaml
  caddy:
    ports:
      - "8080:80"
      - "8443:443"
```

然后：

```bash
docker compose up -d              # voice + web + caddy
```

访问变成 `https://<NAS地址>:8443`（**8443 不能省**）。
Caddyfile 里的站点地址也要相应调整，见 §6。

> ⚠️ 不要试图改飞牛的 Nginx 配置去释放 80/443。网上有教程这么做，
> 但系统更新后大概率被重置，而且会影响飞牛自身 Web 界面。

---

## 3. 前置检查（在飞牛 SSH 里执行）

```bash
sudo -i

# 1) Docker 与 compose 版本
docker --version
docker compose version        # ← 记下版本号

# 2) 存储空间（确认 /vol1 挂载且空间够）
df -h /vol1

# 3) 当前用户 uid（期望 1000）
id

# 4) 端口占用情况（确认 3000 / 8100 没被别的东西占）
ss -ltnp | grep -E ':(80|443|8000|8001|3000|8100|8443)\b'
```

**如果 `docker compose version` < v2.24**：仓库的 compose 文件会解析失败
（`env_file` 的长语法是 v2.24 才有的）。两种处理：

```bash
# 方式一：升级 compose 插件
apt update && apt install -y docker-compose-plugin   # 或按飞牛文档升级

# 方式二：改成本人人都能读的短语法
cd /vol1/1000/docker/english-coach/deploy
sed -i 's/^      - path: \.env$/      - .env/; /^        required: false$/d' docker-compose.yml
docker compose config >/dev/null && echo "OK"
```

---

## 4. 放代码 + 建数据目录

```bash
mkdir -p /vol1/1000/docker
cd /vol1/1000/docker
git clone https://github.com/ayouwish/english-coach.git
cd english-coach

# 数据目录（compose 里绑的是仓库根的 ../data → 也就是这里）
mkdir -p data
chown -R 1000:1000 data          # web 容器以 uid 1000 运行
ls -ld data                      # 期望 owner 是 1000
```

> 数据会落在 `/vol1/1000/docker/english-coach/data`，正好在**数据盘**上，不占系统盘。
> 里面是 SQLite 数据库和孩子的录音 —— **这是唯一需要备份的目录**。

**NAS 上没有 git 怎么办**：在电脑上 `git clone` 后打包，用飞牛文件管理器传到
`/vol1/1000/docker/` 再解压即可（`tar -xzf english-coach.tar.gz`）。

---

## 5. 配置 `.env`

```bash
cd /vol1/1000/docker/english-coach/deploy
cp .env.example .env
vi .env
```

**最小可用配置**（先跑 mock，不花一分钱、不填任何密钥）：

```ini
PROVIDER_MODE=mock
SITE_ADDRESS=english.example.com     # 走 HTTPS 时填你的域名；仅局域网测试可留空
```

跑通后再改成正式组合：

```ini
PROVIDER_MODE=hybrid                  # asr/pa/tts 用 Azure，llm 用远程 DeepSeek
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=eastasia
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=...
LLM_MODEL=deepseek-flash
SITE_ADDRESS=english.example.com
```

> 这几个变量在 `.env.example` 里都有注释说明；**密钥只放这里**，不会进浏览器。

---

## 6. HTTPS（不是可选项，是麦克风的前置条件）

浏览器的 `getUserMedia()` **只在安全上下文可用**：`https://` 或 `http://localhost`。

**这意味着**：从手机/平板打开 `http://192.168.1.x:3000` 时，**录音按钮会直接失败**
（"无法访问麦克风"）。所以在 NAS 上部署，HTTPS 是硬要求。

### 已经有证书了（acme.sh / 商业证书）？用文件模式

如果你用 `acme.sh` 之类的工具已经签好了 PEM（`fullchain.pem` + `privkey.pem`），
**不需要**把证书装进 `/etc/ssl`，也**不要**去改飞牛自带的 nginx —— 直接让项目的 Caddy 用这些文件：

```bash
cd /vol1/1000/project/english-coach
git pull                     # 拿到 Caddyfile.tls-files 与 docker-compose.tls-files.yaml

cd deploy
mkdir -p certs && chmod 700 certs

# ① 把证书装到项目目录（你自己的目录，不需要 sudo，不会踩 /etc/ssl 的 Permission denied）
~/.acme.sh/acme.sh --install-cert -d <你的域名> \
  --key-file       "$PWD/certs/privkey.pem" \
  --fullchain-file "$PWD/certs/fullchain.pem" \
  --reloadcmd      "cd $PWD && docker compose -f docker-compose.yml -f docker-compose.tls-files.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile || true"
chmod 600 certs/privkey.pem

# ② .env 里改成证书对应的域名（必须与证书 SAN 完全一致）
#    SITE_ADDRESS=<你的域名>
#    COOKIE_SECURE=1

# ③ 起 caddy（宿主端口 8443，绕开系统 Nginx 占用的 80/443）
docker compose -f docker-compose.yml -f docker-compose.tls-files.yaml up -d voice web caddy

# ④ 验证（用 --resolve 绕过 DNS，直接确认证书与站点都对）
curl -v --resolve <你的域名>:8443:127.0.0.1 https://<你的域名>:8443/healthz
```

要点：

- 证书文件挂进容器是**只读**的（`deploy/certs` → `/certs`），私钥仅本机可见；
  `deploy/certs/*` 已在 `.gitignore` 里，**不会被提交**。
- `acme.sh` 续期后要 `caddy reload` 才会用上新证书 —— 上面 `--reloadcmd` 已经带上了。
- **域名只解决"浏览器信任"，不解决"局域网怎么解析它"**：如果这个域名在公网 DNS 里指向你的公网 IP，
  局域网内访问会绕到公网（还可能被路由器的 NAT 回环卡住）。**只在家用的话，请在路由器/内网 DNS
  里给这个域名加一条静态解析 → NAS 的局域网 IP**，然后访问 `https://<域名>:8443`。
- 想让 URL 不带 `:8443`，必须让某个监听 443 的服务做反代 —— 那就得用飞牛自带的反向代理入口
  （或把系统 Nginx 的 443 让出来，不推荐）。

> 注意：这条路径**不要**跑 `scripts/lan-https-setup.sh`（那是给自签 CA 用的，会把
> `TLS_CERT_MODE` 改回 internal）。用了文件模式就固定用 `docker-compose.tls-files.yaml` 这个组合。

---

### 只在家用（局域网）？推荐这条：Caddy 自签 + 8443

不用域名、不用公网、不碰飞牛的系统文件。一条命令搞定服务端：

```bash
cd /vol1/1000/project/english-coach
./scripts/lan-https-setup.sh            # 自动探测局域网 IP；也可 ./scripts/lan-https-setup.sh 192.168.1.50
```

它做的事（全部幂等，可重跑）：

1. 在 `deploy/.env` 里写入 `SITE_ADDRESS=<你的局域网IP>`、`TLS_CERT_MODE=internal`、`COOKIE_SECURE=1`
2. 用 `deploy/docker-compose.lan-https.yaml` 覆盖启动 caddy —— **宿主端口改成 8443**，
   绕开飞牛占用的 80/443（容器内仍是标准 443，Caddyfile 不用改）
3. 用 Caddy **内置 CA** 给这个 IP 签证书，并把**根证书**导出到 `deploy/caddy-root-ca.crt`
4. 自检 `https://127.0.0.1:8443/healthz → ok`，并校验证书里确实包含该 IP

**然后必须在家人的每台设备上装一次根证书**（这一步最容易漏，但漏了就不算 secure context）：

| 设备 | 步骤 |
|---|---|
| iPhone / iPad | Safari 打开证书 → 允许下载描述文件 → 设置→通用→VPN与设备管理→安装 → **设置→通用→关于本机→证书信任设置→打开完全信任** |
| Android | 设置 → 安全 → 加密与凭据 → 安装证书 → **CA 证书** → 选择该文件 |
| Windows | 双击 → 安装证书 → 本地计算机 → **受信任的根证书颁发机构** |
| macOS | 双击导入钥匙串 → 系统 → 该证书 → 显示简介 → 信任 → **始终信任** |

之后访问 **`https://<你的局域网IP>:8443`**，地址栏出现锁头，录音按钮就能用了。

验证：

```bash
curl --cacert deploy/caddy-root-ca.crt https://<你的局域网IP>:8443/healthz   # 应输出 ok
EXTERNAL_URL=https://<你的局域网IP>:8443 ./scripts/check-deploy.sh
```

**两个注意点**：

- **IP 要固定**：在路由器上给 NAS 做 DHCP 静态绑定。IP 变了证书就对不上，需要重跑脚本。
- **别开 HSTS**：Caddyfile 里 HSTS 默认是注释掉的，自签场景千万别打开 ——
  证书一旦不受信，浏览器会直接硬失败，连"继续访问"都不给。
- 想让地址更好看（`coach.lan` 而不是 IP），给它起个局域网能解析的名字后
  `./scripts/lan-https-setup.sh coach.lan` 重新签一次即可。

---

三种拿可信证书的方式，按省事程度排序：

| 方式 | 前提 | 备注 |
|---|---|---|
| **飞牛自带 Nginx + 反代** | 你的 fnOS 有反代入口 | 最省事，证书由飞牛管 |
| **Tailscale / ZeroTier + tailnet HTTPS** | 装个客户端 | 不用域名、不用开公网；家里人各装一个客户端即可 |
| **Caddy + 域名 + DNS-01** | 有自己的域名 | 全自动续期；需要给 Caddy 加 DNS 插件，镜像要自己构建 |

如果只是想**先在电脑上验证功能**：直接在 NAS 上用浏览器访问 `http://127.0.0.1:3000`
（localhost 算安全上下文，麦克风可用），或者用 SSH 端口转发：

```bash
# 在你自己的电脑上执行，把 NAS 的 3000 映射到本机
ssh -L 3000:127.0.0.1:3000 你的用户名@NAS地址
# 然后电脑浏览器打开 http://127.0.0.1:3000 —— 麦克风可用
```

> 这是"先验证、后折腾证书"的最快路径，推荐第一次部署就用它。

---

## 7. 国内网络：拉不到镜像怎么办

`docker compose up -d --build` 需要拉 `node:22-bookworm-slim`、`python:3.11-slim` 等基础镜像。
飞牛在国内，直连 Docker Hub 经常超时。三个办法：

**① 给飞牛配镜像加速**（在飞牛 Docker 设置里，或 `/etc/docker/daemon.json`）：

```json
{
  "registry-mirrors": ["https://<你的加速器地址>"]
}
```

改完 `systemctl restart docker`。

**② 在电脑上构建，再导入 NAS**（最稳，适合镜像拉不动的网络）：

```bash
# 在有网的电脑上
cd english-coach/deploy
docker compose build            # 构建出 english-coach-web:0.1.0 / -voice:0.1.0
docker save english-coach-web:0.1.0 english-coach-voice:0.1.0 -o english-coach.tar

# 传到 NAS 后
docker load -i english-coach.tar
cd /vol1/1000/docker/english-coach/deploy && docker compose up -d
```

**④ 构建期包源（pnpm / pip）——这个不设，构建很可能直接失败**

即使基础镜像拉下来了，**构建过程中还要联网装依赖**。飞牛上实测过的报错：

```
[web builder 6/6] RUN pnpm build
  ! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-11.28.5.tgz
  Error: ... pnpm-11.28.5.tgz ... [cause]: Error: read ECONNRESET
```

原因是 corepack 会在"真正运行 pnpm 的那一刻"才去 registry 下对应版本，
多阶段构建里每个用到 pnpm 的 stage 都要下一次；国内直连 npmjs 很容易被重置。

**当前仓库已修掉这个机制**（pnpm 在共享基础层用 npm 显式安装一次，不再依赖 corepack），
并把包源做成构建参数，在 `deploy/.env` 里设两行即可：

```ini
NPM_REGISTRY=https://registry.npmmirror.com
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
```

设了之后 `docker compose build` 会自动传给两个镜像（`deploy/docker-compose.yml` 里已接线），
**顺带把 `pnpm install` 从 5 分钟压缩到几十秒**（实测飞牛上 deps 阶段原本 314 秒）。

**③ 用国内镜像源的基础镜像**：把两个 Dockerfile 的 `FROM node:22-bookworm-slim` /
`FROM python:3.11-slim` 换成镜像站前缀（如 `docker.m.daocloud.io/library/node:22-bookworm-slim`）。

---

## 8. 启动与验证

```bash
cd /vol1/1000/docker/english-coach/deploy
docker compose up -d voice web

# 看健康状态（healthcheck 变成 healthy 再往下）
docker compose ps

# 后端自检
curl -s http://127.0.0.1:8100/v1/health | head -c 300; echo

# 前端自检
curl -s http://127.0.0.1:3000/api/health | head -c 300; echo
```

期望看到 `providers` 与你 `.env` 里配的一致（mock 模式下全是 mock）。

**首次使用建议预热语料**（Azure 合成新文本较慢，预热后示范音是毫秒级）：

```bash
cd /vol1/1000/docker/english-coach
# 容器内已有脚本（voice/Dockerfile 里 COPY 了 scripts）
docker compose exec -T voice python scripts/warmup.py \
  --text-file /dev/stdin --url http://127.0.0.1:8100 --concurrency 2 <<< \
  "$(docker compose exec -T web node -e "const s=require('/app/src/data/sentences.json');console.log(s.sentences.map(x=>x.text).join('\n'))" 2>/dev/null)"
```

> 上面这条在容器路径假设不同时可能失败。**更简单的方式**：从你自己电脑上跑
> 仓库里的 `./scripts/warm-corpus.sh`，把 `VOICE_URL` 指向 NAS（需要 §6 的端口转发）：
> ```bash
> ssh -L 8100:127.0.0.1:8100 用户名@NAS地址 &
> VOICE_URL=http://127.0.0.1:8100 ./scripts/warm-corpus.sh
> ```

**改演示账号密码**：三个种子账号（`dad@ / mom@ / girl@example.com`）的初始密码是公开的
（写在 `web/README.md`），**部署后立刻改**。

---

## 9. 备份（唯一需要备份的是 `data/`）

里面是 SQLite 数据库（练习记录、掌握度、错音本）+ 孩子的录音。

**正确做法**：不要在数据库写入时直接 `cp`，用 SQLite 自己的备份接口：

```bash
cd /vol1/1000/docker/english-coach

# 方式一：容器内用 node + better-sqlite3 的 VACUUM INTO（本仓库镜像里有这个依赖）
docker compose exec -T web node -e "
const D=require('better-sqlite3');
const db=new D('/data/app.db',{readonly:true});
db.exec(\"VACUUM INTO '/data/backup-'+Date.now()+'.db'\");
console.log('backup ok');
"

# 方式二：先停写再整目录打包（简单粗暴但可靠）
docker compose stop web
tar -czf /vol1/1000/backup/english-coach-$(date +%F).tar.gz -C . data
docker compose start web
```

建议在飞牛的"备份"功能里把 `/vol1/1000/docker/english-coach/data` 加到定时备份任务。

---

## 10. 升级与回滚

```bash
cd /vol1/1000/docker/english-coach
git pull
cd deploy
docker compose build           # 或 docker load 新的 tar
docker compose up -d           # 只重建有变化的容器

# 数据库迁移：web 启动时自动执行 migrations/*.sql（幂等）
docker compose logs -f web | head -40
```

**回滚**：镜像 tag 固定为 `0.1.0`，旧镜像还在本地时直接改回 tag 重启即可；
数据库结构变更不做自动回滚，**升级前先按 §9 备份**。

---

## 11. 排错

| 现象 | 原因与处理 |
|---|---|
| `docker compose up` 报 compose 文件解析错误 | Compose < v2.24，见 §3 的降级改法 |
| caddy 起不来 / 端口被占 | 飞牛自带 Nginx 占了 80/443，见 §2 用方案 A 或改 8443 |
| 页面能开，但**录音按钮报"无法访问麦克风"** | 用了 `http://内网IP`。必须 `https://` 或 `localhost`，见 §6 |
| `web` 容器反复重启，日志 `SQLITE_CANTOPEN` / `EACCES` | `data/` 属主不对：`chown -R 1000:1000 <repo>/data` |
| `/api/health` 里 `db.ok=false`，`db.error` 是 **`EACCES ... '/app/migrations/...'`**（或预热脚本报 `/app/src/data/...` EACCES） | **不是数据目录问题**，是**镜像内文件权限**：如果用 `scp`/`rsync` 把仓库拷到 NAS（或 `umask 077` 下 clone），文件是 `600`，`COPY` 会把 600 带进镜像，运行期 `USER node`(uid 1000) 读不了。<br>立即修：`docker compose exec -u root web sh -c 'chmod -R a+rX /app/migrations /app/src/data /app/scripts /app/public' && docker compose restart web`<br>永久修：仓库里 `find . -type f -exec chmod 644 {} +`（`.env` 保持 600）后 `docker compose build web` |
| `/api/health` 里 `voice.reachable=false` | voice 没起来或没 healthy：`docker compose logs voice`；确认 `.env` 里没有语法错误 |
| 评测返回 401 / `scores` 全是 null | Azure key/region 没配好；或音频不是语音（无语音时按契约返回 `null` 是**正确行为**） |
| 示范音要等好几秒 | 没预热。跑 §8 的预热；Azure 合成新文本本身 1–5 秒 |
| 对话回复很笨、像念台词 | 没配 LLM，走了 `template` 模板。响应里 `degraded_llm=true` 就是这个原因 |
| 磁盘被占满 | `voice/data/cache` 缓存可安全删除（会重新生成）；`docker system prune` 清构建缓存 |

---

## 12. 这条路径上我没验证的部分

- 飞牛**具体的反代配置界面**（不同 fnOS 版本位置可能不同）🟡
- 飞牛内置 Docker 的 **compose 版本**（决定 §3 要不要改文件）🟡
- 在**真实飞牛硬件**上的完整走过一遍
- 飞牛系统更新后对我们 compose 项目的影响

如果哪一步和本文不符，把报错发到仓库 issue，我按实际输出改文档。
