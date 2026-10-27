#!/usr/bin/env bash
# english-coach 部署自检 —— 一条命令回答"这套部署到底通不通"
#
#   ./scripts/check-deploy.sh                       # 默认 voice 127.0.0.1:8100 / web 127.0.0.1:3000
#   VOICE_URL=http://nas.lan:8100 WEB_URL=http://nas.lan:3000 ./scripts/check-deploy.sh
#   CHECK_LLM=0 ./scripts/check-deploy.sh           # 不要求 LLM 可用（有意只用模板反馈时）
#   EXPECT_PROVIDERS="asr=azure,pa=azure,tts=azure" ./scripts/check-deploy.sh
#   EXPECT_SERVICES="voice web" ./scripts/check-deploy.sh          # NAS：不用 caddy，TLS 交给 DSM/QNAP 反代
#   EXTERNAL_URL=https://coach.example.com ./scripts/check-deploy.sh  # 额外验证反向代理入口
#
# 环境变量一览：
#   VOICE_URL / WEB_URL    探测地址（默认 127.0.0.1:8100 / :3000）
#   EXPECT_SERVICES        期望在跑的 compose 服务（默认 "voice web caddy"）
#   EXPECT_PROVIDERS       覆盖 provider 期望；留空则按 PROVIDER_MODE 推导
#   EXTERNAL_URL           外部入口（DSM/QNAP 反向代理或 Caddy），会 URL/healthz
#   CHECK_LLM=0            不要求 llm != template
#   DATA_DIR_HOST          宿主机数据目录（默认 <仓库>/data）
#   TIMEOUT                单次 HTTP 超时秒数（默认 60）
#
# 设计原则：
#   1) 每项都是**真断言**，不是打印 OK；失败给可操作提示，不是"出错了"。
#   2) 当前环境验证不了的项**明确 SKIP 并说明原因**（不假装通过）。
#   3) 自动识别两种姿态：容器模式（docker compose 里有在跑的容器）/ 主机直跑模式（直连 8100+3000）。
#   4) **只读探测**：不重启、不改配置、不动数据。唯一的写请求是向 voice 发 1 次 TTS
#      （用的是语料里已有的句子，通常直接命中缓存）+ 1 次评测（用上一步拿到的音频，成本可忽略）。
#
# 退出码：0 = 无失败项（允许 SKIP）；否则 = 失败项数量。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT/deploy"
DATA_DIR_HOST="${DATA_DIR_HOST:-$ROOT/data}"
VOICE_URL="${VOICE_URL:-http://127.0.0.1:8100}"
WEB_URL="${WEB_URL:-http://127.0.0.1:3000}"
TIMEOUT="${TIMEOUT:-60}"
CHECK_LLM="${CHECK_LLM:-1}"
EXPECT_PROVIDERS="${EXPECT_PROVIDERS:-}"
# 记录是否由用户**显式**指定：未指定时，"没有 caddy 容器"应当 SKIP 而不是 FAIL ——
# 飞牛/DSM/QNAP 上更常见的做法是让 NAS 自带 Nginx 终结 TLS，根本不跑 caddy。
EXPECT_SERVICES_EXPLICIT="${EXPECT_SERVICES:+1}"
EXPECT_SERVICES="${EXPECT_SERVICES:-voice web caddy}"
EXTERNAL_URL="${EXTERNAL_URL:-}"

PASS=0; FAIL=0; SKIP=0; WARN=0
FAILED_NAMES=()

if [[ -t 1 ]]; then C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else C_G=""; C_R=""; C_Y=""; C_B=""; C_0=""; fi

ok()   { PASS=$((PASS+1)); printf "  %sPASS%s %s\n" "$C_G" "$C_0" "$1"; [[ -n "${2:-}" ]] && printf "       %s\n" "$2"; return 0; }
bad()  { FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); printf "  %sFAIL%s %s\n" "$C_R" "$C_0" "$1"; [[ -n "${2:-}" ]] && printf "       %s\n" "$2"; [[ -n "${3:-}" ]] && printf "       %s→ %s%s\n" "$C_Y" "$3" "$C_0"; return 0; }
warn() { WARN=$((WARN+1)); printf "  %sWARN%s %s\n" "$C_Y" "$C_0" "$1"; [[ -n "${2:-}" ]] && printf "       %s\n" "$2"; [[ -n "${3:-}" ]] && printf "       %s→ %s%s\n" "$C_Y" "$3" "$C_0"; return 0; }
skip() { SKIP=$((SKIP+1)); printf "  %sSKIP%s %s\n" "$C_Y" "$C_0" "$1"; [[ -n "${2:-}" ]] && printf "       %s\n" "$2"; [[ -n "${3:-}" ]] && printf "       %s→ %s%s\n" "$C_Y" "$3" "$C_0"; return 0; }
head2(){ printf "\n%s── %s ──%s\n" "$C_B" "$1" "$C_0"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
HAVE_PY=0; command -v python3 >/dev/null 2>&1 && HAVE_PY=1

printf "%s english-coach 部署自检 %s\n" "$C_B" "$C_0"
printf " voice: %s\n web:   %s\n 时间:  %s\n" "$VOICE_URL" "$WEB_URL" "$(date '+%F %T')"
if [[ "$HAVE_PY" != "1" ]]; then
  printf " %s警告：本机没有 python3，JSON 断言会被跳过%s\n" "$C_Y" "$C_0"
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "1. 编排文件 / compose 配置"
# ─────────────────────────────────────────────────────────────────────────────
if [[ ! -f "$DEPLOY_DIR/docker-compose.yml" ]]; then
  bad "deploy/docker-compose.yml 存在" "找不到 $DEPLOY_DIR/docker-compose.yml" \
      "确认仓库完整（compose 在 english-coach/deploy/ 下）"
elif ! command -v docker >/dev/null 2>&1; then
  skip "docker compose config 校验" "本机没有 docker CLI" \
       "NAS 上用 Container Manager / Container Station 导入同一份 compose"
else
  if (cd "$DEPLOY_DIR" && docker compose config -q >/dev/null 2>&1); then
    ok "docker compose config 校验通过" "（工作目录 $DEPLOY_DIR）"
  else
    bad "docker compose config 校验" "compose 文件有语法/引用错误" \
        "cd deploy && docker compose config   # 看具体报错行"
  fi
  for ctx in "$DEPLOY_DIR/../web" "$DEPLOY_DIR/../voice"; do
    if [[ -d "$ctx" ]]; then ok "构建上下文存在：$(basename "$(dirname "$ctx")")/$(basename "$ctx")"
    else bad "构建上下文存在" "缺少目录 $ctx" "确认代码完整；或改用预构建镜像（docs/nas-deployment.md §7）"; fi
  done
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "2. 容器状态（没有容器时自动跳过）"
# ─────────────────────────────────────────────────────────────────────────────
CONTAINER_MODE=0
if command -v docker >/dev/null 2>&1 && (cd "$DEPLOY_DIR" && docker compose ps -q 2>/dev/null | grep -q .); then
  CONTAINER_MODE=1
  for svc in $EXPECT_SERVICES; do
    cid="$(cd "$DEPLOY_DIR" && docker compose ps -q "$svc" 2>/dev/null)"
    if [[ -z "$cid" ]]; then
      if [[ "$svc" == "caddy" && -z "$EXPECT_SERVICES_EXPLICIT" ]]; then
        skip "容器 caddy" \
             "没有 caddy 容器，且未显式要求 —— 视为 TLS 由 NAS 自带反向代理终结（飞牛/DSM/QNAP 常见做法）" \
             "若确实要用 caddy：EXPECT_SERVICES=\"voice web caddy\" ./scripts/check-deploy.sh"
        continue
      fi
      bad "容器 $svc 在运行" "没有该服务的容器" "cd deploy && docker compose up -d $svc"
      continue
    fi
    st="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)"
    hl="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)"
    if [[ "$st" == "running" && ( "$hl" == "healthy" || "$hl" == "none" ) ]]; then
      ok "容器 $svc 运行中（health=$hl）"
    else
      bad "容器 $svc 健康" "status=$st health=$hl" \
          "cd deploy && docker compose logs --tail=50 $svc   # 故障排查见 docs/deployment.md §8"
    fi
  done
  if ! printf '%s' " $EXPECT_SERVICES " | grep -q ' caddy '; then
    skip "caddy 容器" "本次自检不要求 caddy（EXPECT_SERVICES=\"$EXPECT_SERVICES\"）——NAS 上常见做法是让 DSM/QNAP 自带反向代理终结 TLS" \
         "若你确实要用 caddy：EXPECT_SERVICES=\"voice web caddy\" ./scripts/check-deploy.sh"
  fi
else
  skip "容器状态（$EXPECT_SERVICES）" \
       "当前没有在跑的 compose 容器 → 按『主机直跑』模式继续检查 8100/3000（docs/deployment.md §11）"
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "3. 两个健康端点"
# ─────────────────────────────────────────────────────────────────────────────
VH_CODE="$(curl -sS --max-time 10 -o "$TMP/vh.json" -w '%{http_code}' "$VOICE_URL/v1/health" 2>/dev/null)"
if [[ "$VH_CODE" != "200" ]]; then
  bad "voice $VOICE_URL/v1/health 可达" "HTTP ${VH_CODE:-无响应}" \
      "容器：cd deploy && docker compose logs --tail=50 voice ｜ 直跑：cd voice && .venv/bin/python -m uvicorn app.main:app --port 8100"
  V_MODE=""; V_PROVIDERS=""
else
  V_MODE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("mode",""))' "$TMP/vh.json" 2>/dev/null)"
  V_STATUS="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("status",""))' "$TMP/vh.json" 2>/dev/null)"
  V_PROVIDERS="$(python3 -c 'import json,sys
p=json.load(open(sys.argv[1])).get("providers") or {}
print(",".join(f"{k}={v}" for k,v in sorted(p.items())))' "$TMP/vh.json" 2>/dev/null)"
  if [[ "$V_STATUS" == "ok" ]]; then ok "voice /v1/health status=ok" "mode=$V_MODE providers=$V_PROVIDERS"
  else bad "voice /v1/health status" "status='$V_STATUS'" "voice 未就绪，看上面的日志提示"; fi
fi

WH_CODE="$(curl -sS --max-time 10 -o "$TMP/wh.json" -w '%{http_code}' "$WEB_URL/api/health" 2>/dev/null)"
if [[ "$WH_CODE" != "200" ]]; then
  bad "web $WEB_URL/api/health 可达" "HTTP ${WH_CODE:-无响应}" \
      "容器：cd deploy && docker compose logs --tail=50 web ｜ 直跑：cd web && pnpm start"
else
  W_LINE="$(python3 - "$TMP/wh.json" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
db = (d.get("db") or {}).get("ok")
v = d.get("voice") or {}
err = str((d.get("db") or {}).get("error") or "").replace("|", "/").replace("\n", " ")[:300]
print("%s|%s|%s|%s|%s" % (d.get("status"), db, v.get("reachable"), v.get("mode"), err))
PY
)"
  if [[ -z "$W_LINE" ]]; then
    warn "web /api/health 响应无法解析" "HTTP 200 但没有解析出字段（本机缺 python3？）" \
         "人工确认：curl -s $WEB_URL/api/health | python3 -m json.tool"
  else
    IFS='|' read -r W_ST W_DB W_VREACH W_VMODE W_DBERR <<<"$W_LINE"
    if [[ "$W_ST" == "ok" && "$W_DB" == "True" ]]; then ok "web /api/health ok 且数据库可用"
    else
      bad "web /api/health / 数据库" "status=$W_ST db.ok=$W_DB" \
          "数据库不可写最常见：data/ 属主不对（NAS 头号坑）→ sudo chown -R 1000:1000 data/"
      # ★ 把服务端真实报错打出来：否则只能看到 db.ok=False，无法定位
      if [[ -n "${W_DBERR:-}" ]]; then
        printf "       %sdb.error = %s%s\n" "$C_Y" "$W_DBERR" "$C_0"
        case "$W_DBERR" in
          */app/*|*/app/migrations*)
            # 镜像内文件 EACCES —— 和 data/ 属主无关，是构建上下文权限被带进了镜像
            printf "       %s→ 镜像内文件权限不对（构建上下文里是 600，COPY 原样带进镜像）%s\n" "$C_Y" "$C_0"
            printf "       %s  立即修： docker compose exec -u root web sh -c 'chmod -R a+rX /app/migrations /app/src/data /app/scripts /app/public'%s\n" "$C_Y" "$C_0"
            printf "       %s  永久修： 在仓库里 chmod -R a+rX web/ 后 docker compose build web%s\n" "$C_Y" "$C_0" ;;
          *SQLITE_CANTOPEN*|*EACCES*|*permission*|*readonly*)
            printf "       %s→ 权限问题：sudo chown -R 1000:1000 <repo>/data 后重启 web%s\n" "$C_Y" "$C_0" ;;
          *migrations*|*"no such table"*)
            printf "       %s→ 迁移问题：确认镜像里有 migrations/（MIGRATIONS_DIR），或数据目录被旧文件占用%s\n" "$C_Y" "$C_0" ;;
          *"not a database"*|*malformed*|*corrupt*)
            printf "       %s→ app.db 损坏或不是数据库文件：备份后删除 <repo>/data/app.db 让服务重建%s\n" "$C_Y" "$C_0" ;;
        esac
      fi
    fi
    if [[ "$W_VREACH" == "True" ]]; then ok "web → voice 连通" "voice.mode=$W_VMODE"
    else
      bad "web → voice 连通" "web 报告 voice 不可达" \
          "容器内用服务名：VOICE_SERVICE_URL=http://voice:8100（主机直跑用 http://127.0.0.1:8100）"
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "4. provider 组合是否符合预期"
# ─────────────────────────────────────────────────────────────────────────────
ENV_MODE=""
[[ -f "$DEPLOY_DIR/.env" ]] && ENV_MODE="$(grep -E '^PROVIDER_MODE=' "$DEPLOY_DIR/.env" | tail -1 | cut -d= -f2 | tr -d ' "')"
MODE="${ENV_MODE:-$V_MODE}"
if [[ -z "$V_PROVIDERS" ]]; then
  skip "provider 组合断言" "voice /v1/health 不可达，拿不到 providers"
elif [[ -n "$EXPECT_PROVIDERS" ]]; then
  EXPECT="$EXPECT_PROVIDERS"
else
  case "$MODE" in
    hybrid|cloud) EXPECT="asr=azure,pa=azure,tts=azure" ;;
    local)        EXPECT="asr=local,pa=local,tts=piper" ;;
    mock)         EXPECT="asr=mock,pa=mock,tts=mock" ;;
    *)            EXPECT="" ;;
  esac
fi
if [[ -n "$V_PROVIDERS" ]]; then
  if [[ -z "$EXPECT" ]]; then
    skip "provider 组合断言" "无法从 PROVIDER_MODE='$MODE' 推导期望值" "用 EXPECT_PROVIDERS=\"asr=...,pa=...,tts=...\" 显式指定"
  else
    MISMATCH=""
    for pair in ${EXPECT//,/ }; do
      key="${pair%%=*}"; want="${pair##*=}"
      got="$(printf '%s' "$V_PROVIDERS" | tr ',' '\n' | grep "^${key}=" | cut -d= -f2)"
      [[ "$got" != "$want" ]] && MISMATCH+="${key}: 期望 ${want} / 实际 ${got:-缺失}; "
    done
    if [[ -z "$MISMATCH" ]]; then ok "provider 组合符合预期（mode=$MODE）" "实际：$V_PROVIDERS"
    else
      bad "provider 组合（mode=$MODE）" "$MISMATCH" \
          "查 deploy/.env：PROVIDER_MODE + AZURE_SPEECH_KEY/REGION + LLM_API_KEY；改完 docker compose up -d --force-recreate voice"
    fi
  fi
  LLM="$(printf '%s' "$V_PROVIDERS" | tr ',' '\n' | grep '^llm=' | cut -d= -f2)"
  if [[ "$CHECK_LLM" == "1" && ( "$MODE" == "hybrid" || "$MODE" == "cloud" ) ]]; then
    if [[ "$LLM" == "template" ]]; then
      bad "LLM 可用（llm != template）" "llm=template：反馈/对话会走模板降级" \
          "检查 LLM_API_KEY / LLM_BASE_URL；有意只用模板时加 CHECK_LLM=0"
    else ok "LLM 可用" "llm=$LLM"; fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "5. 示范音（TTS 真的能出音频）"
# ─────────────────────────────────────────────────────────────────────────────
# 用语料里已有的句子：TTS 通常直接命中缓存（x-cache: hit），几乎不产生费用
if [[ "$HAVE_PY" == "1" && -f "$ROOT/web/src/data/sentences.json" ]]; then
  python3 - "$ROOT/web/src/data/sentences.json" "$TMP/sentence.txt" "$TMP/tts.json" <<'PY' 2>/dev/null
import json, sys
src, out_txt, out_json = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src, encoding="utf-8"))
items = d.get("sentences") or d
text = items[0]["text"]
open(out_txt, "w", encoding="utf-8").write(text)
json.dump({"text": text, "rate": "normal", "format": "wav"}, open(out_json, "w", encoding="utf-8"), ensure_ascii=False)
PY
fi
if [[ -s "$TMP/tts.json" ]]; then SENTENCE="$(cat "$TMP/sentence.txt")"
else
  SENTENCE="Hello! My name is Lily."
  printf '{"text":"%s","rate":"normal","format":"wav"}' "$SENTENCE" > "$TMP/tts.json"
fi

TTS_CODE="$(curl -sS --max-time "$TIMEOUT" -o "$TMP/ref.wav" -D "$TMP/tts.h" -w '%{http_code}' \
  -X POST "$VOICE_URL/v1/tts" -H 'Content-Type: application/json' --data-binary "@$TMP/tts.json" 2>/dev/null)"
TTS_SIZE="$(stat -c%s "$TMP/ref.wav" 2>/dev/null || echo 0)"
TTS_CT="$(grep -i '^content-type:' "$TMP/tts.h" 2>/dev/null | tr -d '\r' | cut -d' ' -f2-)"
TTS_CACHE="$(grep -i '^x-cache:' "$TMP/tts.h" 2>/dev/null | tr -d '\r' | cut -d' ' -f2-)"
TTS_PROV="$(grep -i '^x-tts-provider:' "$TMP/tts.h" 2>/dev/null | tr -d '\r' | cut -d' ' -f2-)"
TTS_INFO="provider=${TTS_PROV:-?} cache=${TTS_CACHE:-n/a} bytes=$TTS_SIZE type=${TTS_CT:-n/a}"
if [[ "$TTS_CODE" == "200" && "$TTS_SIZE" -gt 1000 && "$TTS_CT" == audio/* ]]; then
  ok "POST /v1/tts 返回音频" "$TTS_INFO"
elif [[ "$TTS_CODE" == "200" ]]; then
  bad "POST /v1/tts 返回音频" "HTTP 200 但内容不像音频：$TTS_INFO" \
      "docker compose logs voice | grep -i tts；确认 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION"
else
  bad "POST /v1/tts 返回音频" "HTTP ${TTS_CODE:-无响应}" \
      "curl -v -X POST $VOICE_URL/v1/tts -H 'Content-Type: application/json' --data-binary @$TMP/tts.json"
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "6. 评测（真的能出分数）"
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$TTS_SIZE" -le 1000 ]]; then
  skip "POST /v1/pronounce 出分数" "上一步没拿到可用音频（先修好 TTS）"
else
  PR_CODE="$(curl -sS --max-time 90 -o "$TMP/pr.json" -w '%{http_code}' \
    -X POST "$VOICE_URL/v1/pronounce" \
    -F "audio=@$TMP/ref.wav;type=audio/wav" \
    -F "reference_text=$SENTENCE" -F "mode=scripted" -F "granularity=phoneme" 2>/dev/null)"
  PR_LINE="$(python3 - "$TMP/pr.json" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
s = d.get("scores") or {}
p = s.get("pron")
good = isinstance(p, (int, float)) and 0 <= p <= 100
print("%s|%s|%s|%s|%s|%s|%s|%s|%s" % (
    "OK" if good else "BADS",
    d.get("provider"), d.get("granularity"), p,
    s.get("accuracy"), s.get("fluency"), s.get("completeness"),
    ",".join(d.get("warnings") or []) or "-",
    len(d.get("words") or [])))
PY
)"
  IFS='|' read -r PR_OK PR_PROV PR_GRAN PR_PRON PR_ACC PR_FLU PR_COMP PR_WARN PR_WORDS <<<"$PR_LINE"
  if [[ "$PR_CODE" == "200" && "$PR_OK" == "OK" ]]; then
    ok "POST /v1/pronounce 返回有效分数" \
       "provider=$PR_PROV granularity=$PR_GRAN pron=$PR_PRON acc=$PR_ACC flu=$PR_FLU comp=$PR_COMP words=$PR_WORDS warnings=$PR_WARN"
  elif [[ "$PR_CODE" == "200" ]]; then
    bad "POST /v1/pronounce 分数" "HTTP 200 但 scores.pron 不是 0–100 的数（见上面原始响应 $TMP/pr.json）" \
        "契约：不可得的项必须是 null（不是 0/-1）；整句皆 null 说明音频没被识别成语音"
  else
    bad "POST /v1/pronounce" "HTTP ${PR_CODE:-无响应}" \
        "curl -v -X POST $VOICE_URL/v1/pronounce -F audio=@ref.wav -F reference_text='$SENTENCE'；502/504 见 docs/deployment.md §8.5"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "7. 数据目录与磁盘（NAS 上最常见的坑）"
# ─────────────────────────────────────────────────────────────────────────────
if [[ ! -d "$DATA_DIR_HOST" ]]; then
  skip "数据目录 $DATA_DIR_HOST" "目录还不存在（第一次 up 会创建，但属主可能不对）" \
       "mkdir -p $DATA_DIR_HOST && sudo chown -R 1000:1000 $DATA_DIR_HOST"
else
  if [[ -w "$DATA_DIR_HOST" ]]; then ok "数据目录存在且当前用户可写" "$DATA_DIR_HOST"
  else bad "数据目录可写" "$DATA_DIR_HOST 当前用户不可写" \
           "NAS：sudo chown -R 1000:1000 $DATA_DIR_HOST   # web 容器以 node(uid 1000) 运行"; fi
  if [[ "$CONTAINER_MODE" == "1" ]]; then
    if (cd "$DEPLOY_DIR" && docker compose exec -T web sh -c 'test -w /data' >/dev/null 2>&1); then
      ok "容器内 /data 可写（web 以 uid 1000 运行）"
    else
      bad "容器内 /data 可写" "web 容器写不了 /data → 建库/存录音都会失败" \
          "sudo chown -R 1000:1000 $DATA_DIR_HOST && cd deploy && docker compose restart web"
    fi
  fi
  AVAIL_G="$(df -Pk "$DATA_DIR_HOST" 2>/dev/null | awk 'NR==2{printf "%.1f", $4/1048576}')"
  if [[ -n "${AVAIL_G:-}" ]] && awk -v a="$AVAIL_G" 'BEGIN{exit !(a>=2)}'; then
    ok "磁盘余量充足" "剩余 ${AVAIL_G} GB（镜像约 3 GB + 数据增长）"
  else
    bad "磁盘余量" "剩余 ${AVAIL_G:-未知} GB，建议 ≥2 GB" \
        "docker system prune -a；或把 data/ 迁到更大的卷（docs/nas-deployment.md §5）"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "8. 参考音缓存覆盖度（提示项，不阻断）"
# ─────────────────────────────────────────────────────────────────────────────
CACHE_DIR=""
for c in "$DATA_DIR_HOST/cache" "$ROOT/voice/data/cache"; do [[ -d "$c" ]] && CACHE_DIR="$c" && break; done
if [[ -z "$CACHE_DIR" ]]; then
  skip "参考音缓存" "还没有预热：首次跟读会现场合成（慢 + 每次都在花云 TTS 的钱）" \
       "./scripts/warm-corpus.sh    # 见 docs/deployment.md §6.2"
else
  N_AUDIO="$(find "$CACHE_DIR/audio" -type f 2>/dev/null | wc -l | tr -d ' ')"
  N_F0="$(find "$CACHE_DIR/f0" -type f 2>/dev/null | wc -l | tr -d ' ')"
  SZ="$(du -sh "$CACHE_DIR" 2>/dev/null | cut -f1)"
  CORPUS_N="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d.get("sentences") or d))' \
      "$ROOT/web/src/data/sentences.json" 2>/dev/null)"
  WANT=$(( ${CORPUS_N:-300} * 2 ))
  if [[ "${N_AUDIO:-0}" -ge "$WANT" ]]; then
    ok "缓存已覆盖两种语速" "audio=$N_AUDIO（目标 ≥$WANT）f0=$N_F0 体积=$SZ"
  else
    warn "缓存覆盖不足：audio=$N_AUDIO / 目标 ≥$WANT（f0=$N_F0 体积=$SZ）" \
         "未预热时功能正常，只是首次跟读慢、且会重复产生云 TTS 费用" \
         "./scripts/warm-corpus.sh    # 幂等，只补缺失项"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "9. HTTPS（局域网/公网访问必需）"
# ─────────────────────────────────────────────────────────────────────────────
SITE=""
[[ -f "$DEPLOY_DIR/.env" ]] && SITE="$(grep -E '^SITE_ADDRESS=' "$DEPLOY_DIR/.env" | tail -1 | cut -d= -f2 | tr -d ' "')"
CADDY_RUNNING=0
if [[ "$CONTAINER_MODE" == "1" ]] && (cd "$DEPLOY_DIR" && docker compose ps -q caddy 2>/dev/null | grep -q .); then
  CADDY_RUNNING=1
fi
if [[ -n "$EXTERNAL_URL" ]]; then
  # NAS 常见拓扑：DSM/QNAP 自带反向代理（或公网 Caddy）终结 TLS，容器只跑 voice+web
  EXT_CODE="$(curl -skS --max-time 15 -o /dev/null -w '%{http_code}' "${EXTERNAL_URL%/}/healthz" 2>/dev/null)"
  if [[ "$EXT_CODE" == "200" ]]; then ok "外部入口 ${EXTERNAL_URL%/}/healthz 可达（-k 忽略自签）"
  else bad "外部入口 $EXTERNAL_URL" "HTTP ${EXT_CODE:-无响应}" \
           "查反向代理规则：源=https://<域名>:443 → 目标=http://127.0.0.1:3000；证书见 docs/nas-deployment.md §6"; fi
  printf "       %s提示：浏览器里真正访问一次并确认是 https + 锁头，再在 Console 里跑 navigator.mediaDevices 判断麦克风是否可用%s\n" "$C_Y" "$C_0"
elif [[ "$CONTAINER_MODE" != "1" ]]; then
  skip "HTTPS / TLS" "没有在跑的容器；主机直跑用 http://localhost（浏览器把 localhost 当安全上下文，麦克风可用）"
elif [[ "$CADDY_RUNNING" != "1" ]]; then
  skip "HTTPS / TLS" "没有 caddy 容器（EXPECT_SERVICES=\"$EXPECT_SERVICES\"）：TLS 应由 NAS 的反向代理终结" \
       "自检外部入口：EXTERNAL_URL=https://你的域名 ./scripts/check-deploy.sh"
elif [[ -z "$SITE" || "$SITE" == "localhost" ]]; then
  skip "HTTPS / TLS" "SITE_ADDRESS=${SITE:-未设置}：只在宿主机本机访问时可以不要 TLS" \
       "要让手机/平板用麦克风，必须设 SITE_ADDRESS=<局域网IP> 并让设备信任 Caddy internal CA（docs/deployment.md §A.2）"
else
  TLS_CODE="$(curl -skS --max-time 10 -o /dev/null -w '%{http_code}' "https://$SITE/healthz" 2>/dev/null)"
  if [[ "$TLS_CODE" == "200" ]]; then ok "https://$SITE/healthz 可达（-k 忽略自签）"
  else bad "HTTPS 访问 https://$SITE" "HTTP ${TLS_CODE:-无响应}" \
           "cd deploy && docker compose logs --tail=30 caddy；证书不受信见 docs/deployment.md §8.2"; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head2 "10. 镜像构建（本机验证不了时明确跳过）"
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  skip "镜像构建" "本机没有 docker CLI"
elif ! docker info >/dev/null 2>&1; then
  skip "镜像构建" "docker daemon 不可用"
elif (cd "$DEPLOY_DIR" && docker compose images 2>/dev/null | grep -q 'english-coach'); then
  ok "english-coach 镜像已存在" "（本次不重新构建；需要时 docker compose build）"
else
  skip "docker compose build" \
       "尚未构建过镜像。**该项目交付时此项未经实测**：构建要能拉取 node:22-bookworm-slim / python:3.11-slim / caddy:2-alpine" \
       "docker pull node:22-bookworm-slim python:3.11-slim caddy:2-alpine；拉不动见 docs/deployment.md §8.0"
fi

# ─────────────────────────────────────────────────────────────────────────────
printf "\n%s── 汇总 ──%s\n" "$C_B" "$C_0"
printf "  %sPASS %d%s   %sFAIL %d%s   %sWARN %d%s   %sSKIP %d%s\n" \
  "$C_G" "$PASS" "$C_0" "$C_R" "$FAIL" "$C_0" "$C_Y" "$WARN" "$C_0" "$C_Y" "$SKIP" "$C_0"
if [[ "$FAIL" -gt 0 ]]; then
  printf "  失败项：\n"
  for n in "${FAILED_NAMES[@]}"; do printf "    · %s\n" "$n"; done
  printf "\n  排查入口：docs/deployment.md §8（故障排查）· docs/nas-deployment.md（NAS 专属）\n"
  exit "$FAIL"
fi
printf "  %s✔ 没有失败项%s" "$C_G" "$C_0"
[[ "$SKIP" -gt 0 ]] && printf "（%d 项因当前环境不具备条件而跳过，原因见上）" "$SKIP"
printf "\n"
exit 0
