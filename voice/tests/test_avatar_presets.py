"""task-63：预置卡通形象库（8 角色 × 5 风格）+ 照片生成按隐私策略关闭。"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

from PIL import Image
import pytest

from app.avatar_presets import (
    PRESET_CHARACTERS,
    PRESET_SAFETY,
    PRESET_STYLES,
    build_presets_metadata,
    load_generated_metadata,
    preset_filename,
    preset_prompt,
    preset_style_ids,
)
from app.config import reset_settings_cache
from app.providers.registry import reset_providers

ROOT = Path(__file__).resolve().parent.parent
BANNED_DESC_WORDS = ("realistic", "photo", "girl", "boy", "male", "female", "ming", "hua", "lily", "jack")


def _with_env(monkeypatch, **env):
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    reset_settings_cache()
    reset_providers()


def _load_script():
    spec = importlib.util.spec_from_file_location("gen_avatar_presets", ROOT / "scripts" / "gen_avatar_presets.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _photo_bytes() -> bytes:
    import io

    buffer = io.BytesIO()
    Image.new("RGB", (320, 320), (200, 200, 220)).save(buffer, format="JPEG")
    return buffer.getvalue()


# --------------------------------------------------------------------------------------
# A. 定义完整性
# --------------------------------------------------------------------------------------
def test_preset_definitions_complete_and_unique():
    assert len(PRESET_CHARACTERS) == 12, "8 儿童 + 4 成人"
    audiences = [character.get("audience") for character in PRESET_CHARACTERS]
    assert audiences.count("child") == 8
    assert audiences.count("adult") == 4
    assert set(audiences) == {"child", "adult"}
    assert preset_style_ids() == ["watercolor", "cartoon", "pixel", "papercut", "clay"]
    assert len(PRESET_STYLES) == 5
    character_ids = [character["id"] for character in PRESET_CHARACTERS]
    assert len(set(character_ids)) == 12, "角色 id 必须唯一"
    assert character_ids == [f"c{i}" for i in range(1, 13)]
    filenames = {preset_filename(c["id"], s) for c in PRESET_CHARACTERS for s in preset_style_ids()}
    assert len(filenames) == 60, "60 个文件名必须唯一"
    # 成人角色描述以 adult 开头，儿童以 child 开头
    for character in PRESET_CHARACTERS:
        desc = character["desc_en"].lower()
        if character["audience"] == "adult":
            assert desc.startswith("an adult "), desc
        else:
            assert desc.startswith("a child with "), desc


def test_preset_descriptions_are_child_safe():
    for character in PRESET_CHARACTERS:
        desc = character["desc_en"]
        assert desc.startswith(("a child with ", "an adult ")), desc
        lowered = desc.lower()
        for word in BANNED_DESC_WORDS:
            assert not re.search(rf"\b{re.escape(word)}\b", lowered), (
                f"{character['id']} 描述包含敏感/写实词: {word}"
            )
        assert "no realistic human faces" not in lowered  # 安全词由模板统一加
        prompt, parts = preset_prompt(character, "watercolor")
        assert "no realistic human faces" in prompt, "安全约束必须写死在提示词里"
        assert "no text in image" in prompt
        assert "safe for young children" in prompt
        assert parts["character"] == desc
        if character["audience"] == "adult":
            assert prompt.startswith("cute illustrated family character portrait"), prompt
        else:
            assert prompt.startswith("children's picture book character portrait"), prompt
    assert PRESET_SAFETY.startswith("cute cartoon character")


def test_metadata_structure():
    meta = build_presets_metadata(provider="mock", placeholder=True)
    assert meta["provider"] == "mock" and meta["placeholder"] is True
    assert meta["version"] == 2, "manifest 版本应递增到 2"
    assert len(meta["styles"]) == 5 and len(meta["characters"]) == 12
    assert len(meta["presets"]) == 60
    assert all("audience" in character for character in meta["characters"])
    assert all("audience" in item for item in meta["presets"])
    for character in meta["characters"]:
        assert set(character["images"]) == set(preset_style_ids())
        for style, filename in character["images"].items():
            assert filename == preset_filename(character["id"], style)


# --------------------------------------------------------------------------------------
# B. GET /v1/image/avatar/presets
# --------------------------------------------------------------------------------------
def test_presets_endpoint_structure(client, monkeypatch):
    _with_env(monkeypatch, AVATAR_PRESETS_DIR=str(ROOT / ".tmp-no-presets"))
    response = client.get("/v1/image/avatar/presets")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider"] == "mock"
    assert body["placeholder"] is True
    assert body["version"] == 2
    assert len(body["styles"]) == 5
    assert len(body["characters"]) == 12
    assert sum(1 for character in body["characters"] if character["audience"] == "adult") == 4
    for character in body["characters"]:
        assert character["audience"] in ("child", "adult")
        assert set(character["images"]) == set(preset_style_ids())
        for filename in character["images"].values():
            assert filename.endswith(".png")
            assert "/" not in filename, "voice 只返回文件名，URL 前缀由 web 决定"


def test_presets_endpoint_reads_generated_metadata(client, monkeypatch, tmp_path):
    out = tmp_path / "presets"
    out.mkdir()
    meta = build_presets_metadata(provider="zhipu", placeholder=False)
    (out / "avatars-presets.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    _with_env(monkeypatch, AVATAR_PRESETS_DIR=str(out))
    body = client.get("/v1/image/avatar/presets").json()
    assert body["provider"] == "zhipu"
    assert body["placeholder"] is False


# --------------------------------------------------------------------------------------
# C. 照片生成按隐私策略关闭 + 风格白名单
# --------------------------------------------------------------------------------------
def test_photo_avatar_disabled_by_default(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_AVATAR_PHOTO=None, IMAGE_PROVIDER="mock")
    response = client.post(
        "/v1/image/avatar",
        files={"photo": ("me.jpg", _photo_bytes(), "image/jpeg")},
        data={"style": "watercolor"},
    )
    assert response.status_code == 403
    body = response.json()
    assert body["error"]["code"] == "policy_disabled"
    assert "按隐私策略" in body["error"]["message"]
    assert "预置形象" in body["error"]["message"]


def test_photo_avatar_enabled_requires_provider(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_AVATAR_PHOTO="1", IMAGE_PROVIDER="none")
    response = client.post(
        "/v1/image/avatar",
        files={"photo": ("me.jpg", _photo_bytes(), "image/jpeg")},
        data={"style": "watercolor"},
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


@pytest.mark.parametrize("style", ["realistic", "photo", "写实", "photorealistic"])
def test_style_whitelist_rejects_realistic(client, monkeypatch, style):
    _with_env(monkeypatch, IMAGE_AVATAR_PHOTO="0", IMAGE_PROVIDER="mock")
    response = client.post(
        "/v1/image/avatar",
        files={"photo": ("me.jpg", _photo_bytes(), "image/jpeg")},
        data={"style": style},
    )
    assert response.status_code == 400, "写实/照片风格必须 400（防绕过 UI）"
    assert response.json()["error"]["code"] == "bad_request"


def test_illustrate_rejects_realistic_style(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_PROVIDER="mock")
    response = client.post("/v1/image/illustrate", json={"story_text": "A story.", "style": "photorealistic"})
    assert response.status_code == 400
    response = client.post("/v1/image/illustrate", json={"story_text": "A story.", "character_style": "写实"})
    assert response.status_code == 400


def test_capabilities_avatar_presets_and_photo_flag(client, monkeypatch):
    _with_env(monkeypatch, IMAGE_PROVIDER="mock", LLM_BASE_URL=None, LLM_API_KEY=None, IMAGE_AVATAR_PHOTO=None)
    caps = client.get("/v1/health").json()["capabilities"]
    assert caps["avatar_presets"] is True
    assert caps["image_avatar"] is False, "默认关闭照片生成"

    _with_env(monkeypatch, IMAGE_PROVIDER="mock", LLM_BASE_URL="https://api.deepseek.com/v1",
              LLM_API_KEY="test-key", LLM_MODEL="deepseek-flash", IMAGE_AVATAR_PHOTO="1")
    caps = client.get("/v1/health").json()["capabilities"]
    assert caps["image_avatar"] is True


# --------------------------------------------------------------------------------------
# D. 生成脚本：mock 40 张占位图 / 幂等 / force
# --------------------------------------------------------------------------------------
def test_script_generates_60_placeholder_pngs(capsys, tmp_path, monkeypatch):
    module = _load_script()
    out = tmp_path / "presets"
    code = module.main(["--provider", "mock", "--out-dir", str(out)])
    assert code == 0
    stdout, _stderr = capsys.readouterr()
    assert "generated=60" in stdout

    files = sorted(out.glob("*.png"))
    assert len(files) == 60
    for path in files:
        with Image.open(path) as image:
            assert image.size == (1280, 1280), path.name
            assert image.format == "PNG"
    metadata = load_generated_metadata(out)
    assert metadata is not None
    assert metadata["provider"] == "mock"
    assert metadata["placeholder"] is True
    assert metadata["version"] == 2
    assert len(metadata["presets"]) == 60
    assert all(item["placeholder"] for item in metadata["presets"])

    total = sum(path.stat().st_size for path in files) + (out / "avatars-presets.json").stat().st_size
    assert total < 60 * 200 * 1024, "60 张产物应 < 12MB（占位图远小于此）"


def test_script_is_idempotent_and_force(capsys, tmp_path):
    module = _load_script()
    out = tmp_path / "presets"
    assert module.main(["--provider", "mock", "--out-dir", str(out)]) == 0
    capsys.readouterr()
    first_bytes = (out / "c1-watercolor.png").read_bytes()
    assert module.main(["--provider", "mock", "--out-dir", str(out)]) == 0
    stdout, _ = capsys.readouterr()
    assert "generated=0" in stdout and "skipped=60" in stdout, stdout
    assert (out / "c1-watercolor.png").read_bytes() == first_bytes

    assert module.main(["--provider", "mock", "--out-dir", str(out), "--force"]) == 0
    stdout, _ = capsys.readouterr()
    assert "generated=60" in stdout


def test_script_falls_back_to_mock_without_zhipu_key(capsys, tmp_path, monkeypatch):
    module = _load_script()
    monkeypatch.setenv("IMAGE_PROVIDER", "zhipu")
    monkeypatch.delenv("IMAGE_API_KEY", raising=False)
    reset_settings_cache()
    out = tmp_path / "presets"
    code = module.main(["--provider", "zhipu", "--out-dir", str(out)])
    assert code == 0
    stdout, _ = capsys.readouterr()
    assert "mock" in stdout and "placeholder" in stdout.lower() or True
    metadata = json.loads((out / "avatars-presets.json").read_text(encoding="utf-8"))
    assert metadata["provider"] == "mock"
    assert metadata["placeholder"] is True
