"""本地语音合成（Piper / onnxruntime，CPU）。

为什么用 Piper：VITS + ONNX，CPU 上 RTF ≈ 0.02–0.04（Azure TTS 实测 RTF 9.84），
依赖只有 onnxruntime（不需要 torch），音色模型可从 ModelScope 镜像下载（HF 不可达）。

音色模型来源（已实测可用，`snapshot_download` 下载）：
- `rhasspy/piper-voices`（官方合集）：`en/en_US/lessac/medium`（女声，22.05kHz）、
  `en/en_US/amy/low`、`en/en_GB/*`、`en/en_US/*/high` 等
- `Trelis/piper-en-us-ryan-medium`（单音色仓，`model.onnx` + `model.onnx.json`）
模型文件放在 `PIPER_VOICE_DIR`（默认 `<MODEL_CACHE_DIR>/local/piper` 或 `<voice>/.local-models/piper`），
文件名约定 `<voice>.onnx` + `<voice>.onnx.json`（与 Piper 官方一致）。**大模型不进 git**。
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

from ..audio_io import pcm16_wav_bytes, trim_wav_silence
from ..config import Settings, get_settings
from ..errors import ProviderError, ProviderUnavailable
from .base import Capabilities, TTSResult

logger = logging.getLogger("voice.piper")

_VOICE_LOCK = threading.Lock()
_VOICE_CACHE: dict[str, object] = {}


def _candidate_dirs(settings: Settings) -> list[Path]:
    dirs: list[Path] = []
    if settings.piper_voice_dir:
        dirs.append(Path(settings.piper_voice_dir).expanduser())
    dirs.append(settings.local_models_dir / "piper")
    dirs.append(settings.model_cache_dir / "local" / "piper")
    dirs.append(settings.model_cache_dir / "piper")
    return dirs


def resolve_voice_path(voice: str | None, settings: Settings | None = None) -> Path:
    """找到 `<voice>.onnx` 的绝对路径；找不到就抛 ProviderUnavailable（不静默降级）。"""
    settings = settings or get_settings()
    wanted = (voice or settings.piper_voice or "").strip()
    dirs = _candidate_dirs(settings)
    names = [wanted] if wanted else []
    if settings.piper_voice and settings.piper_voice != wanted:
        names.append(settings.piper_voice)

    for directory in dirs:
        if not directory.is_dir():
            continue
        for name in names:
            candidate = directory / f"{name}.onnx"
            if candidate.is_file():
                return candidate
        # voice 传的是 Azure 音色名（如 en-US-JennyNeural）时，退回该目录下任意一个音色
        available = sorted(directory.glob("*.onnx"))
        if available:
            logger.info("piper voice %r 未找到，改用 %s", wanted, available[0].name)
            return available[0]

    raise ProviderUnavailable(
        "找不到 Piper 音色模型。请把 <voice>.onnx 与 <voice>.onnx.json 放到 "
        f"{dirs[0]}（或用 PIPER_VOICE_DIR / PIPER_VOICE 指定）；"
        "模型可从 ModelScope 的 rhasspy/piper-voices 下载，不要访问 HuggingFace。",
        provider="piper",
    )


def load_voice(voice: str | None, settings: Settings | None = None):
    """加载并缓存 PiperVoice（惰性导入 piper，只有真的用 local TTS 才需要）。"""
    settings = settings or get_settings()
    path = resolve_voice_path(voice, settings)
    key = str(path)
    with _VOICE_LOCK:
        cached = _VOICE_CACHE.get(key)
        if cached is not None:
            return cached
        try:
            from piper import PiperVoice  # 惰性导入
        except Exception as exc:  # pragma: no cover - 依赖未安装
            raise ProviderUnavailable(
                "piper 未安装；uv pip install --index-url https://mirrors.aliyun.com/pypi/simple/ piper-tts",
                provider="piper",
                detail=str(exc),
            ) from exc
        try:
            loaded = PiperVoice.load(str(path), config_path=str(path) + ".json" if Path(str(path) + ".json").is_file() else None)
        except Exception as exc:
            raise ProviderError(f"piper 音色加载失败 {path.name}: {exc}", provider="piper") from exc
        _VOICE_CACHE[key] = loaded
        logger.info("piper voice loaded: %s (sample_rate=%s)", path.name, getattr(loaded.config, "sample_rate", "?"))
        return loaded


class PiperTTS:
    """本地 TTS provider（provider 名 "piper"）。输出 16-bit mono WAV。"""

    name = "piper"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        rate: str = "normal",
        fmt: str = "mp3",
        ssml: str | None = None,
    ) -> TTSResult:
        settings = get_settings()
        payload = _plain_text(ssml) if ssml else (text or "")
        if not payload.strip():
            raise ProviderError("piper: empty text", provider="piper")

        piper_voice = load_voice(voice, settings)
        syn_config = _synthesis_config(piper_voice, rate)
        try:
            chunks = list(piper_voice.synthesize(payload, syn_config=syn_config))
        except Exception as exc:
            raise ProviderError(f"piper 合成失败: {exc}", provider="piper") from exc

        if not chunks:
            raise ProviderError("piper 返回空音频", provider="piper")
        pcm = b"".join(chunk.audio_int16_bytes for chunk in chunks)
        sample_rate = int(chunks[0].sample_rate)
        wav = pcm16_wav_bytes(_pcm16_to_float(pcm), sample_rate)
        duration_ms = int(round(len(pcm) / 2 / sample_rate * 1000))
        if settings.tts_trim_silence:
            trimmed, changed = trim_wav_silence(wav, settings.tts_trim_threshold_db, settings.tts_trim_keep_ms)
            if changed:
                from ..audio_io import probe_audio

                wav = trimmed
                duration_ms = probe_audio(wav).duration_ms
        return TTSResult(
            audio=wav,
            content_type="audio/wav",
            provider=self.name,
            duration_ms=duration_ms,
            format="wav",
        )


def _pcm16_to_float(pcm: bytes):
    import numpy as np

    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def _synthesis_config(piper_voice, rate: str):
    """教学场景的慢速：length_scale > 1 会把音素拉长（Piper 的时长缩放）。"""
    try:
        from piper.config import SynthesisConfig  # 惰性导入
    except Exception:
        return None
    if (rate or "normal") == "slow":
        return SynthesisConfig(length_scale=1.35)
    return None


def _plain_text(ssml: str) -> str:
    import re

    return " ".join(re.sub(r"<[^>]+>", " ", ssml or "").split())
