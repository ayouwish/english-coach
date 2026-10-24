"""Provider 注册表：按配置实例化 provider，并给出带兜底的调用链。"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache

from ..config import Settings, get_settings
from ..errors import ProviderError, ProviderUnavailable, VoiceError
from .base import ASRProvider, PAProvider, TTSProvider
from .mock import MockASR, MockPA, MockTTS


def _make(kind: str, name: str):
    if name in ("", "none"):
        return None
    if kind == "asr":
        if name == "mock":
            return MockASR()
        if name == "local":
            from .local import LocalASR  # 惰性导入（避免加载 faster-whisper 依赖）

            return LocalASR()
        if name == "azure":
            from .azure import AzureASR

            return AzureASR()
    elif kind == "pa":
        if name == "mock":
            return MockPA()
        if name == "local":
            from .local import LocalPA

            return LocalPA()
        if name == "azure":
            from .azure import AzurePA

            return AzurePA()
    elif kind == "tts":
        if name == "mock":
            return MockTTS()
        if name == "local":
            from .local import LocalTTS

            return LocalTTS()
        if name == "azure":
            from .azure import AzureTTS

            return AzureTTS()
    raise ProviderUnavailable(f"unknown {kind} provider: {name!r}", provider=name)


@dataclass
class ProviderSet:
    asr: ASRProvider
    pa: PAProvider
    tts: TTSProvider
    asr_chain: list[ASRProvider] = field(default_factory=list)
    pa_chain: list[PAProvider] = field(default_factory=list)
    tts_chain: list[TTSProvider] = field(default_factory=list)
    mode: str = "mock"

    @property
    def capabilities(self) -> dict:
        pa_caps = getattr(self.pa, "capabilities", None)
        tts_caps = getattr(self.tts, "capabilities", None)
        return {
            "phoneme_level": bool(getattr(pa_caps, "phoneme_level", False)),
            "prosody": bool(getattr(pa_caps, "prosody", False)),
            "intonation_curve": True,  # 语调由本地模块提供，任何 provider 下都可用
            "nbest_phonemes": bool(getattr(pa_caps, "nbest_phonemes", False)),
            "ssml": bool(getattr(tts_caps, "ssml", False)),
        }

    def provider_names(self) -> dict:
        return {"asr": self.asr.name, "pa": self.pa.name, "tts": self.tts.name}


def _chain(kind: str, primary: str, settings: Settings) -> list:
    """调用链：primary -> 本地兜底（local/hybrid 模式）-> mock（永远最后，保证离线也能出结果）。"""
    candidates = [primary]
    if settings.mode in ("local", "hybrid"):
        candidates.append("local")
    candidates.append("mock")
    order: list[str] = []
    for name in candidates:
        if name and name not in order:
            order.append(name)
    chain = []
    for name in order:
        try:
            instance = _make(kind, name)
        except VoiceError:
            continue
        if instance is not None:
            chain.append(instance)
    return chain


def build_providers(settings: Settings | None = None) -> ProviderSet:
    settings = settings or get_settings()
    asr = _make("asr", settings.asr_provider)
    pa = _make("pa", settings.pa_provider)
    tts = _make("tts", settings.tts_provider)
    return ProviderSet(
        asr=asr,
        pa=pa,
        tts=tts,
        asr_chain=_chain("asr", settings.asr_provider, settings),
        pa_chain=_chain("pa", settings.pa_provider, settings),
        tts_chain=_chain("tts", settings.tts_provider, settings),
        mode=settings.mode,
    )


@lru_cache(maxsize=1)
def get_providers() -> ProviderSet:
    return build_providers()


def reset_providers() -> None:
    get_providers.cache_clear()


__all__ = ["ProviderSet", "build_providers", "get_providers", "reset_providers", "ProviderError"]
