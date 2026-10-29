#!/usr/bin/env bash
# 局域网 HTTPS 一键配置（自签 CA）—— 解决"手机上麦克风不可用"
#
# 背景：浏览器只在 secure context（https:// 或 localhost）里允许 getUserMedia。
#       局域网用 http://192.168.x.x:3000 访问时，录音按钮**必然**失败，且前端无法绕过。
#
# 做法：用 Caddy 内置 CA 给"你的局域网 IP"签一张证，再把这张 CA 的根证书装到家人都信任。
#       之后访问 https://<IP>:8443，手机/平板上的麦克风就能用了。
#
# 适用：80/443 被系统 Nginx 占用的 NAS（飞牛 fnOS / 群晖 / 威联通）。
#
# 用法：
#   ./scripts/lan-https-setup.sh                 # 自动探测局域网 IP
#   ./scripts/lan-https-setup.sh coach.lan       # 用主机名（需要局域网能解析这个名字）
#   HOST=192.168.1.50 ./scripts/lan-https-setup.sh
#
# 它做了什么（全部幂等，可重复执行）：
#   1. 在 deploy/.env 里设置 SITE_ADDRESS / TLS_CERT_MODE=internal / COOKIE_SECURE=1
#   2. 在 .env 里把 caddy 的宿主端口改成 8080/8443（避开系统占用的 80/443），然后启动 caddy
#   3. 导出 Caddy 内置 CA 的根证书到 deploy/caddy-root-ca.crt
#   4. 自检 https 端口是否真的返回 200，并校验证书里确实包含该地址
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"
# 只用一个 compose 文件：端口/Caddyfile 都由 .env 变量决定（见 deploy/docker-compose.yml 注释）
COMPOSE=(--profile ingress -f "$DEPLOY/docker-compose.yml")
HTTPS_PORT="${HTTPS_PORT:-8443}"
CA_OUT="${CA_OUT:-$DEPLOY/caddy-root-ca.crt}"

die() { echo "错误: $*" >&2; exit 1; }
info() { echo "  $*"; }

[[ -f "$ENV_FILE" ]] || die "找不到 $ENV_FILE —— 先 cp deploy/.env.example deploy/.env 并填好密钥"
command -v docker >/dev/null || die "没有 docker"

# ── 1. 确定要签发证书的地址 ─────────────────────────────────────────────────
HOST="${1:-${HOST:-}}"
if [[ -z "$HOST" ]]; then
  # 探测默认出口网卡上的本机 IP（不依赖 DNS、不联网）
  HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  [[ -z "$HOST" ]] && HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
[[ -n "$HOST" ]] || die "无法自动探测局域网 IP，请显式传入： ./scripts/lan-https-setup.sh 192.168.1.50"
echo "将为以下地址签发证书: $HOST"
echo "最终访问地址: https://${HOST}:${HTTPS_PORT}"
echo

# ── 2. 幂等地写 .env（不依赖 python：NAS 上不一定有）──────────────────────
set_env() {  # set_env KEY VALUE [注释]
  local key="$1" val="$2" note="${3:-}"
  local tmp="${ENV_FILE}.tmp.$$"
  awk -v k="$key" -v v="$val" -v n="$note" '
    BEGIN { done = 0 }
    $0 ~ "^#?[[:space:]]*" k "=" {
      if (!done) {
        print k "=" v
        if (n != "") print "# ↑ " n
        done = 1
      }
      next
    }
    { print }
    END {
      if (!done) {
        print k "=" v
        if (n != "") print "# ↑ " n
      }
    }
  ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
}

set_env SITE_ADDRESS "$HOST" "局域网 HTTPS：证书按这个地址签发（IP 或主机名）"
set_env TLS_CERT_MODE "internal" "internal = Caddy 内置 CA 自签，客户端需导入根证书"
set_env COOKIE_SECURE "1" "浏览器访问的是 https，会话 cookie 必须带 Secure"
# 宿主 80/443 常被 NAS 系统 Nginx 占用 → 改用 8080/8443；
# 这两个变量由 docker-compose.yml 直接读取，不再需要覆盖文件
# 默认只发布 HTTPS（compose 里 HTTP 映射是注释状态）——NAS 上 80/8080 都可能被系统占用，
# 而自签场景也不需要 http→https 跳转（浏览器会直接报不安全，引导用户用 https 即可）
set_env CADDY_HTTPS_PORT "$HTTPS_PORT" "宿主 HTTPS 端口（443 被系统占用，改用 8443）"
info "已更新 $ENV_FILE（SITE_ADDRESS / TLS_CERT_MODE / COOKIE_SECURE）"

# ── 3. 启动 caddy（宿主端口 8443）──────────────────────────────────────────
echo
echo "启动 caddy ..."
docker compose "${COMPOSE[@]}" --project-directory "$DEPLOY" up -d voice web caddy
info "caddy 已启动"

# ── 4. 等待证书就绪并自检 ──────────────────────────────────────────────────
echo
echo "等待 HTTPS 就绪（首次启动要生成 CA 和证书，可能需要几秒）..."
ok=""
for _ in $(seq 1 40); do
  if curl -fk -sS --max-time 3 "https://127.0.0.1:${HTTPS_PORT}/healthz" 2>/dev/null | grep -q '^ok$'; then
    ok=1; break
  fi
  sleep 1
done
[[ -n "$ok" ]] || die "HTTPS 没起来。排查： docker compose ${COMPOSE[*]} logs --tail=80 caddy"
info "HTTPS 端口自检通过：https://127.0.0.1:${HTTPS_PORT}/healthz → ok"

# 证书里是否真的包含这个地址（避免"证书签给了别人 → 浏览器报错"）
if command -v openssl >/dev/null; then
  cert_dump="$(echo | timeout 5 openssl s_client -connect "127.0.0.1:${HTTPS_PORT}" -servername "$HOST" 2>/dev/null || true)"
  if echo "$cert_dump" | grep -q "IP Address:${HOST}\|DNS:${HOST}"; then
    info "证书主体校验通过：包含 ${HOST}"
  else
    echo "  ⚠️ 没能在证书里找到 ${HOST}（可能证书还没生成完）。"
    echo "     排查： docker compose ${COMPOSE[*]} exec caddy caddy list-certificates"
  fi
fi

# ── 5. 导出根证书 ──────────────────────────────────────────────────────────
echo
docker compose "${COMPOSE[@]}" --project-directory "$DEPLOY" exec -T caddy \
  cat /data/caddy/pki/authorities/local/root.crt > "$CA_OUT" 2>/dev/null \
  || die "导出根证书失败。可手工执行： docker compose ${COMPOSE[*]} exec caddy cat /data/caddy/pki/authorities/local/root.crt"
chmod 644 "$CA_OUT"
info "根证书已导出：$CA_OUT"

cat <<EOF

═══════════════════════════════════════════════════════════════════════════════
✅ 服务端好了。**还差一步：让家里每台设备信任这张根证书**（否则浏览器会报
   "证书无效"，而且不受信时页面不算 secure context，麦克风照样不可用）。

① 把根证书传到设备（任选其一）
   · 飞牛文件管理器 / SMB 共享：把 $CA_OUT 拷到共享目录再下载
   · 或者： scp 你的账号@${HOST}:${CA_OUT} ./

② 在每台设备上安装并**信任**它
   · iPhone / iPad：
       用 Safari 打开该文件 → 允许下载描述文件
       → 设置 → 通用 → VPN与设备管理 → 安装
       → **设置 → 通用 → 关于本机 → 证书信任设置 → 打开它的完全信任开关**（这步最容易漏）
   · Android：
       设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书 → 选择该文件
   · Windows：
       双击 → 安装证书 → 本地计算机 → 放入"受信任的根证书颁发机构"
   · macOS：
       双击导入"钥匙串访问" → 系统 → 该证书 → 显示简介 → 信任 → 始终信任

③ 然后访问： https://${HOST}:${HTTPS_PORT}
   地址栏出现锁头后，录音按钮就可以用了。

自检（在你这台电脑上）：
   curl --cacert "$CA_OUT" https://${HOST}:${HTTPS_PORT}/healthz    # 应输出 ok
   或： EXTERNAL_URL=https://${HOST}:${HTTPS_PORT} ./scripts/check-deploy.sh
═══════════════════════════════════════════════════════════════════════════════
EOF
