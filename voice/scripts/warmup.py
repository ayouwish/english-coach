#!/usr/bin/env python
"""批量预热参考音 + 参考 F0 缓存（契约 v1.1 §12）。

用法（在 voice/ 目录下）：

    # 在进程内直接预热（不需要起服务）
    .venv/bin/python scripts/warmup.py --text-file corpus/sentences.txt --concurrency 2

    # 从 JSON 清单读（支持 ["句子", ...] / [{"text","voice","rate"}, ...] / {"items":[...]}）
    .venv/bin/python scripts/warmup.py --items corpus/warmup.json

    # 打一个已经在跑的服务
    .venv/bin/python scripts/warmup.py --items corpus/warmup.json --url http://127.0.0.1:8100

建议：**每次语料变化后跑一次**（新增/改动了句子、换了 voice 或 rate 都要重跑），
按 text 变更做增量预热即可；重复条目会被自动跳过（skipped_duplicates）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_items(path: str, default_voice: str | None, default_rate: str) -> list[dict]:
    raw = Path(path).read_text(encoding="utf-8")
    if path.endswith(".json"):
        data = json.loads(raw)
        if isinstance(data, dict):
            data = data.get("items") or []
        entries = data
    else:
        entries = [line.strip() for line in raw.splitlines() if line.strip() and not line.strip().startswith("#")]

    items: list[dict] = []
    for entry in entries:
        if isinstance(entry, str):
            items.append({"text": entry, "voice": default_voice, "rate": default_rate})
        elif isinstance(entry, dict):
            items.append(
                {
                    "text": entry.get("text") or "",
                    "voice": entry.get("voice", default_voice),
                    "rate": entry.get("rate", default_rate) or "normal",
                }
            )
        else:
            raise SystemExit(f"unsupported item: {entry!r}")
    return items


def post_to_service(url: str, items: list[dict], concurrency: int) -> dict:
    import httpx

    endpoint = url.rstrip("/")
    if not endpoint.endswith("/v1/warmup"):
        endpoint = f"{endpoint}/v1/warmup"
    response = httpx.post(endpoint, json={"items": items, "concurrency": concurrency}, timeout=600.0)
    response.raise_for_status()
    return response.json()


def run_in_process(items: list[dict], concurrency: int) -> dict:
    from app.cache import get_cache
    from app.providers.registry import get_providers
    from app.warmup import WarmupItemSpec, run_warmup

    specs = [WarmupItemSpec(text=item["text"], voice=item.get("voice") or "", rate=item.get("rate") or "normal") for item in items]
    return run_warmup(specs, concurrency, cache=get_cache(), providers=get_providers())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="预热 voice 的参考音 / 参考 F0 缓存")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--items", help="JSON 清单文件")
    source.add_argument("--text-file", help="纯文本清单（每行一句，# 开头为注释）")
    parser.add_argument("--url", help="打已在运行的服务（缺省则在进程内预热）")
    parser.add_argument("--concurrency", type=int, default=2, help="1–8，默认 2")
    parser.add_argument("--voice", default=None, help="清单里没写 voice 时使用的音色（默认 provider 默认音色）")
    parser.add_argument("--rate", default="normal", choices=("slow", "normal"))
    parser.add_argument("--json", action="store_true", help="额外打印原始响应 JSON")
    args = parser.parse_args(argv)

    path = args.items or args.text_file
    items = load_items(path, args.voice, args.rate)
    if not items:
        print("no items to warm up", file=sys.stderr)
        return 2

    if args.url:
        stats = post_to_service(args.url, items, args.concurrency)
    else:
        from app.config import get_settings

        settings = get_settings()
        # voice 为空 -> 用 provider 默认音色，保证与 /v1/pronounce 的 key 一致
        for item in items:
            if not item.get("voice"):
                item["voice"] = settings.default_tts_voice
        stats = run_in_process(items, args.concurrency)

    failed = stats.get("failed") or []
    print(f"requested          : {stats.get('requested')}")
    print(f"generated          : {stats.get('generated')}")
    print(f"cached             : {stats.get('cached')}")
    print(f"failed             : {len(failed)}")
    print(f"skipped_duplicates : {stats.get('skipped_duplicates')}")
    print(f"elapsed_ms         : {stats.get('elapsed_ms')}")
    cache = stats.get("cache") or {}
    print(f"cache              : audio_entries={cache.get('audio_entries')} f0_entries={cache.get('f0_entries')} bytes={cache.get('bytes')}")
    for item in failed[:10]:
        print(f"  ! {item.get('error')}: {str(item.get('text'))[:60]}")
    if args.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
