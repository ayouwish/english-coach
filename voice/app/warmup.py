"""参考音 + 参考 F0 的生成/缓存复用与批量预热（契约 v1.1 §12）。

`/v1/pronounce` 与 `/v1/warmup` 共用同一套「同一 key 只生成一次」的原语：
先查缓存 -> 未命中则经 SingleFlight 生成（TTS + praat F0）-> 写入缓存。
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from .audio_io import decode_audio
from .cache import (
    SINGLE_FLIGHT,
    STATE_DISABLED,
    STATE_HIT,
    STATE_MISS,
    WarmupCache,
    cache_key,
    ext_from_content_type,
    external_audio_id,
)
from .config import Settings, get_settings
from .errors import VoiceError
from .execution import TIMEOUTS, run_chain
from .intonation import F0Series, extract_f0, series_from_pairs
from .providers.registry import ProviderSet, get_providers
from .store import AudioStore

logger = logging.getLogger("voice.warmup")

MAX_ITEM_CHARS = 2000

# 参考音频（示范音 + 参考 F0 的来源）统一用 wav：语调分析需要无损 PCM。
# 播放用的 mp3 走 /v1/tts，并按 fmt 单独缓存（两者是不同产物）。
REFERENCE_AUDIO_FORMAT = "wav"


def tts_provider_name(providers: ProviderSet) -> str:
    """key 里要用的 TTS provider 身份：与 /v1/health 的 providers.tts 同口径（provider 实例的 name）。"""
    return getattr(getattr(providers, "tts", None), "name", "unknown")


@dataclass
class ReferenceMaterial:
    audio_bytes: bytes | None = None
    ext: str = "wav"
    reference_audio_url: str | None = None
    f0_series: F0Series | None = None
    cache_states: dict = field(
        default_factory=lambda: {"reference_audio": STATE_DISABLED, "reference_f0": STATE_DISABLED}
    )
    tts_fallback: bool = False
    provider_errors: list[str] = field(default_factory=list)


def _build_series(audio_bytes: bytes) -> F0Series | None:
    try:
        clip = decode_audio(audio_bytes, 16000, 60.0)
        return extract_f0(clip.samples, clip.sample_rate)
    except Exception as exc:  # 语调永远不能把请求打成 500
        logger.warning("reference f0 extraction failed: %s", exc)
        return None


def _generate_audio(text: str, voice: str, rate: str, providers: ProviderSet) -> tuple[bytes, str, bool, list[str]]:
    """TTS 调用链 -> (audio_bytes, content_type, used_fallback, errors)。"""
    result, _name, fallback, errors = run_chain(
        providers.tts_chain,
        lambda provider: provider.synthesize(text=text, voice=voice, rate=rate, fmt=REFERENCE_AUDIO_FORMAT),
        TIMEOUTS["tts"],
        kind="tts",
    )
    if result is None:
        from .degrade import degraded_tts

        audio, content_type, _duration = degraded_tts(text, voice=voice, rate=rate)
        return audio, content_type, True, errors
    return result.audio, result.content_type, fallback, errors


def _produce_locked(
    cache: WarmupCache,
    key: str,
    text: str,
    voice: str,
    rate: str,
    providers: ProviderSet,
) -> dict:
    """在 SingleFlight 保护下执行：能复用就复用，绝不重复调用 TTS。"""
    entry = cache.get_audio(key)
    points = cache.get_f0(key)
    if entry is not None and points is not None:
        return {"data": entry[0], "ext": entry[1], "points": points, "fallback": False, "from_cache": True}
    if entry is not None:
        # 音频已缓存，只补算 F0（F0 与用户音频无关，可独立缓存）
        data, ext = entry
        series = _build_series(data)
        points = series.to_pairs() if series is not None else None
        if points:
            cache.put_f0(key, points)
        return {"data": data, "ext": ext, "points": points, "fallback": False, "from_cache": True, "f0_rebuilt": True}

    data, content_type, fallback, errors = _generate_audio(text, voice, rate, providers)
    ext = ext_from_content_type(content_type)
    series = _build_series(data)
    points = series.to_pairs() if series is not None else None
    # 关键不变量：fallback（= 非 primary provider 产出，含内置兜底音）一律不落缓存，
    # 因此能进缓存的音频/曲线，其生产者一定等于 key 里的 tts_provider。
    if not fallback and points:
        cache.put_audio(key, data, ext)
        cache.put_f0(key, points)
    return {
        "data": data,
        "ext": ext,
        "points": points,
        "fallback": fallback,
        "from_cache": False,
        "errors": errors,
    }


def prepare_reference(
    text: str,
    voice: str,
    rate: str,
    *,
    with_intonation: bool = True,
    settings: Settings | None = None,
    providers: ProviderSet | None = None,
    cache: WarmupCache,
    store: AudioStore,
) -> ReferenceMaterial:
    """给 `/v1/pronounce` 用：拿参考音 + 参考 F0（命中缓存时完全不调 TTS / praat）。"""
    settings = settings or get_settings()
    providers = providers or get_providers()
    material = ReferenceMaterial()

    if not with_intonation or not text:
        return material  # cache: disabled / disabled

    if not cache.enabled:
        # CACHE_ENABLED=false：退回 v1.0 行为（每次生成，落 legacy 音频目录，不缓存）
        data, content_type, fallback, errors = _generate_audio(text, voice, rate, providers)
        ext = ext_from_content_type(content_type)
        series = _build_series(data)
        audio_id = store.save(data, ext)
        material.audio_bytes = data
        material.ext = ext
        material.reference_audio_url = store.url_for(audio_id)
        material.f0_series = series
        material.tts_fallback = fallback
        material.provider_errors = errors
        return material

    key = cache_key(text, voice, rate, tts_provider_name(providers), REFERENCE_AUDIO_FORMAT)
    audio_entry = cache.get_audio(key)
    f0_points = cache.get_f0(key)
    material.cache_states = {
        "reference_audio": STATE_HIT if audio_entry is not None else STATE_MISS,
        "reference_f0": STATE_HIT if f0_points is not None else STATE_MISS,
    }

    if audio_entry is not None and f0_points is not None:
        data, ext = audio_entry
        material.audio_bytes = None  # 全命中：连读文件都省了，只给 URL
        material.ext = ext
        material.reference_audio_url = store.url_for(cache.audio_external_id(key) or external_audio_id(key, ext))
        material.f0_series = series_from_pairs(f0_points)
        return material

    produced = (
        SINGLE_FLIGHT.run(key, lambda: _produce_locked(cache, key, text, voice, rate, providers)) or {}
    )
    ext = produced.get("ext") or "wav"
    data = produced.get("data") or b""
    points = produced.get("points")
    material.ext = ext
    material.tts_fallback = bool(produced.get("fallback"))
    material.provider_errors = produced.get("errors") or []

    if material.tts_fallback or not points:
        # 兜底音/坏曲线不进缓存，走 legacy 目录（下次仍会重新生成）
        audio_id = store.save(data, ext)
        material.reference_audio_url = store.url_for(audio_id)
    else:
        material.reference_audio_url = store.url_for(cache.audio_external_id(key) or external_audio_id(key, ext))
    if points:
        material.f0_series = series_from_pairs(points)
    material.audio_bytes = data if data else None
    return material


def warm_one(text: str, voice: str, rate: str, *, cache: WarmupCache, providers: ProviderSet | None = None) -> str:
    """预热单条：返回 "cached" | "generated"。"""
    providers = providers or get_providers()
    key = cache_key(text, voice, rate, tts_provider_name(providers), REFERENCE_AUDIO_FORMAT)
    if cache.enabled and cache.get_audio(key) is not None and cache.get_f0(key) is not None:
        return "cached"

    def _task() -> str:
        if cache.enabled and cache.get_audio(key) is not None and cache.get_f0(key) is not None:
            return "cached"
        _produce_locked(cache, key, text, voice, rate, providers)
        return "generated"

    return SINGLE_FLIGHT.run(key, _task)


def error_code(exc: BaseException) -> str:
    if isinstance(exc, VoiceError):
        return exc.code
    return "provider_error"


@dataclass
class WarmupItemSpec:
    text: str
    voice: str
    rate: str


def resolve_item(item) -> WarmupItemSpec:
    """把请求里的 item 规范成 (text, voice, rate)；voice 为空时用 provider 默认音色。"""
    settings = get_settings()
    voice = (getattr(item, "voice", None) or "").strip() or settings.default_tts_voice
    rate = (getattr(item, "rate", None) or "normal").strip() or "normal"
    return WarmupItemSpec(text=getattr(item, "text", "") or "", voice=voice, rate=rate)


def validate_item(spec: WarmupItemSpec, settings: Settings | None = None) -> str | None:
    settings = settings or get_settings()
    if not spec.text.strip():
        return "empty text"
    if len(spec.text) > settings.max_tts_chars:
        return f"text too long: {len(spec.text)} > {settings.max_tts_chars}"
    if spec.rate not in ("slow", "normal"):
        return f"rate must be 'slow' or 'normal', got {spec.rate!r}"
    return None


def run_warmup(
    specs: list[WarmupItemSpec],
    concurrency: int = 2,
    *,
    cache: WarmupCache,
    providers: ProviderSet | None = None,
) -> dict:
    """批量预热。单条失败不影响整体；计数必须自洽。"""
    providers = providers or get_providers()
    tts_provider = tts_provider_name(providers)
    requested = len(specs)

    seen: set[str] = set()
    unique: list[WarmupItemSpec] = []
    skipped_duplicates = 0
    for spec in specs:
        key = cache_key(spec.text, spec.voice, spec.rate, tts_provider, REFERENCE_AUDIO_FORMAT)
        if key in seen:
            skipped_duplicates += 1
            continue
        seen.add(key)
        unique.append(spec)

    counters = {"generated": 0, "cached": 0}
    failed: list[dict] = []
    lock = threading.Lock()
    started = time.perf_counter()

    def _work(spec: WarmupItemSpec) -> None:
        try:
            outcome = warm_one(spec.text, spec.voice, spec.rate, cache=cache, providers=providers)
        except BaseException as exc:  # noqa: BLE001 - 单条失败必须隔离
            logger.warning("warmup item failed: %s", exc)
            with lock:
                failed.append({"text": spec.text, "voice": spec.voice, "rate": spec.rate, "error": error_code(exc)})
            return
        with lock:
            counters[outcome] = counters.get(outcome, 0) + 1

    if unique:
        workers = max(1, min(int(concurrency or 1), 8, len(unique)))
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="voice-warmup") as pool:
            list(pool.map(_work, unique))

    elapsed_ms = int(round((time.perf_counter() - started) * 1000))
    payload = {
        "requested": requested,
        "generated": counters["generated"],
        "cached": counters["cached"],
        "failed": failed,
        "skipped_duplicates": skipped_duplicates,
        "elapsed_ms": elapsed_ms,
        "cache": cache.stats(),
    }
    assert payload["requested"] == (
        payload["generated"] + payload["cached"] + len(payload["failed"]) + payload["skipped_duplicates"]
    ), "warmup counters must be self-consistent"
    return payload
