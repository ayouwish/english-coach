# 贡献指南

先说清楚这个项目的性格：**它是给一个真实家庭（含一个 8 岁孩子）每天用的**，
所以比起"功能多"，这里更看重"错的时候不会误导孩子"。
下面几条要求不是形式主义，都是踩过坑之后写下来的。

---

## 1. 环境准备

```bash
git clone <repo> && cd english-coach

# 后端
cd voice
python -m venv .venv
.venv/bin/pip install -r requirements.txt        # Azure 相关依赖已包含
cp .env.example .env                             # 不填密钥也能跑（PROVIDER_MODE=mock）

# 前端
cd ../web
pnpm install
pnpm db:reset        # 建表 + 灌种子（首次请求也会自动执行）
```

**先跑 mock 模式**把链路走通再考虑接真实密钥。`PROVIDER_MODE=mock` 下全链路离线可跑，
不花一分钱、不泄露任何数据。

## 2. 提交前必须跑

```bash
cd voice && .venv/bin/python -m pytest -q        # 496 passed，只增不减
cd web && pnpm exec tsc --noEmit && pnpm lint && pnpm build
```

涉及对应模块时还要跑（需要两个服务都起着）：

```bash
node tests/contract_check.mjs     # 契约逐字段校验
node tests/e2e_full.mjs           # 端到端
cd web && pnpm check:child-ipa && pnpm check:phoneme-hints \
        && pnpm check:diagnosis && pnpm check:chat-speech
```

> 守卫跑不起来通常是因为服务没起。`BASE_URL` / `VOICE_SERVICE_URL` 可覆盖默认端口。

## 3. 四条硬性规则

### 3.1 改评分/评测逻辑，必须附对照实验数据

不接受"看起来更准了"。评测相关的改动请给：

- 样本量与来源（不要只挑好样本）
- 与参照实现的相关性（Pearson / Spearman）或一致性指标
- **如果结论是负面的，也请照实提交** —— 本地 GOP 评测就是这么被证伪的
  （`r=0.350`, 详见 `voice/README.md` §13.4）。负面结论同样是有效产出。

### 3.2 儿童可见载荷不能出现 IPA 符号

新增任何儿童可访问的页面或 API，**必须加进 `web/scripts/check-child-ipa.mjs` 的清单**。
注意 IPA 会从很多不显眼的地方泄漏，历史上出现过三次：

- `srs_cards.id` 直接就是音素符号
- `hint_key` 字段
- `demo_text` 字段
- **React 的 `key` 属性会被序列化进 RSC 负载**（最难发现的一次）

所以守卫是**全量扫描响应内容**，不是只看显式字段。改守卫时请用变异测试确认它真的会红。

### 3.3 契约变更要同步文档

`docs/api-contract.md` 是冻结契约。任何请求/响应形状变化：

1. 同时更新文档与实现；
2. 在文档的变更记录里写清**对客户端的影响**（破坏性 / 向后兼容）；
3. 新增字段尽量设为**可选**，并让旧客户端无感。

### 3.4 本地网络相关的东西不进 git

**真实域名、局域网 IP、NAS 绝对路径、路由器/反代的具体配置**——这些是"某套部署的实例信息"，
一律放在仓库根的 **`local/`** 目录（已在 `.gitignore` 里），**不要提交**。

仓库里的文档只能用占位符：`example.com`、`192.168.1.10`、`/volume1/apps/...`。
需要写"我这次怎么配的"时，写成 `local/<主题>.md`，并在文档里用真实值——它只存在你自己机器上。

> 判据很简单：**这段内容换一台机器装，是否还要改？** 要改的，就属于 `local/`。

### 3.5 不许静默降级

provider 失败、模型没配、音频评不出来 —— 都必须**如实写进响应**：

- `provider` 字段用真实来源（降级时是 `template` / `degraded`，**不许伪装成正常 provider**）
- `warnings` 里加上对应的码（新码要加进 `voice/app/hints.py` 的白名单）
- 分数不可得时返回 `null`，**不要返回 0**（0 会被读成"读得一无是处"）

> 反例：曾经 Azure 对无语音的音频返回全 0 分，孩子什么都没说却看到"0 分"。
> 正确行为是 `null` + `scores_unavailable` 警告。

## 4. 代码风格

- **提交信息**用 Conventional Commits：`feat(chat): ...` / `fix(voice): ...`
- 注释写**为什么**，不写**是什么** —— 尤其是反直觉的选择，请把当时的权衡写清楚
- 宁可多写一个测试，也不要留一个"应该没问题"的分支
- 大改动请拆成可独立验证的小提交

## 5. 密钥与隐私

- **绝不提交** `.env`、密钥、真实录音、SQLite 数据库（`.gitignore` 已覆盖，别绕过）
- 新增环境变量请同时更新 `.env.example`，**只写占位符**
- 提交前自查：

```bash
git diff --cached --name-only | grep -E '\.env$|\.db$|data/' && echo "有敏感文件！"
```

## 6. PR 自查清单

- [ ] 测试全绿，且用例数没有减少
- [ ] 涉及契约 → 文档已更新并注明兼容性
- [ ] 涉及儿童可见内容 → `check:child-ipa` 已覆盖新页面/接口
- [ ] 涉及评测/评分 → 附对照实验数据
- [ ] 没有密钥、没有真实用户数据
- [ ] 提交信息说明了「为什么」，而不只是「改了什么」

有问题欢迎直接开 issue 讨论，不用先写代码。
