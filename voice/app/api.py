"""7 个契约端点的实现。所有非 2xx 都走统一错误格式（error handler 在 main.py）。"""

from __future__ import annotations

import difflib
import re

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from . import execution
from .audio_io import decode_audio, probe_audio
from .cache import (
    EXT_CONTENT_TYPES,
    SINGLE_FLIGHT,
    STATE_DISABLED,
    cache_key,
    ext_from_content_type,
    get_cache,
)
from .config import get_settings
from .degrade import degraded_assessment, degraded_tts
from .dialogue import complete_dialogue
from .errors import BadRequest, PayloadTooLarge
from .feedback_templates import (
    CHILD_EXTRA_RULE,
    FEEDBACK_SYSTEM_PROMPT,
    build_feedback_user_prompt,
    is_no_speech_payload,
    sanitize_feedback,
    template_feedback,
)
from .hints import dedupe_warnings
from .intonation import compare_intonation, extract_f0, prosody_score_from_distance
from .llm import LLMClient
from .ocr import active_ocr_provider, ocr_available, recognize_image
from .phonemes import PHONEME_SPACE_ID, canonicalize_pa_result
from .providers.registry import get_providers
from .schemas import DialogueRequest, FeedbackRequest, TTSRequest, WarmupRequest
from .store import AudioStore, CACHE_CONTROL, CONTENT_TYPES
from .warmup import tts_provider_name
from .text import estimate_word_timings, strip_terminal_punct, tokens
from .warmup import prepare_reference, resolve_item, run_warmup, validate_item

router = APIRouter()

MODES = ("scripted", "unscripted")
GRANULARITIES = ("phoneme", "word")
TTS_RATES = ("slow", "normal")
TTS_FORMATS = ("mp3", "wav")
AGE_BANDS = ("child", "teen", "adult")


def _parse_bool(value: str | bool | None, default: bool = True) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _store() -> AudioStore:
    return AudioStore(get_settings().audio_dir)


async def _read_upload(upload: UploadFile, max_bytes: int) -> bytes:
    data = await upload.read()
    if len(data) > max_bytes:
        raise PayloadTooLarge(f"upload too large: {len(data)} bytes > {max_bytes}")
    return data


# --------------------------------------------------------------------------------------
# 1. health
# --------------------------------------------------------------------------------------
@router.get("/health")
async def health() -> dict:
    settings = get_settings()
    providers = get_providers()
    capabilities = providers.capabilities
    capabilities["gpu"] = bool(settings.gpu)
    capabilities["ocr"] = ocr_available()  # task-27：任一 OCR provider 可用（LLM 视觉 或 本地 rapidocr）
    capabilities["ocr_provider"] = active_ocr_provider()  # "llm" | "local" | null（自检用）
    return {
        "status": "ok",
        "version": settings.version,
        "mode": settings.mode,
        "providers": {
            "asr": providers.asr.name,
            "pa": providers.pa.name,
            "tts": providers.tts.name,
            "llm": settings.llm_provider,
        },
        "capabilities": capabilities,
    }


# --------------------------------------------------------------------------------------
# 2. asr
# --------------------------------------------------------------------------------------
@router.post("/asr")
async def asr(
    audio: UploadFile = File(...),
    language: str = Form("en"),
    prompt: str | None = Form(None),
) -> dict:
    settings = get_settings()
    data = await _read_upload(audio, settings.max_upload_bytes)
    clip = await run_in_threadpool(decode_audio, data, 16000, settings.max_audio_seconds)
    providers = get_providers()

    result, provider_name, fallback, errors = execution.run_chain(
        providers.asr_chain,
        lambda provider: provider.recognize(clip, language=language or "en", prompt=prompt),
        execution.TIMEOUTS["asr"],
        kind="asr",
    )
    if result is None:
        # 连 mock 都失败了：ASR 没有任何可产出的降级内容，只能报 502
        from .errors import ProviderError

        raise ProviderError("all ASR providers failed", provider=provider_name or "asr", detail=errors[-3:])

    payload = result.to_contract()
    if fallback:
        payload["warnings"] = ["provider_fallback"]
        payload["provider_meta"] = {"fallback_errors": errors[-3:]}
    return payload


# --------------------------------------------------------------------------------------
# 3. pronounce
# --------------------------------------------------------------------------------------
@router.post("/pronounce")
async def pronounce(
    audio: UploadFile = File(...),
    # 契约：跟读模式传参考文本，自由说模式传**空串**。用默认空串接收，避免空串被当成缺字段。
    reference_text: str = Form(""),
    mode: str = Form("scripted"),
    granularity: str = Form("phoneme"),
    with_intonation: str | None = Form(None),
    tts_voice: str | None = Form(None),
    tts_rate: str = Form("normal"),
    learner_age_band: str | None = Form(None),
) -> dict:
    settings = get_settings()
    if mode not in MODES:
        raise BadRequest(f"mode must be one of {MODES}, got {mode!r}")
    if granularity not in GRANULARITIES:
        raise BadRequest(f"granularity must be one of {GRANULARITIES}, got {granularity!r}")
    if tts_rate not in TTS_RATES:
        raise BadRequest(f"tts_rate must be one of {TTS_RATES}, got {tts_rate!r}")
    age_band = (learner_age_band or "").strip() or None
    if age_band is not None and age_band not in AGE_BANDS:
        raise BadRequest(f"learner_age_band must be one of {AGE_BANDS}, got {learner_age_band!r}")
    # 契约：with_intonation 默认 true。FastAPI 对 bool Form 的默认值不可靠，这里手动解析。
    intonation_flag = _parse_bool(with_intonation, default=True)

    data = await _read_upload(audio, settings.max_upload_bytes)
    clip = await run_in_threadpool(decode_audio, data, 16000, settings.max_audio_seconds)
    providers = get_providers()
    warnings: list[str] = []

    def _assess(provider):
        return provider.assess(
            clip,
            reference_text,
            mode=mode,
            granularity=granularity,
            with_intonation=intonation_flag,
            learner_age_band=age_band,
        )

    result, provider_name, fallback, errors = execution.run_chain(
        providers.pa_chain, _assess, execution.TIMEOUTS["pronounce"], kind="pa"
    )
    if result is None:
        # 整条链都失败 -> 仍然返回 200 + 显式 warning（绝不给假音素分）
        result = degraded_assessment(
            clip, reference_text, mode=mode, granularity=granularity, learner_age_band=age_band
        )
        provider_name = "degraded"
        fallback = True
    if fallback:
        warnings.append("provider_fallback")
    warnings.extend(result.warnings)
    # v1.2：provider 输出的音素符号统一到 canonical-v1（保护 phoneme_mastery / srs_cards 的 key 一致性）
    canonicalize_pa_result(result)

    # ---- 参考示范音 + 参考 F0（缓存优先：命中时不调 TTS、不算 praat）+ 语调对比 ----
    reference_text_for_speech = reference_text.strip() or result.recognized_text
    reference_audio_url: str | None = None
    ref_series = None
    cache_states = {"reference_audio": STATE_DISABLED, "reference_f0": STATE_DISABLED}
    word_timings: list[dict] = []
    material = await run_in_threadpool(
        prepare_reference,
        reference_text_for_speech,
        tts_voice or settings.default_tts_voice,
        tts_rate,
        with_intonation=intonation_flag,
        settings=settings,
        providers=providers,
        cache=get_cache(),
        store=_store(),
    )
    reference_audio_url = material.reference_audio_url
    ref_series = material.f0_series
    cache_states = dict(material.cache_states)
    if material.tts_fallback:
        warnings.append("provider_fallback")
        errors = errors + list(material.provider_errors)
    if ref_series is not None and reference_text_for_speech:
        # 时间轴用参考 F0 序列推算，保证「命中缓存」和「未命中」两条路径完全一致
        ref_duration_ms = int(round(float(ref_series.times_ms[-1]))) + 20 if len(ref_series) else 0
        word_timings = estimate_word_timings(reference_text_for_speech, max(1, ref_duration_ms))

    user_series = None
    try:
        user_series = await run_in_threadpool(extract_f0, clip.samples, clip.sample_rate)
    except Exception:
        user_series = None

    intonation = compare_intonation(
        user_series,
        ref_series,
        word_timings=word_timings,
        reference_audio_url=reference_audio_url,
    )
    if intonation_flag and not intonation.available:
        warnings.append("intonation_unavailable")

    # prosody：provider 给了就用 provider 的，否则用本地 DTW 距离折算
    if result.scores.prosody is None:
        if intonation.available:
            result.scores.prosody = prosody_score_from_distance(intonation.dtw_distance)
        else:
            warnings.append("prosody_unavailable")

    if clip.duration_ms < 600:
        warnings.append("too_short")
    peak = float(abs(clip.samples).max()) if clip.samples.size else 0.0
    if peak < 0.01:
        warnings.append("low_snr")
    if result.reference_text and result.recognized_text:
        ratio = difflib.SequenceMatcher(
            a=tokens(strip_terminal_punct(result.reference_text)),
            b=tokens(strip_terminal_punct(result.recognized_text)),
        ).ratio()
        if ratio < 0.6:
            warnings.append("asr_mismatch")

    provider_meta: dict = {"primary_error": errors[-1]} if errors else {}
    if isinstance(result.provider_meta, dict):
        provider_meta.update(result.provider_meta)
    provider_meta["pa_provider"] = provider_name
    provider_meta["cache"] = cache_states  # 契约 §12.5（可选新增字段，v1.0 客户端不读）
    provider_meta["phoneme_space"] = PHONEME_SPACE_ID  # v1.2：音素符号空间版本（便于审计/联调）

    # 契约 §4：`scores.*` **不可得时必须返回 `null`，不能是 0**（0 会被读成"读得一无是处"）。
    # Azure 在"听不到有效语音"时（没说话 / 说的不是这句 / 明显非语音）会把四项能力分全填 0 ——
    # 那并不是"得了 0 分"，而是"这次没法评"。所以四项全 0 时统一改成 null，并补一条
    # `scores_unavailable` 警告，让前端能提示"这次没听清，再来一次"，而不是给个 0 分打击孩子。
    # 注意：prosody 由我们自研的 F0+DTW 模块独立计算，不参与这条判定，保持原值。
    scores_payload = result.scores.to_contract()
    ability_keys = ("pron", "accuracy", "fluency", "completeness")
    ability_values = [scores_payload.get(k) for k in ability_keys]
    if any(v is not None for v in ability_values) and all(v == 0 for v in ability_values if v is not None):
        for key in ability_keys:
            scores_payload[key] = None
        warnings.append("scores_unavailable")

    return {
        "provider": provider_name,
        "granularity": result.granularity,
        "mode": result.mode,
        "reference_text": result.reference_text,
        "recognized_text": result.recognized_text,
        "duration_ms": result.duration_ms,
        "scores": scores_payload,
        "words": [word.to_contract() for word in result.words],
        "issues": [issue.to_contract() for issue in result.issues],
        "intonation": intonation.to_contract(),
        "warnings": dedupe_warnings(warnings),
        "provider_meta": provider_meta,
    }


# --------------------------------------------------------------------------------------
# 4. tts
# --------------------------------------------------------------------------------------
@router.post("/tts")
async def tts(payload: TTSRequest) -> Response:
    settings = get_settings()
    if payload.rate not in TTS_RATES:
        raise BadRequest(f"rate must be one of {TTS_RATES}, got {payload.rate!r}")
    fmt = (payload.format or "mp3").lower()
    if fmt not in TTS_FORMATS:
        raise BadRequest(f"format must be one of {TTS_FORMATS}, got {payload.format!r}")
    text = payload.text or ""
    if len(text) > settings.max_tts_chars:
        raise PayloadTooLarge(f"text too long: {len(text)} chars > {settings.max_tts_chars}")
    if not text.strip() and not (payload.ssml or "").strip():
        raise BadRequest("either text or ssml is required")

    providers = get_providers()
    cache = get_cache()
    resolved_voice = payload.voice or settings.default_tts_voice
    tts_provider = tts_provider_name(providers)
    # ssml 无法用 text 作为 key（同一段文本配不同 SSML 是不同产物）→ 带 ssml 的请求跳过缓存；
    # CACHE_ENABLED=false 时同样不读不写。
    cache_hash: str | None = None
    cache_state = "disabled"
    if not payload.ssml and cache.enabled:
        cache_hash = cache_key(text, resolved_voice, payload.rate, tts_provider, fmt)
        cache_state = "miss"
        hit = await run_in_threadpool(cache.get_audio, cache_hash)
        if hit is not None:
            cached_audio, cached_ext = hit
            probe = await run_in_threadpool(_safe_probe, cached_audio)
            return Response(
                content=cached_audio,
                media_type=CONTENT_TYPES.get("." + cached_ext, "application/octet-stream"),
                headers=_tts_headers(tts_provider, probe, "hit", fallback=False),
            )

    def _generate():
        """合成（或再查一次缓存）：同一 key 并发时只真正生成一次。"""
        if cache_hash is not None:
            again = cache.get_audio(cache_hash)
            if again is not None:
                return again[0], EXT_CONTENT_TYPES.get(again[1], "application/octet-stream"), tts_provider, False
        result, name, fallback_flag, _errors = execution.run_chain(
            providers.tts_chain,
            lambda provider: provider.synthesize(
                text=text, voice=payload.voice, rate=payload.rate, fmt=fmt, ssml=payload.ssml
            ),
            execution.TIMEOUTS["tts"],
            kind="tts",
        )
        if result is None:
            data, content_type, _duration = degraded_tts(text, voice=payload.voice, rate=payload.rate)
            return data, content_type, "degraded", True
        return result.audio, result.content_type, name, fallback_flag

    if cache_hash is not None:
        audio, content_type, provider_name, fallback = await run_in_threadpool(
            SINGLE_FLIGHT.run, cache_hash, _generate
        )
    else:
        audio, content_type, provider_name, fallback = await run_in_threadpool(_generate)

    # 只缓存"主 provider 正常产出"的音频：降级音/兜底音绝不能固化（否则会永久给错音频）
    if cache_hash is not None and not fallback and provider_name != "degraded":
        try:
            await run_in_threadpool(cache.put_audio, cache_hash, audio, ext_from_content_type(content_type))
        except Exception:  # noqa: BLE001 - 缓存写失败不影响本次返回
            pass

    probe = await run_in_threadpool(_safe_probe, audio)
    return Response(
        content=audio,
        media_type=content_type,
        headers=_tts_headers(provider_name, probe, cache_state, fallback=bool(fallback)),
    )


def _safe_probe(data: bytes):
    """探测真实 codec/采样率/时长；失败返回 None（不影响响应）。"""
    try:
        return probe_audio(data)
    except Exception:  # noqa: BLE001
        return None


def _tts_headers(provider_name: str, probe, cache_state: str, fallback: bool) -> dict:
    """契约要求始终带 X-TTS-Provider + X-Audio-Duration-Ms；其余为便于验收/排障的附加头。"""
    duration_ms = getattr(probe, "duration_ms", 0) or 0
    headers = {
        "X-TTS-Provider": provider_name,
        "X-Audio-Duration-Ms": str(int(duration_ms)),
        "X-Cache": cache_state,
        "Cache-Control": "no-store",
    }
    if probe is not None:
        headers["X-Audio-Codec"] = f"{probe.codec}"
        headers["X-Audio-Sample-Rate"] = str(int(probe.sample_rate))
        headers["X-Audio-Container"] = f"{probe.container}"
    if fallback or provider_name == "degraded":
        headers["X-TTS-Fallback"] = "1"
    return headers


# --------------------------------------------------------------------------------------
# 5. feedback
# --------------------------------------------------------------------------------------
@router.post("/feedback")
async def feedback(payload: FeedbackRequest) -> dict:
    body = payload.model_dump()
    if is_no_speech_payload(body):
        # 硬要求：整句没被录进来时不得出现任何表扬词。LLM 输出不可控，这一支直接走模板。
        return template_feedback(body)
    learner = body.get("learner") or {}
    child = str(learner.get("age_band") or "adult") == "child"
    llm = LLMClient()
    if llm.available:
        system_prompt = FEEDBACK_SYSTEM_PROMPT + ("\n" + CHILD_EXTRA_RULE if child else "")
        outcome = llm.chat_json(
            system_prompt,
            build_feedback_user_prompt(body, llm_available=True),
            timeout_s=execution.TIMEOUTS["feedback"],
        )
        if outcome.ok and outcome.data:
            cleaned = sanitize_feedback(outcome.data, child)
            if cleaned.get("summary") or cleaned.get("points"):
                return {"provider": outcome.provider, **cleaned}
    return template_feedback(body)


# --------------------------------------------------------------------------------------
# 6. dialogue
# --------------------------------------------------------------------------------------
@router.post("/dialogue")
async def dialogue(payload: DialogueRequest) -> dict:
    body = payload.model_dump()
    if body.get("correction_level") not in (None, "", "gentle", "standard", "none"):
        raise BadRequest(f"correction_level invalid: {body.get('correction_level')!r}")
    # complete_dialogue 内部：LLM 优先 -> JSON 失败严格重试一次 -> 降级模板；
    # 返回体始终带 provider 与 degraded_llm（降级不伪装成大模型）。
    # httpx 是阻塞调用，放线程池避免卡住事件循环。
    return await run_in_threadpool(complete_dialogue, LLMClient(), body, execution.TIMEOUTS["dialogue"])


# --------------------------------------------------------------------------------------
# 9. ocr（task-25：拍照识别书页英文，离线 rapidocr，不落盘）
# --------------------------------------------------------------------------------------
@router.post("/ocr")
async def ocr(image: UploadFile = File(...)) -> dict:
    settings = get_settings()
    data = await _read_upload(image, settings.max_ocr_bytes)
    if not data:
        raise BadRequest("empty image payload")
    result = await run_in_threadpool(recognize_image, data, settings)
    return result.to_contract()


# --------------------------------------------------------------------------------------
# 8. warmup（契约 v1.1 §12）
# --------------------------------------------------------------------------------------
@router.post("/warmup")
async def warmup(payload: WarmupRequest) -> dict:
    settings = get_settings()
    items = list(payload.items or [])
    if not items:
        raise BadRequest("items must contain at least 1 entry")
    if len(items) > settings.warmup_max_items:
        raise PayloadTooLarge(f"too many items: {len(items)} > {settings.warmup_max_items}")

    concurrency = payload.concurrency
    if concurrency is None:
        concurrency = settings.warmup_default_concurrency
    try:
        concurrency = int(concurrency)
    except (TypeError, ValueError):
        raise BadRequest(f"concurrency must be an integer in 1..8, got {payload.concurrency!r}") from None
    if not 1 <= concurrency <= 8:
        raise BadRequest(f"concurrency must be in 1..8, got {concurrency}")

    specs = []
    for item in items:
        spec = resolve_item(item)
        problem = validate_item(spec, settings)
        if problem:
            raise BadRequest(f"invalid item: {problem}")
        specs.append(spec)

    # 预热是后台任务：放线程池跑，单条失败不影响整体
    return await run_in_threadpool(
        run_warmup,
        specs,
        concurrency,
        cache=get_cache(),
        providers=get_providers(),
    )


# --------------------------------------------------------------------------------------
# 7. audio
# --------------------------------------------------------------------------------------
_AUDIO_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,80}\.(wav|mp3|ogg|m4a|opus|webm)$")


@router.get("/audio/{audio_id}")
async def get_audio(audio_id: str) -> Response:
    store = _store()
    store.validate_id(audio_id)  # 先做 id 形状校验（防目录穿越），再做缓存/legacy 查找
    path = await run_in_threadpool(get_cache().resolve_external_id, audio_id)
    if path is not None:
        data = await run_in_threadpool(path.read_bytes)
        ext = path.suffix.lstrip(".").lower()
        return Response(
            content=data,
            media_type=CONTENT_TYPES.get("." + ext, "application/octet-stream"),
            headers={"Cache-Control": CACHE_CONTROL},
        )
    data, content_type = await run_in_threadpool(store.read, audio_id)
    return Response(
        content=data,
        media_type=content_type or CONTENT_TYPES.get("." + audio_id.rsplit(".", 1)[-1].lower(), "application/octet-stream"),
        headers={"Cache-Control": CACHE_CONTROL},
    )
