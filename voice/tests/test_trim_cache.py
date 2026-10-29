"""task-41：`scripts/trim_cache.py` 原地裁剪旧 TTS 缓存（临时 DATA_DIR，绝不碰 voice/data）。"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import numpy as np
import pytest

from app.audio_io import pcm16_wav_bytes, probe_audio, wav_speech_span_ms

ROOT = Path(__file__).resolve().parent.parent
SR = 24000


def _load_script():
    spec = importlib.util.spec_from_file_location("trim_cache_script", ROOT / "scripts" / "trim_cache.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _padded_wav(speech_s: float = 0.19, leading_s: float = 0.30, trailing_s: float = 1.33) -> bytes:
    total = int((leading_s + speech_s + trailing_s) * SR)
    samples = np.zeros(total, dtype=np.float32)
    start = int(leading_s * SR)
    t = np.arange(int(speech_s * SR)) / SR
    samples[start : start + t.size] = 0.25 * np.sin(2 * np.pi * 220.0 * t)
    return pcm16_wav_bytes(samples, SR)


def _trimmed_wav() -> bytes:
    trimmed, _ = _load_script().trim_wav_silence(_padded_wav())
    return trimmed


@pytest.fixture
def cache_dir(tmp_path: Path) -> Path:
    audio = tmp_path / "cache" / "audio"
    audio.mkdir(parents=True)
    (tmp_path / "cache" / "f0").mkdir()
    return audio


def _run(capsys, argv):
    module = _load_script()
    code = module.main(argv)
    out, err = capsys.readouterr()
    return code, out, err


# --------------------------------------------------------------------------------------
# 基本：带静音被裁、已裁剪不变、mp3 不碰
# --------------------------------------------------------------------------------------
def test_trims_padded_keeps_trimmed_and_mp3(capsys, tmp_path, cache_dir):
    padded = cache_dir / "a_padded.wav"
    padded.write_bytes(_padded_wav())
    already = cache_dir / "b_trimmed.wav"
    already.write_bytes(_trimmed_wav())
    mp3 = cache_dir / "c_song.mp3"
    mp3.write_bytes(b"ID3\x04\x00" + b"\x00" * 200)
    f0 = tmp_path / "cache" / "f0" / "x.json"
    f0.write_text('{"times_ms":[]}', encoding="utf-8")

    code, out, _err = _run(capsys, ["--data-dir", str(tmp_path)])
    assert code == 0, out
    assert "scanned=2" in out and "trimmed=1" in out and "skipped=1" in out and "failed=0" in out
    assert "节省" in out

    before = probe_audio(_padded_wav()).duration_ms
    after = probe_audio(padded.read_bytes()).duration_ms
    assert after == pytest.approx(290, abs=20), "带静音的文件应被裁到语音段+余量"
    assert after < before / 3
    # 语音段保留
    span = wav_speech_span_ms(padded.read_bytes())
    assert span is not None and span[2] == pytest.approx(190, abs=20)
    # 已裁剪文件字节完全不变（幂等基础）
    assert already.read_bytes() == _trimmed_wav()
    # mp3 与 f0 完全不动
    assert mp3.read_bytes() == b"ID3\x04\x00" + b"\x00" * 200
    assert f0.read_text(encoding="utf-8") == '{"times_ms":[]}'
    # 文件名不变（key 不变）
    assert sorted(p.name for p in cache_dir.iterdir()) == ["a_padded.wav", "b_trimmed.wav", "c_song.mp3"]
    assert not [p for p in cache_dir.iterdir() if p.name.endswith(".trimtmp")]


def test_idempotent_second_run_trims_nothing(capsys, tmp_path, cache_dir):
    target = cache_dir / "a_padded.wav"
    target.write_bytes(_padded_wav())
    code, out1, _ = _run(capsys, ["--data-dir", str(tmp_path)])
    assert code == 0 and "trimmed=1" in out1
    first_bytes = target.read_bytes()
    code, out2, _ = _run(capsys, ["--data-dir", str(tmp_path)])
    assert code == 0
    assert "trimmed=0" in out2 and "skipped=1" in out2
    assert target.read_bytes() == first_bytes, "第二次运行不应再改文件"
    assert "节省 0.00s" in out2


def test_dry_run_does_not_write(capsys, tmp_path, cache_dir):
    target = cache_dir / "a_padded.wav"
    raw = _padded_wav()
    target.write_bytes(raw)
    code, out, _ = _run(capsys, ["--data-dir", str(tmp_path), "--dry-run"])
    assert code == 0
    assert "trimmed=1" in out and "dry-run" in out
    assert target.read_bytes() == raw, "dry-run 不允许写文件"


def test_limit_processes_only_first_n(capsys, tmp_path, cache_dir):
    for name in ("a.wav", "b.wav", "c.wav"):
        (cache_dir / name).write_bytes(_padded_wav())
    code, out, _ = _run(capsys, ["--data-dir", str(tmp_path), "--limit", "1"])
    assert code == 0
    assert "scanned=1" in out and "trimmed=1" in out
    trimmed_count = sum(1 for name in ("a.wav", "b.wav", "c.wav")
                        if probe_audio((cache_dir / name).read_bytes()).duration_ms < 600)
    assert trimmed_count == 1, "只应处理排序后的第一个文件"


def test_corrupt_file_fails_but_others_processed(capsys, tmp_path, cache_dir):
    broken = cache_dir / "a_broken.wav"
    broken.write_bytes(b"RIFF\x00\x00\x00\x00WAVEjunkjunkjunk")
    good = cache_dir / "b_padded.wav"
    good.write_bytes(_padded_wav())
    code, out, err = _run(capsys, ["--data-dir", str(tmp_path)])
    assert code == 1, "有 failed 时退出码必须非 0"
    assert "failed=1" in out and "trimmed=1" in out
    assert broken.read_bytes() == b"RIFF\x00\x00\x00\x00WAVEjunkjunkjunk", "损坏文件不应被改写"
    assert probe_audio(good.read_bytes()).duration_ms == pytest.approx(290, abs=20), "其它文件仍要处理"
    assert "a_broken.wav" in err  # 失败文件列到 stderr


def test_non_wav_content_with_wav_extension_counts_failed(capsys, tmp_path, cache_dir):
    fake = cache_dir / "fake.wav"
    fake.write_bytes(b"this is not a wav at all")
    code, out, _ = _run(capsys, ["--data-dir", str(tmp_path)])
    assert code == 1
    assert "failed=1" in out


def test_missing_audio_dir_exits_nonzero(capsys, tmp_path):
    code, out, err = _run(capsys, ["--data-dir", str(tmp_path / "nope")])
    assert code == 2
    assert "找不到" in err


def test_symlink_is_not_followed(capsys, tmp_path, cache_dir):
    real = tmp_path / "outside.wav"
    real.write_bytes(_padded_wav())
    link = cache_dir / "link.wav"
    try:
        link.symlink_to(real)
    except (OSError, NotImplementedError):
        pytest.skip("文件系统不支持符号链接")
    code, out, _ = _run(capsys, ["--data-dir", str(tmp_path)])
    assert code == 0
    assert "scanned=0" in out
    assert real.read_bytes() == _padded_wav(), "符号链接目标不能被改"


# --------------------------------------------------------------------------------------
# 文件名/key 不变 → 缓存仍命中（用真实 cache API 验证）
# --------------------------------------------------------------------------------------
def test_filename_unchanged_and_cache_still_hits(capsys, tmp_path, cache_dir, monkeypatch):
    from app.cache import cache_key, get_cache, reset_cache
    from app.config import get_settings, reset_settings_cache

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CACHE_ENABLED", "1")
    reset_settings_cache()
    reset_cache()
    try:
        key = cache_key("think", "en-US-JennyNeural", "normal", "azure", "wav")
        target = cache_dir / f"{key}.wav"
        target.write_bytes(_padded_wav())
        assert probe_audio(target.read_bytes()).duration_ms == 1820

        code, out, _ = _run(capsys, ["--data-dir", str(tmp_path)])
        assert code == 0 and "trimmed=1" in out
        assert target.is_file(), "文件名（=缓存 key）必须保持不变"
        assert probe_audio(target.read_bytes()).duration_ms == pytest.approx(290, abs=20)

        hit = get_cache().get_audio(key)
        assert hit is not None, "裁剪后同一 key 仍必须能命中缓存"
        cached_audio, ext = hit
        assert ext == "wav"
        assert probe_audio(cached_audio).duration_ms == pytest.approx(290, abs=20)
        assert cached_audio == target.read_bytes()
    finally:
        reset_cache()
        reset_settings_cache()
