#!/usr/bin/env python3
"""大模型（对话）接入自检 —— 一条命令回答三个问题

1. **LLM 到底配好没有**（现在是走大模型，还是仍在下意识地念模板台词）
2. 配好之后，**回复质量是否在线**（是否回应了你说的话、长度/建议回复是否合规、有没有中文翻译）
3. 没配好时，**具体该怎么配**（给出可复制的三行配置与成本量级）

为什么需要它：`/v1/dialogue` 在 LLM 不可用时会**自动降级成 `template`**（按轮次念固定台词），
这不会报错——如果没人告诉你，你会以为"这就是智能对话"。本脚本把这件事显式化。

用法：
  cd voice && .venv/bin/python ../tests/llm_selfcheck.py
  BASE=http://127.0.0.1:8100 .venv/bin/python ../tests/llm_selfcheck.py

退出码：0 = 大模型已生效且质量检查通过；1 = 未配置 / 有质量问题。
**本脚本永不打印密钥。**
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOICE = ROOT / "voice"
BASE = os.environ.get("BASE", "http://127.0.0.1:8100").rstrip("/")

# 一个给 8 岁孩子用的场景；三句话都是"会有具体内容可回应"的话，用来检验连续性
SCENARIO = {
    "id": "self_intro",
    "title": "Meet a new friend",
    "title_zh": "认识新朋友",
    "setting_zh": "你在公园遇到一个同龄小朋友，对方先跟你打招呼。",
    "role_prompt": "You are Sam, a friendly 8-year-old. Ask simple A1 questions, one at a time.",
    "opening_line": "Hi! I'm Sam. What's your name?",
    "level": "A1",
    "min_age": 6,
}
LEARNER = {"age_band": "child", "level": "A1", "native_language": "zh", "child_safe": True}

TURNS = [
    "My name is Lily. I am eight.",
    "I like drawing cats and dogs.",
    "I have a red bike. It is very fast.",
]

# 这些是模板兜底的典型空泛句；如果大模型也说这些，说明它没在听
GENERIC_PATTERNS = [
    r"tell me more",
    r"that sounds good",
    r"what happened next",
    r"nice! tell me",
]

problems: list[str] = []
notes: list[str] = []


def ok(m: str) -> None:
    print(f"  \033[32m✓\033[0m {m}")


def bad(m: str) -> None:
    problems.append(m)
    print(f"  \033[31m✗\033[0m {m}")


def warn(m: str) -> None:
    notes.append(m)
    print(f"  \033[33m!\033[0m {m}")


def mask(v: str | None) -> str:
    if not v:
        return "<空>"
    return f"<已设置，{len(v)} 字符，前 4 位 {v[:4]}…>"


def http(path: str, payload: dict | None = None, timeout: int = 60):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{BASE}{path}", data=data, method="POST" if data else "GET",
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")[:200]}
    except Exception as e:  # noqa: BLE001
        return None, {"error": str(e)}


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z']+", text or ""))


def main() -> int:
    print("=" * 78)
    print("大模型对话接入自检")
    print("=" * 78)

    # ---------- 1. 配置 ----------
    print("\n[1] LLM 配置")
    sys.path.insert(0, str(VOICE))
    try:
        from app.config import _load_dotenv, get_settings  # type: ignore

        loaded = _load_dotenv()
        s = get_settings()
        print(f"    配置文件      : {loaded or '(未找到 voice/.env，使用真实环境变量)'}")
        print(f"    LLM_BASE_URL  : {s.llm_base_url or '<未设置>'}")
        print(f"    LLM_API_KEY   : {mask(getattr(s, 'llm_api_key', None))}")
        print(f"    LLM_MODEL     : {s.llm_model or '<未设置>'}")
    except Exception as exc:  # noqa: BLE001
        warn(f"无法读取 voice 配置：{exc}")

    # ---------- 2. health ----------
    print("\n[2] voice 服务报告的 provider")
    status, health = http("/v1/health", timeout=10)
    if status != 200:
        bad(f"voice 服务不可达（{BASE}/v1/health → {status}）。先启动它再跑本脚本")
        return finish()
    providers = health.get("providers") or {}
    print(f"    providers = {providers}")
    if providers.get("llm") in (None, "template"):
        bad("对话仍在走 template（固定话术）——**没有调用大模型**")
        print_setup_guide()
        return finish()
    ok(f"对话走大模型：{providers.get('llm')}")

    # ---------- 3. 三轮真实对话 ----------
    print("\n[3] 三轮对话（儿童场景，看它是否真的在听）")
    history = [{"role": "assistant", "text": SCENARIO["opening_line"]}]
    print(f"    Sam: {SCENARIO['opening_line']}")
    used_providers: list[str] = []
    for idx, user_text in enumerate(TURNS):
        payload = {
            "scenario": SCENARIO,
            "learner": LEARNER,
            "history": history,
            "correction_level": "gentle",
            "turn_index": idx,
        }
        status, resp = http("/v1/dialogue", payload)
        if status != 200:
            bad(f"第 {idx + 1} 轮 /v1/dialogue 失败：{status} {resp.get('error')}")
            return finish()
        reply = resp.get("reply") or ""
        zh = resp.get("reply_zh") or ""
        sugg = resp.get("suggested_replies") or []
        corr = resp.get("correction") or {}
        prov = resp.get("provider") or "?"
        used_providers.append(prov)

        print(f"\n    你说: {user_text}")
        print(f"    Sam : {reply}")
        print(f"    译文: {zh}")
        if sugg:
            print(f"    建议: {' / '.join(sugg)}")
        if corr.get("has_error"):
            print(f"    纠错: {corr.get('original')} → {corr.get('better')}  （{corr.get('explain_zh')}）")

        # 逐轮检查
        if word_count(reply) > 12:
            warn(f"第 {idx + 1} 轮回复 {word_count(reply)} 词，超过儿童场景的 12 词上限")
        if not zh:
            bad(f"第 {idx + 1} 轮缺中文翻译（儿童需要）")
        if not (2 <= len(sugg) <= 3):
            bad(f"第 {idx + 1} 轮 suggested_replies 数量 = {len(sugg)}（应为 2–3）")
        low = reply.lower()
        if any(re.search(p, low) for p in GENERIC_PATTERNS):
            warn(f"第 {idx + 1} 轮出现空泛万能句：{reply!r}（说明它没在回应你说的内容）")
        if prov == "template":
            bad(f"第 {idx + 1} 轮降级成了 template")
        if resp.get("degraded_llm") is True:
            warn(f"第 {idx + 1} 轮标记 degraded_llm=true")

        history.append({"role": "user", "text": user_text})
        history.append({"role": "assistant", "text": reply})

    # ---------- 4. 结论 ----------
    print("\n[4] 结论")
    used = sorted(set(used_providers))
    if used == ["template"]:
        bad("三轮全部由 template 产出——大模型没有被调用")
    else:
        ok(f"回复来自: {', '.join(used)}")
    # 连续性：把学习者说过的实词和回复做重叠检查
    user_words = {w.lower() for t in TURNS for w in re.findall(r"[A-Za-z']{3,}", t)} - {
        "the", "and", "very", "with", "have", "like", "name", "what", "you", "your",
    }
    reply_text = " ".join(h["text"].lower() for h in history if h["role"] == "assistant")
    overlap = sorted(w for w in user_words if w in reply_text)
    if overlap:
        ok(f"连续性检查：回复里出现了你说过的词 {overlap}")
    else:
        warn("连续性检查：回复里没有出现你说过的任何实词（可能没在认真听）")

    return finish()


def print_setup_guide() -> None:
    print("\n    —— 怎么配（三行，填进 voice/.env 后**重启 voice**）——")
    print("""
    # 方案 A（推荐，最便宜）：DeepSeek
    LLM_BASE_URL=https://api.deepseek.com/v1
    LLM_API_KEY=sk-你的key
    LLM_MODEL=deepseek-chat

    # 方案 B：阿里云百炼 / 通义（OpenAI 兼容端点）
    # LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
    # LLM_MODEL=qwen-plus

    # 方案 C：本地 Ollama（免费但慢；本机无 GPU，7B 约 5–10 字/秒）
    # LLM_BASE_URL=http://localhost:11434/v1
    # LLM_API_KEY=ollama
    # LLM_MODEL=qwen2.5:3b
    """)
    print("    成本量级：一家人每天聊 20–30 轮 ≈ 每月几元人民币（DeepSeek flash 更便宜）。")
    print("    ⚠️ 注意：密钥只放 voice/.env，web 与浏览器都不持有；改完必须重启 voice 才生效。")


def finish() -> int:
    print("\n" + "=" * 78)
    if problems:
        print(f"\033[31m发现 {len(problems)} 个问题：\033[0m")
        for p in problems:
            print(f"  ✗ {p}")
    else:
        print("\033[32m通过：大模型已生效，回复质量检查无硬性问题。\033[0m")
    if notes:
        print("\n提示（不阻断）：")
        for n in notes:
            print(f"  ! {n}")
    print("=" * 78)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
