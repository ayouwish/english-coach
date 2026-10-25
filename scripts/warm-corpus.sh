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
# 用法：
#   ./scripts/warm-corpus.sh                      # 两种语速都预热
#   ./scripts/warm-corpus.sh --rate normal        # 只预热 normal
#   VOICE_URL=http://127.0.0.1:8110 ./scripts/warm-corpus.sh --concurrency 4
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_URL="${VOICE_URL:-http://127.0.0.1:8100}"
CONCURRENCY="${CONCURRENCY:-3}"
RATES=("normal" "slow")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rate) RATES=("$2"); shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --url) VOICE_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

PY="$ROOT/voice/.venv/bin/python"
[[ -x "$PY" ]] || { echo "找不到 $PY；请先在 voice/ 下建好虚拟环境" >&2; exit 1; }

if ! curl -sSf -o /dev/null "${VOICE_URL}/v1/health"; then
  echo "voice 服务不可达：${VOICE_URL}/v1/health" >&2
  echo "请先启动： cd voice && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8100" >&2
  exit 1
fi

PROVIDERS=$(curl -sS "${VOICE_URL}/v1/health" | "$PY" -c "import json,sys; print(json.load(sys.stdin).get('providers',{}))")
echo "voice: $VOICE_URL"
echo "providers: $PROVIDERS"

# 生成清单（与 web 的语料保持同源，避免手工维护两份）
LIST="$ROOT/.warmup-corpus.txt"
"$PY" - "$LIST" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open("web/src/data/sentences.json", encoding="utf-8"))
items = data.get("sentences") or data
with open(path, "w", encoding="utf-8") as fh:
    fh.write("\n".join(item["text"] for item in items))
print(f"语料清单: {len(items)} 句 → {path}")
PY

for rate in "${RATES[@]}"; do
  echo
  echo "── 预热 rate=${rate} ──"
  "$PY" voice/scripts/warmup.py \
    --text-file "$LIST" \
    --url "$VOICE_URL" \
    --concurrency "$CONCURRENCY" \
    --rate "$rate"
done

echo
echo "完成。已缓存的句子下次会直接跳过（幂等）。"
