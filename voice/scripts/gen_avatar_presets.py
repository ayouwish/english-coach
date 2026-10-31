#!/usr/bin/env python
"""生成预置卡通形象库（task-63）：8 角色 × 5 风格 = 40 张静态 PNG。

产物目录默认 `../web/public/avatars/presets/`：
- `<character>-<style>.png`（1280×1280）
- `avatars-presets.json`（元数据，含每张图的 placeholder 标记）

没有智谱 key（或 `--provider mock`）时用 PIL 生成**占位图**（卡通色块 + 角色/风格标签），
并在元数据里标 `placeholder=true`，方便 web 先跑通 UI；拿到 key 后跑一次真实生成即可覆盖。
幂等：已存在且非占位则跳过（占位图在真实模式下会被覆盖）；`--force` 全部重生成。

真实生成（用户拿到智谱 key 后）：
    IMAGE_PROVIDER=zhipu IMAGE_API_KEY=<key> python scripts/gen_avatar_presets.py --provider zhipu
成本：40 张 × glm-image ≈ ¥0.1/张 ≈ ¥4（一次性）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.avatar_presets import (  # noqa: E402
    PRESET_CHARACTERS,
    PRESET_STYLES,
    build_presets_metadata,
    default_presets_dir,
    load_generated_metadata,
    preset_filename,
    preset_prompt,
    preset_style_ids,
)
from app.config import get_settings  # noqa: E402
from app.image_gen import (  # noqa: E402
    _download_image,
    _mock_image_bytes,
    _zhipu_generate,
    active_provider,
    parse_size,
    validate_and_normalize_image,
)

PLACEHOLDER_LABEL = "placeholder"


def _placeholder_image(character: dict, style: str, size: tuple[int, int]) -> bytes:
    """PIL 占位图：每角色不同主色 + 每风格不同图案 + 小标签（明确是占位）。"""
    import io

    from PIL import Image, ImageDraw

    width, height = size
    digest = hashlib.sha1(f"{character['id']}|{style}".encode()).digest()
    hue = digest[0]
    bg = (235 + hue % 20, 232 + digest[1] % 20, 226 + digest[2] % 20)
    primary = (120 + hue % 120, 110 + digest[1] % 110, 130 + digest[2] % 100)
    secondary = (255 - primary[0] // 2, 200, 180)
    image = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(image)

    if style == "watercolor":
        for index in range(9):
            x = int(width * (0.12 + 0.09 * index)) % width
            y = int(height * (0.18 + 0.07 * (digest[index % 16] / 255.0)))
            radius = width // 9
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=primary if index % 2 else secondary)
    elif style == "cartoon":
        draw.ellipse([width // 6, height // 4, width * 5 // 6, height * 3 // 4], fill=primary,
                     outline=(40, 40, 60), width=12)
        draw.ellipse([width // 3, height // 3, width // 2, height // 2], fill=(255, 255, 255))
        draw.ellipse([width // 2, height // 3, width * 2 // 3, height // 2], fill=(255, 255, 255))
    elif style == "pixel":
        cells = 16
        cell = width // cells
        for row in range(cells):
            for col in range(cells):
                if (row * 7 + col * 13 + digest[row % 16]) % 5 < 2:
                    draw.rectangle([col * cell, row * cell, (col + 1) * cell, (row + 1) * cell], fill=primary)
    elif style == "papercut":
        for index in range(5):
            inset = width // 10 * index
            color = primary if index % 2 == 0 else secondary
            draw.rounded_rectangle([inset, inset, width - inset, height - inset], radius=40, fill=color)
    else:  # clay
        center = (width // 2, height // 2)
        for index in range(6):
            radius = width // 3 - index * width // 16
            color = tuple(min(255, channel + index * 12) for channel in primary)
            draw.ellipse([center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius], fill=color)

    label = f"{character['id']}  {style}  {PLACEHOLDER_LABEL}"
    try:
        from PIL import ImageFont

        font = ImageFont.load_default(size=44)
    except Exception:  # 老版本 Pillow
        font = None
    draw.rectangle([0, height - 90, width, height], fill=(255, 255, 255))
    draw.text((30, height - 78), label, fill=(60, 60, 70), font=font)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _valid_size_image(path: Path, expected: tuple[int, int]) -> bool:
    """已存在文件是否是可解码、尺寸正确的图片（web 侧可能提前放过 64x64 占位图）。"""
    try:
        from PIL import Image

        with Image.open(path) as image:
            return image.size == expected
    except Exception:
        return False


def _resolve_provider(requested: str, settings) -> tuple[str, list[str]]:
    """-> (实际 provider, warnings)。无 key 的 zhipu 自动退 mock（并警告）。"""
    notes: list[str] = []
    value = (requested or "auto").strip().lower()
    if value == "mock":
        return "mock", notes
    configured = (settings.image_provider or "none").strip().lower()
    if value == "auto":
        value = "zhipu" if configured == "zhipu" else "mock"
    if value == "zhipu":
        if configured != "zhipu" or not settings.image_api_key or active_provider(settings) != "zhipu":
            notes.append("没有可用的 Zhipu key（IMAGE_PROVIDER/IMAGE_API_KEY），已回退 mock 占位图")
            return "mock", notes
        return "zhipu", notes
    notes.append(f"未知 provider {requested!r}，已回退 mock")
    return "mock", notes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成预置卡通形象库（8 角色 × 5 风格）")
    parser.add_argument("--provider", default="auto", choices=["auto", "zhipu", "mock"], help="生成方式")
    parser.add_argument("--out-dir", default=None, help="输出目录（默认 web/public/avatars/presets）")
    parser.add_argument("--force", action="store_true", help="全部重新生成")
    parser.add_argument("--json", action="store_true", help="额外输出机器可读 JSON")
    parser.add_argument(
        "--characters",
        default="",
        help="只生成指定角色（逗号分隔，如 c1,c3）；默认全部。用于先少量试水省费用",
    )
    parser.add_argument(
        "--styles",
        default="",
        help="只生成指定风格（逗号分隔，如 watercolor,cartoon）；默认全部",
    )
    args = parser.parse_args(argv)

    settings = get_settings()
    out_dir = Path(args.out_dir).expanduser() if args.out_dir else default_presets_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    provider, notes = _resolve_provider(args.provider, settings)
    expected_size = parse_size(settings.image_size)
    size = f"{expected_size[0]}x{expected_size[1]}"

    existing = load_generated_metadata(out_dir) or {}
    existing_flags = {item.get("file"): bool(item.get("placeholder", True)) for item in existing.get("presets", [])}

    print(f"输出目录 : {out_dir}")
    print(f"生成方式 : {provider}" + ("（占位图）" if provider == "mock" else "（真实智谱）"))
    for note in notes:
        print(f"注意     : {note}")

    generated = skipped = failed = placeholder_count = 0
    total_bytes = 0
    failures: list[str] = []
    presets: list[dict] = []
    wanted_characters = {x.strip() for x in args.characters.split(",") if x.strip()}
    wanted_styles = {x.strip() for x in args.styles.split(",") if x.strip()}
    known_characters = {c["id"] for c in PRESET_CHARACTERS}
    known_styles = set(preset_style_ids())
    unknown_c = wanted_characters - known_characters
    unknown_s = wanted_styles - known_styles
    if unknown_c or unknown_s:
        print(f"错误     : 未知角色 {sorted(unknown_c)} / 未知风格 {sorted(unknown_s)}")
        return 2
    characters = [c for c in PRESET_CHARACTERS if not wanted_characters or c["id"] in wanted_characters]
    styles = [s for s in preset_style_ids() if not wanted_styles or s in wanted_styles]
    if wanted_characters or wanted_styles:
        print(f"采样范围 : 角色 {[c['id'] for c in characters]} × 风格 {styles}（共 {len(characters) * len(styles)} 张）")

    for character in characters:
        for style in styles:
            filename = preset_filename(character["id"], style)
            path = out_dir / filename
            placeholder = provider == "mock"
            existing_placeholder = existing_flags.get(filename)
            skip = False
            if path.is_file() and not args.force and _valid_size_image(path, expected_size):
                if not placeholder and existing_placeholder is False:
                    skip = True  # 真实产物已存在
                elif placeholder and existing_placeholder is not False:
                    skip = True  # 占位图已存在（幂等）
            if skip:
                skipped += 1
                total_bytes += path.stat().st_size
                presets.append({
                    "id": f"{character['id']}-{style}",
                    "character_id": character["id"],
                    "style": style,
                    "file": filename,
                    "placeholder": bool(existing_placeholder if existing_placeholder is not None else placeholder),
                })
                continue
            try:
                if provider == "zhipu":
                    prompt, _parts = preset_prompt(character, style)
                    url, _extra = _zhipu_generate(prompt, size, settings)
                    raw = _download_image(url, settings)
                    data, _w, _h = validate_and_normalize_image(raw, expected_size)
                else:
                    data = _placeholder_image(character, style, expected_size)
                temp_path = path.with_name(path.name + f".{time.time_ns()}.tmp")
                temp_path.write_bytes(data)
                temp_path.replace(path)
                generated += 1
                placeholder_count += 1 if placeholder else 0
                total_bytes += len(data)
                presets.append({
                    "id": f"{character['id']}-{style}",
                    "character_id": character["id"],
                    "style": style,
                    "file": filename,
                    "placeholder": placeholder,
                })
            except Exception as exc:  # 单张失败不中断
                failed += 1
                failures.append(f"{filename}: {type(exc).__name__}: {exc}")
                print(f"  失败: {filename}: {type(exc).__name__}: {exc}")

    metadata = build_presets_metadata(provider=provider, placeholder=(placeholder_count > 0 or provider == "mock"), image_size=size)
    metadata["generated_at"] = datetime.now(timezone.utc).isoformat()
    metadata["presets"] = presets
    for character in metadata["characters"]:
        for style, filename in character["images"].items():
            entry = next((item for item in presets if item["file"] == filename), None)
            character.setdefault("placeholder", {})[style] = bool(entry["placeholder"]) if entry else provider == "mock"
    meta_path = out_dir / "avatars-presets.json"
    temp_meta = meta_path.with_name(meta_path.name + f".{time.time_ns()}.tmp")
    temp_meta.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_meta.replace(meta_path)
    total_bytes += meta_path.stat().st_size

    print(
        f"结果     : generated={generated} skipped={skipped} failed={failed} "
        f"placeholder={placeholder_count} | 总大小={total_bytes/1024:.0f}KB ({total_bytes/1024/1024:.2f}MB)"
    )
    if provider == "zhipu":
        print(f"成本估算 : 本次真实生成 {generated} 张 × ¥0.1 ≈ ¥{generated * 0.1:.1f}")
    else:
        print("下一步   : 拿到智谱 key 后运行 `IMAGE_PROVIDER=zhipu IMAGE_API_KEY=… python scripts/gen_avatar_presets.py --provider zhipu --force` 覆盖占位图")
    print(f"元数据   : {meta_path}")
    if failures:
        print(f"失败文件（{len(failures)}）:", file=sys.stderr)
        for line in failures[:20]:
            print(f"  - {line}", file=sys.stderr)
    if args.json:
        print(json.dumps({"provider": provider, "generated": generated, "skipped": skipped,
                          "failed": failed, "placeholder": placeholder_count,
                          "total_bytes": total_bytes}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
