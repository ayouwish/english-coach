"""task-42：16kHz 坏缓存（诊断页"浑浊/电话音"）——缓存自愈 + 阈值 + 审计脚本。

根因：旧 bug 让 Azure TTS 静默退回 16kHz（>4kHz 零能量），坏音频进了缓存；缓存 key 不含采样率版本。
这里验证：阈值按格式区分、命中时自愈删除并重新合成、脚本可批量审计/清理。
"""

from __future__ import annotations

import importlib.util
import io
import json
import logging
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from app import api as api_module
from app.audio_io import MIN_TTS_WAV_SAMPLE_RATE, pcm16_wav_bytes, probe_audio, wav_header_info
from app.cache import cache_key, get_cache, reset_cache
from app.config import get_settings, reset_settings_cache
from app.providers.base import Capabilities
from app.providers.mock import MockPA
from app.providers.registry import ProviderSet, build_providers

ROOT = Path(__file__).resolve().parent.parent
SR16 = 16000
SR24 = 24000


def _wav(sample_rate: int, seconds: float = 0.5) -> bytes:
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    return pcm16_wav_bytes(0.25 * np.sin(2 * np.pi * 220.0 * t), sample_rate)


def _load_script():
    spec = importlib.util.spec_from_file_location("trim_cache_script42", ROOT / "scripts" / "trim_cache.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class _FakeTTS24k:
    """模拟"修复后的 Azure"：产出 24kHz WAV（provider 名用 azure，因为自愈只对 azure 生效）。"""

    name = "azure"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def __init__(self):
        self.calls = 0

    def synthesize(self, text, voice=None, rate="normal", fmt="mp3", ssml=None):
        self.calls += 1
        data = _wav(SR24)
        return SimpleNamespace(
            audio=data,
            content_type="audio/wav",
            provider=self.name,
            duration_ms=probe_audio(data).duration_ms,
            format="wav",
        )


@pytest.fixture
def fake_tts_setup(client, monkeypatch):
    fake = _FakeTTS24k()
    base = build_providers()
    provider_set = ProviderSet(
        asr=base.asr,
        pa=base.pa or MockPA(),
        tts=fake,
        asr_chain=base.asr_chain,
        pa_chain=base.pa_chain,
        tts_chain=[fake],
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)

    settings = get_settings()
    cache = get_cache()
    key = cache_key("think", settings.default_tts_voice, "normal", fake.name, "wav")
    return SimpleNamespace(fake=fake, settings=settings, cache=cache, key=key)


REQ = {"text": "think", "format": "wav", "rate": "normal"}


# --------------------------------------------------------------------------------------
# A. 缓存自愈：16kHz 命中 → 删除（含 f0）→ 重新合成 24kHz
# --------------------------------------------------------------------------------------
def test_low_rate_cache_hit_is_purged_and_resynthesized(client, fake_tts_setup, caplog):
    setup = fake_tts_setup
    audio_dir = setup.settings.data_dir / "cache" / "audio"
    f0_dir = setup.settings.data_dir / "cache" / "f0"
    old_path = audio_dir / f"{setup.key}.wav"
    old_path.write_bytes(_wav(SR16))
    f0_path = f0_dir / f"{setup.key}.json"
    f0_path.write_text(json.dumps({"times_ms": [0, 10, 20], "f0": [220.0, 221.0, 222.0]}), encoding="utf-8")
    assert wav_header_info(old_path.read_bytes())["sample_rate"] == SR16

    with caplog.at_level(logging.WARNING, logger="voice.api"):
        response = client.post("/v1/tts", json=REQ)

    assert response.status_code == 200, response.text
    assert setup.fake.calls == 1, "坏缓存必须当作 miss 重新合成"
    assert response.headers["X-Cache"] == "miss"
    assert response.headers["X-TTS-Provider"] == "azure"

    # 返回的是新合成的 24kHz 音频，不是旧 16kHz
    info = wav_header_info(response.content)
    assert info is not None and info["sample_rate"] == SR24
    assert response.content != _wav(SR16)

    # 原文件名（=缓存 key）不变，但内容已换成 24kHz
    assert old_path.is_file(), "缓存文件应继续用原 key 文件名重新写入"
    assert wav_header_info(old_path.read_bytes())["sample_rate"] == SR24
    # 坏音频的 F0 缓存被连带删除（重新合成后可能已被新的 warmup 写回，但至少不是旧数据）
    if f0_path.is_file():
        payload = json.loads(f0_path.read_text(encoding="utf-8"))
        assert payload.get("times_ms") != [0, 10, 20], "旧的坏音频 F0 必须被删除/覆盖"

    messages = " | ".join(r.getMessage() for r in caplog.records if r.name == "voice.api")
    assert "low sample rate" in messages, messages
    assert "16000" in messages and "24000" in messages, messages
    assert setup.key in messages, "WARNING 应包含缓存 key"


def test_f0_cache_deleted_when_low_rate_cache_purged(client, fake_tts_setup):
    """直接验证自愈会删除同名 f0（用 cache API，避免 warmup 覆盖干扰）。"""
    setup = fake_tts_setup
    audio_dir = setup.settings.data_dir / "cache" / "audio"
    f0_dir = setup.settings.data_dir / "cache" / "f0"
    (audio_dir / f"{setup.key}.wav").write_bytes(_wav(SR16))
    f0_path = f0_dir / f"{setup.key}.json"
    f0_path.write_text(json.dumps({"times_ms": [0, 10], "f0": [200.0, 210.0]}), encoding="utf-8")

    api_module._purge_low_rate_wav_cache(
        setup.cache, setup.key, (audio_dir / f"{setup.key}.wav").read_bytes(), "wav", "azure"
    )
    assert not (audio_dir / f"{setup.key}.wav").exists()
    assert not f0_path.exists(), "F0 缓存必须连带删除"


def test_24k_cache_still_hits_and_no_resynthesis(client, fake_tts_setup):
    setup = fake_tts_setup
    audio_dir = setup.settings.data_dir / "cache" / "audio"
    data = _wav(SR24)
    (audio_dir / f"{setup.key}.wav").write_bytes(data)

    response = client.post("/v1/tts", json=REQ)
    assert response.status_code == 200
    assert response.headers["X-Cache"] == "hit"
    assert setup.fake.calls == 0, "24kHz 正常缓存不应重新合成"
    assert response.content == data
    assert wav_header_info(response.content)["sample_rate"] == SR24


# --------------------------------------------------------------------------------------
# B. 阈值：wav 必须 ≥24kHz；16kHz 直接报错（不再静默通过）
# --------------------------------------------------------------------------------------
def test_verify_audio_format_rejects_16k_wav():
    from app.errors import ProviderError
    from app.providers.azure import verify_audio_format

    with pytest.raises(ProviderError) as exc:
        verify_audio_format(_wav(SR16), "wav")
    assert "采样率过低" in str(exc.value) or "sample" in str(exc.value).lower()

    probe = verify_audio_format(_wav(SR24), "wav")
    assert probe is not None and probe.sample_rate == SR24


def test_expected_min_rate_by_format():
    from app.providers.azure import _EXPECTED_MIN_RATE

    assert _EXPECTED_MIN_RATE["wav"] == MIN_TTS_WAV_SAMPLE_RATE == 24000
    assert _EXPECTED_MIN_RATE["mp3"] <= 24000  # mp3 保持合理下限（不误伤）


# --------------------------------------------------------------------------------------
# C. 维护脚本：默认只报告、--fix-low-rate 才删；幂等
# --------------------------------------------------------------------------------------
def _script_dir(tmp_path: Path) -> Path:
    audio = tmp_path / "cache" / "audio"
    audio.mkdir(parents=True)
    (tmp_path / "cache" / "f0").mkdir()
    return audio


def _run_script(capsys, argv):
    module = _load_script()
    code = module.main(argv)
    out, err = capsys.readouterr()
    return code, out, err


def test_script_reports_low_rate_by_default_then_fixes(capsys, tmp_path):
    audio = _script_dir(tmp_path)
    bad = audio / "bad16k.wav"
    bad.write_bytes(_wav(SR16))
    good = audio / "good24k.wav"
    good.write_bytes(_wav(SR24))
    mp3 = audio / "song.mp3"
    mp3.write_bytes(b"ID3\x04\x00" + b"\x00" * 100)
    f0 = tmp_path / "cache" / "f0" / "bad16k.json"
    f0.write_text('{"times_ms":[]}', encoding="utf-8")

    # 默认只报告
    code, out, _ = _run_script(capsys, ["--data-dir", str(tmp_path)])
    assert code == 0
    assert "low_rate_found=1" in out and "deleted=0" in out and "ok=1" in out
    assert "16000Hz" in out, "必须打印坏文件的采样率"
    assert bad.is_file(), "没有 --fix-low-rate 时不允许删文件"
    assert f0.is_file()

    # 显式修复
    code, out, _ = _run_script(capsys, ["--data-dir", str(tmp_path), "--fix-low-rate"])
    assert code == 0
    assert "low_rate_found=1" in out and "deleted=1" in out and "f0=1" in out
    assert not bad.exists(), "坏 16k 文件应被删除"
    assert not f0.exists(), "对应 f0 应被连带删除"
    assert good.is_file() and wav_header_info(good.read_bytes())["sample_rate"] == SR24
    assert mp3.read_bytes() == b"ID3\x04\x00" + b"\x00" * 100, "mp3 不允许被碰"

    # 幂等：再跑一次没有坏文件
    code, out, _ = _run_script(capsys, ["--data-dir", str(tmp_path), "--fix-low-rate"])
    assert code == 0
    assert "low_rate_found=0" in out and "deleted=0" in out


def test_script_json_stats_contains_low_rate_info(capsys, tmp_path):
    audio = _script_dir(tmp_path)
    (audio / "bad.wav").write_bytes(_wav(SR16))
    code, out, _ = _run_script(capsys, ["--data-dir", str(tmp_path), "--json"])
    payload = json.loads(out.strip().splitlines()[-1])
    assert payload["low_rate_found"] == 1
    assert payload["low_rate_files"][0]["sample_rate"] == SR16
    assert payload["deleted"] == 0


# --------------------------------------------------------------------------------------
# D. 坏缓存自愈后的"同一 key：16k → 删 → 重新合成 24k"完整链路（脚本 + 端点）
# --------------------------------------------------------------------------------------
def test_script_fix_then_endpoint_resynthesizes(client, fake_tts_setup, capsys):
    setup = fake_tts_setup
    audio_dir = setup.settings.data_dir / "cache" / "audio"
    path = audio_dir / f"{setup.key}.wav"
    path.write_bytes(_wav(SR16))

    code, out, _ = _run_script(capsys, ["--data-dir", str(setup.settings.data_dir), "--fix-low-rate"])
    assert code == 0 and "deleted=1" in out

    response = client.post("/v1/tts", json=REQ)
    assert response.status_code == 200
    assert setup.fake.calls == 1
    assert wav_header_info(response.content)["sample_rate"] == SR24
    assert response.headers["X-Cache"] == "miss"


def test_mock_16k_cache_is_not_purged(client, monkeypatch):
    """mock TTS 本身就是 16kHz（合法），自愈只针对 azure，不能误伤 mock 缓存。"""
    from app.synth import synthesize_speech_wav
    from app.audio_io import wav_header_info

    class _MockLike:
        name = "mock"
        capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)
        calls = 0

        def synthesize(self, text, voice=None, rate="normal", fmt="mp3", ssml=None):
            _MockLike.calls += 1
            data = synthesize_speech_wav(text, voice=voice, rate=rate)
            return SimpleNamespace(audio=data, content_type="audio/wav", provider="mock",
                                   duration_ms=probe_audio(data).duration_ms, format="wav")

    base = build_providers()
    fake = _MockLike()
    provider_set = ProviderSet(asr=base.asr, pa=base.pa or MockPA(), tts=fake,
                               asr_chain=base.asr_chain, pa_chain=base.pa_chain, tts_chain=[fake])
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    settings = get_settings()
    key = cache_key("think", settings.default_tts_voice, "normal", "mock", "wav")
    audio_dir = settings.data_dir / "cache" / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    data = synthesize_speech_wav("think", voice=settings.default_tts_voice, rate="normal")
    assert wav_header_info(data)["sample_rate"] == 16000
    (audio_dir / f"{key}.wav").write_bytes(data)

    response = client.post("/v1/tts", json={"text": "think", "format": "wav"})
    assert response.status_code == 200
    assert response.headers["X-Cache"] == "hit", "mock 的 16k 缓存是合法的，不应被删"
    assert _MockLike.calls == 0
