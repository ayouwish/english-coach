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
| `web` 容器反复重启，日志 `SQLITE_CANTOPEN` / `EACCES` | `data/` 属主不对：`chown -R 1000:1000 /vol1/1000/docker/english-coach/data` |
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
