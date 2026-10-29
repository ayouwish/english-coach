#!/usr/bin/env python
"""原地裁剪旧 TTS 缓存里的 WAV 首尾静音（task-39 的存量数据修复，task-41）。

背景：`/v1/tts` 从 task-39 起会对 WAV 输出裁首尾静音，但**升级前写入的缓存文件仍是未裁剪的**
（Azure 短词尾部带 ~1.3s 低电平噪声，用户听到的"拖沓/浑浊"就来自它们）。
缓存文件名是 `sha1(key)`，没有反向映射；升 KEY_VERSION 会让全部缓存失效、必须重新预热（花 Azure 钱）。
所以这里**原地裁剪**：只改文件内容、**保留原文件名**，缓存 key 不变 → 继续命中。

用法（容器内）：
    docker compose exec -T voice python scripts/trim_cache.py
本机（显式指定数据目录，避免误碰生产缓存）：
    python scripts/trim_cache.py --data-dir /data --dry-run
    python scripts/trim_cache.py --data-dir /data

行为：
- 只遍历 `<DATA_DIR>/cache/audio/*.wav`（**不碰 mp3、不碰 cache/f0/**，不跟随符号链接）
- 有变化 → 写临时文件后 `os.replace` 原子替换（保留文件名）
- 无变化（已裁剪 / 非 PCM16 单声道 / 解析不出）→ 跳过
- 单文件异常 → 计入 `failed` 并继续；有 failed 时退出码 1
- 幂等：第二次运行 `trimmed=0`
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.audio_io import probe_audio, trim_wav_silence  # noqa: E402
from app.config import get_settings  # noqa: E402


def _is_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def _collect_wavs(audio_dir: Path, limit: int = 0) -> list[Path]:
    """按文件名排序收集 wav；不跟随符号链接。"""
    files: list[Path] = []
    for path in sorted(audio_dir.glob("*.wav")):
        if path.is_symlink():
            continue
        files.append(path)
        if limit and len(files) >= limit:
            break
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="原地裁剪缓存 WAV 首尾静音（保留文件名/key）")
    parser.add_argument("--data-dir", default=None, help="DATA_DIR（默认取 settings.data_dir）")
    parser.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 个 wav（调试用）")
    parser.add_argument("--threshold-db", type=float, default=None, help="静音阈值 dBFS（默认取 settings）")
    parser.add_argument("--keep-ms", type=int, default=None, help="首尾保留余量 ms（默认取 settings）")
    parser.add_argument("--json", action="store_true", help="额外输出机器可读 JSON")
    args = parser.parse_args(argv)

    settings = get_settings()
    data_dir = Path(args.data_dir).expanduser() if args.data_dir else Path(settings.data_dir)
    threshold_db = settings.tts_trim_threshold_db if args.threshold_db is None else args.threshold_db
    keep_ms = settings.tts_trim_keep_ms if args.keep_ms is None else args.keep_ms
    audio_dir = data_dir / "cache" / "audio"

    print(f"DATA_DIR : {data_dir}")
    print(f"audio 目录: {audio_dir}")
    print(f"参数     : threshold={threshold_db}dBFS keep={keep_ms}ms dry_run={args.dry_run} limit={args.limit or 'all'}")
    if not audio_dir.is_dir():
        print(f"错误：找不到 {audio_dir}（DATA_DIR 是否指对了？）", file=sys.stderr)
        return 2

    files = _collect_wavs(audio_dir, args.limit)
    stats = {"scanned": 0, "trimmed": 0, "skipped": 0, "failed": 0, "saved_ms": 0.0,
             "before_ms": 0.0, "after_ms": 0.0, "ignored_mp3": len(list(audio_dir.glob("*.mp3")))}
    failures: list[str] = []

    for path in files:
        stats["scanned"] += 1
        try:
            data = path.read_bytes()
            if not _is_wav(data):
                raise ValueError("不是 RIFF/WAVE 文件（扩展名是 .wav 但内容不是）")
            before = probe_audio(data).duration_ms
            trimmed, changed = trim_wav_silence(data, threshold_db=threshold_db, keep_ms=keep_ms)
            if not changed:
                stats["skipped"] += 1
                stats["before_ms"] += before
                stats["after_ms"] += before
                continue
            after = probe_audio(trimmed).duration_ms
            stats["before_ms"] += before
            stats["after_ms"] += after
            stats["saved_ms"] += max(0, before - after)
            stats["trimmed"] += 1
            if args.dry_run:
                continue
            temp_path = path.with_name(path.name + ".trimtmp")
            try:
                temp_path.write_bytes(trimmed)
                temp_path.replace(path)  # 同目录原子替换，文件名/key 不变
            finally:
                try:
                    if temp_path.exists():
                        temp_path.unlink()
                except OSError:
                    pass
        except Exception as exc:  # 单文件失败不中断
            stats["failed"] += 1
            failures.append(f"{path.name}: {type(exc).__name__}: {exc}")
            continue

    saved_s = stats["saved_ms"] / 1000.0
    print(
        f"结果     : scanned={stats['scanned']} trimmed={stats['trimmed']} skipped={stats['skipped']} "
        f"failed={stats['failed']}（另有 {stats['ignored_mp3']} 个 mp3 未处理）"
    )
    print(
        f"总时长   : {stats['before_ms']/1000.0:.2f}s -> {stats['after_ms']/1000.0:.2f}s "
        f"（节省 {saved_s:.2f}s = {stats['saved_ms']:.0f}ms，平均每个裁剪 {stats['saved_ms']/stats['trimmed'] if stats['trimmed'] else 0:.0f}ms）"
    )
    if args.dry_run:
        print("dry-run  : 未写入任何文件")
    if failures:
        print(f"失败文件（{len(failures)}）:", file=sys.stderr)
        for line in failures[:20]:
            print(f"  - {line}", file=sys.stderr)
        if len(failures) > 20:
            print(f"  ... 其余 {len(failures) - 20} 个省略", file=sys.stderr)
    if args.json:
        print(json.dumps(stats, ensure_ascii=False))
    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
