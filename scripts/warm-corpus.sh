#!/usr/bin/env bash
# 一键预热语料缓存（本地优先预热）
#
# 为什么需要它：Azure 合成新文本实测 **1–11 秒且波动很大**（服务端曾报 RTF=9.84 合成超时），
# 所以"用的时候才合成"体验很差。把 300 句语料提前合成到本地缓存后：
#   · 练习页「只听示范」/「跟我读」：命中缓存 ≈ 10–30ms（原来是 2–7 秒）
#   · 参考音分析用的 F0 曲线也一并生成，跟读评分不必现算
#
# 为什么要预热**两种语速**：
#   · normal —— 成人的示范音 + `pronounce` 参考音分析（内部固定用 normal）
#   · slow   —— 儿童的示范音（儿童模式默认 slow）
#   只预热 normal 的话，孩子那边每次仍然要现合成。
#
# 幂等：已缓存的句子会被跳过，重复执行只补缺失项，可以随时重跑。
#
# 两种运行方式（自动识别）：
#   · **主机直跑**：仓库里有 voice/.venv → 用 venv 里的 python 调 voice/scripts/warmup.py
#   · **容器部署**（NAS/Docker）：没有 .venv → 改用 `docker compose exec` 在容器内执行，
#     语料清单由 web 容器里的 node 读取（镜像里都已打包好所需文件）
#
# 用法：
#   ./scripts/warm-corpus.sh                      # 两种语速都预热
#   ./scripts/warm-corpus.sh --rate normal        # 只预热 normal
#   VOICE_URL=http://127.0.0.1:8110 ./scripts/warm-corpus.sh --concurrency 4
#   COMPOSE_FILE=deploy/docker-compose.yml ./scripts/warm-corpus.sh   # 容器模式指定编排文件
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_URL="${VOICE_URL:-http://127.0.0.1:8100}"
CONCURRENCY="${CONCURRENCY:-3}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/deploy/docker-compose.yml}"
RATES=("normal" "slow")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rate) RATES=("$2"); shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --url) VOICE_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

# ── 1. 决定运行方式：主机直跑 or 容器内执行 ─────────────────────────────────
PY="$ROOT/voice/.venv/bin/python"
if [[ -x "$PY" ]]; then
  MODE="host"
elif command -v docker >/dev/null 2>&1 && [[ -f "$COMPOSE_FILE" ]] \
     && [[ -n "$(docker compose -f "$COMPOSE_FILE" ps -q voice 2>/dev/null || true)" ]]; then
  MODE="container"
else
  cat >&2 <<'EOF'
找不到运行环境：既没有 voice/.venv/bin/python，也没有在运行的 voice 容器。

请二选一：
  · 主机直跑： cd voice && python -m venv .venv && .venv/bin/pip install -r requirements.txt
  · 容器部署： cd deploy && docker compose up -d voice web
              （容器模式会自动用 docker compose exec 执行，无需 .venv）

若容器在别的编排文件里，指定一下：
  COMPOSE_FILE=/path/to/docker-compose.yml ./scripts/warm-corpus.sh
EOF
  exit 1
fi
if [[ "$MODE" == "host" ]]; then
  echo "运行方式: 主机直跑（voice/.venv）"
else
  echo "运行方式: 容器内执行（docker compose exec，编排文件 $COMPOSE_FILE）"
fi

# ── 2. 服务必须已经在跑 ────────────────────────────────────────────────────
if ! curl -sSf -o /dev/null "${VOICE_URL}/v1/health" 2>/dev/null; then
  echo "voice 服务不可达：${VOICE_URL}/v1/health" >&2
  if [[ "$MODE" == "host" ]]; then
    echo "请先启动： cd voice && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8100" >&2
  else
    echo "请先启动： cd deploy && docker compose up -d voice web" >&2
  fi
  exit 1
fi
echo "voice: $VOICE_URL"

# ── 3. 生成语料清单（与 web 语料同源，避免手工维护两份）────────────────────
LIST="$ROOT/.warmup-corpus.txt"
if [[ "$MODE" == "host" ]]; then
  "$PY" - "$LIST" <<'PY'
import json, sys
data = json.load(open("web/src/data/sentences.json", encoding="utf-8"))
items = data.get("sentences") or data
open(sys.argv[1], "w", encoding="utf-8").write("\n".join(i["text"] for i in items))
print(f"语料清单: {len(items)} 句 → {sys.argv[1]}")
PY
else
  # 容器模式：web 镜像里已带 src/data 与 node，用它把文本导出来
  docker compose -f "$COMPOSE_FILE" exec -T web node -e '
    const s = require("/app/src/data/sentences.json");
    const items = s.sentences || s;
    process.stdout.write(items.map(i => i.text).join("\n"));
  ' > "$LIST"
  echo "语料清单: $(wc -l < "$LIST" | tr -d ' ') 行 → $LIST"
fi

# ── 4. 逐个语速预热（幂等：已缓存的会跳过）─────────────────────────────────
for rate in "${RATES[@]}"; do
  echo
  echo "── 预热 rate=${rate} ──"
  if [[ "$MODE" == "host" ]]; then
    "$PY" voice/scripts/warmup.py \
      --text-file "$LIST" \
      --url "$VOICE_URL" \
      --concurrency "$CONCURRENCY" \
      --rate "$rate"
  else
    docker compose -f "$COMPOSE_FILE" cp "$LIST" voice:/tmp/warmup-corpus.txt >/dev/null
    docker compose -f "$COMPOSE_FILE" exec -T voice \
      python scripts/warmup.py \
        --text-file /tmp/warmup-corpus.txt \
        --url http://127.0.0.1:8100 \
        --concurrency "$CONCURRENCY" \
        --rate "$rate"
  fi
done

echo
echo "完成。已缓存的句子下次会直接跳过（幂等）。"
