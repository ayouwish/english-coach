"""预置卡通形象库（task-63）：8 个角色 × 5 种风格 = 40 张静态图。

用户决定「不接受照片上云」→ 不拍照、不上传，孩子从预置形象里做选择题。
形象一致性仍走「角色卡（英文外观描述）+ 固定风格词」：这里的 `desc_en` 就是预置角色卡，
web 把它存下来，生成故事插画时作为 `character_desc`/`character_style` 传给 `/v1/image/illustrate`。

产物：`../web/public/avatars/presets/<character>-<style>.png` + `avatars-presets.json`
（由 `scripts/gen_avatar_presets.py` 生成；没有 Zhipu key 时用 mock 占位图并标 `placeholder=true`）。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .image_gen import ALLOWED_STYLES, STYLE_PRESETS, style_phrase

# 儿童绘本插画风写死的安全后缀（禁止写实人脸/图内文字）
PRESET_SAFETY = "cute cartoon character, no realistic human faces, no text in image, safe for young children"
PRESET_SCENE = "friendly smile, upper body, plain soft background"

PRESET_STYLES: list[dict] = [
    {"id": "watercolor", "label_zh": "水彩"},
    {"id": "cartoon", "label_zh": "卡通"},
    {"id": "pixel", "label_zh": "像素"},
    {"id": "papercut", "label_zh": "剪纸"},
    {"id": "clay", "label_zh": "黏土"},
]

# 8 个预置角色：只用 "a child"，不含性别敏感词/真实姓名/其他敏感属性
PRESET_CHARACTERS: list[dict] = [
    {"id": "c1", "label_zh": "短发小圆脸", "desc_en": "a child with short black bob hair, round face, red hoodie"},
    {"id": "c2", "label_zh": "马尾圆眼镜", "desc_en": "a child with black ponytail hair, oval face, round glasses, yellow t-shirt"},
    {"id": "c3", "label_zh": "棕色卷发", "desc_en": "a child with curly brown hair, light freckles, blue sweater"},
    {"id": "c4", "label_zh": "双马尾", "desc_en": "a child with dark brown twin tails, pink dress"},
    {"id": "c5", "label_zh": "平头绿外套", "desc_en": "a child with short flat black hair, green jacket"},
    {"id": "c6", "label_zh": "长发蝴蝶结", "desc_en": "a child with long black hair and a hair bow, purple top"},
    {"id": "c7", "label_zh": "栗色短发眼镜", "desc_en": "a child with short chestnut hair, square glasses, white shirt"},
    {"id": "c8", "label_zh": "丸子头橙围巾", "desc_en": "a child with a top bun, orange scarf, cream sweater"},
]

PRESETS_DIR_ENV = "AVATAR_PRESETS_DIR"
_EPS = 1e-9


def preset_style_ids() -> list[str]:
    return [item["id"] for item in PRESET_STYLES]


def preset_filename(character_id: str, style: str) -> str:
    return f"{character_id}-{style}.png"


def preset_prompt(character: dict, style: str) -> tuple[str, dict]:
    """预置头像的最终提示词 + prompt_parts（安全后缀写死，调用方不能覆盖）。"""
    phrase = style_phrase(style)
    prompt = (
        f"children's picture book character portrait, {phrase}, {character['desc_en']}, "
        f"{PRESET_SCENE}, {PRESET_SAFETY}"
    )
    return prompt, {
        "style": phrase,
        "character": character["desc_en"],
        "scene": PRESET_SCENE,
        "safety": PRESET_SAFETY,
    }


def default_presets_dir() -> Path:
    """默认输出目录：仓库根的 `web/public/avatars/presets`（可用 AVATAR_PRESETS_DIR 覆盖）。"""
    override = os.environ.get(PRESETS_DIR_ENV)
    if override:
        return Path(override)
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / "web" / "public" / "avatars" / "presets"


def metadata_path(out_dir: Path | None = None) -> Path:
    return (out_dir or default_presets_dir()) / "avatars-presets.json"


def build_presets_metadata(*, provider: str = "mock", placeholder: bool = True, image_size: str = "1280x1280") -> dict:
    characters = []
    presets = []
    for character in PRESET_CHARACTERS:
        images = {}
        for style in preset_style_ids():
            filename = preset_filename(character["id"], style)
            images[style] = filename
            presets.append(
                {
                    "id": f"{character['id']}-{style}",
                    "character_id": character["id"],
                    "style": style,
                    "file": filename,
                    "placeholder": placeholder,
                }
            )
        characters.append({**character, "images": images})
    return {
        "version": 1,
        "provider": provider,
        "placeholder": placeholder,
        "image_size": image_size,
        "styles": PRESET_STYLES,
        "characters": characters,
        "presets": presets,
    }


def load_generated_metadata(out_dir: Path | None = None) -> dict | None:
    path = metadata_path(out_dir)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def presets_for_api(out_dir: Path | None = None) -> dict:
    """GET /v1/image/avatar/presets 的响应：静态定义 + 是否已生成（placeholder 标记）。

    voice 只返回**文件名**；web 决定 URL 前缀（例如 `/avatars/presets/<file>`）。
    """
    generated = load_generated_metadata(out_dir)
    if generated and generated.get("characters"):
        placeholder = bool(generated.get("placeholder", True))
        return {
            "provider": generated.get("provider", "mock"),
            "placeholder": placeholder,
            "image_size": generated.get("image_size", "1280x1280"),
            "styles": generated.get("styles") or PRESET_STYLES,
            "characters": generated["characters"],
        }
    data = build_presets_metadata(provider="mock", placeholder=True)
    data.pop("presets", None)
    data.pop("version", None)
    return data
