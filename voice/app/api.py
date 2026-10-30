"""7 个契约端点的实现。所有非 2xx 都走统一错误格式（error handler 在 main.py）。"""

from __future__ import annotations

import difflib
import logging
import re

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from . import execution
from .audio_io import MIN_TTS_WAV_SAMPLE_RATE, decode_audio, probe_audio, wav_header_info
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
from .errors import BadRequest, PayloadTooLarge, ProviderError, ProviderUnavailable
from .voice_names import is_valid_voice_name
from .languages import SUPPORTED_ASR_LANGUAGES, normalize_language
from .story import retell_story, rewrite_story
from .image_gen import active_provider as image_provider_name, generate_illustration, image_available
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
from .ocr import active_ocr_provider, heif_available, ocr_available, recognize_image
from .phonemes import PHONEME_SPACE_ID, canonicalize_pa_result
from .providers.registry import get_providers, provider_availability
from .schemas import (
    DialogueRequest,
    FeedbackRequest,
    ImageIllustrateRequest,
    StoryRetellRequest,
    StoryRewriteRequest,
    TTSRequest,
    WarmupRequest,
)
from .store import AudioStore, CACHE_CONTROL, CONTENT_TYPES
from .warmup import tts_provider_name
from .text import estimate_word_timings, strip_terminal_punct, tokens
from .warmup import prepare_reference, resolve_item, run_warmup, validate_item

logger = logging.getLogger("voice.api")


def _errors_are_no_speech(errors: list) -> bool:
    """判断链上错误是否全部是"没有识别到语音"（no match / no speech）。"""
    if not errors:
        return False
    text = " ".join(str(item).lower() for item in errors)
    return any(marker in text for marker in ("no match", "nomatch", "no speech", "didn't hear"))


def _provider_status(providers, settings) -> tuple[dict, dict]:
    """健康检查：配置的 provider 是否真的可用；不可用则找链上第一个可用的真实兜底。

    -> (degraded, effective)。degraded[kind] = {configured, effective, reason}，健康时为空 dict。
    task-44：线上曾出现 providers.tts=azure 但实际回落到 mock（谎报），必须如实上报。
    """
    degraded: dict = {}
    effective: dict = {}
    for kind, current in (("asr", providers.asr), ("pa", providers.pa), ("tts", providers.tts)):
        configured = getattr(current, "name", "") or ""
        available, reason = provider_availability(kind, configured)
        if available:
            effective[kind] = configured
            continue
        fallback_name = None
        for candidate in getattr(providers, f"{kind}_chain", []) or []:
            candidate_name = getattr(candidate, "name", "") or ""
            if candidate_name in ("", "mock") or candidate_name == configured:
                continue
            if provider_availability(kind, candidate_name)[0]:
                fallback_name = candidate_name
                break
        effective[kind] = fallback_name or ("mock" if settings.mode == "mock" else "none")
        if settings.mode != "mock":
            degraded[kind] = {"configured": configured, "effective": effective[kind], "reason": reason}
    # LLM 与 providers.llm 对齐（它有自己的 degraded_llm 诚实字段，不进 degraded）
    effective["llm"] = settings.llm_provider
    return degraded, effective


def _ensure_real_provider(kind: str, provider_name: str | None) -> None:
    """非 mock 模式下，禁止"配置的 provider 不可用 → 回落到 mock"还返回 200。

    task-44 线上事故：requirements 漏装 azure SDK，TTS/ASR/PA 全部静默降级成 mock，
    用户把合成音当成母语者示范（跟读评分也全是假的）。这里改为 **503 provider_unavailable**。
    """
    settings = get_settings()
    if settings.mode == "mock":
        return
    name = (provider_name or "").lower()
    if name not in ("mock", "", "degraded"):
        return
    providers = get_providers()
    configured = getattr(providers, kind).name
    _ok, reason = provider_availability(kind, configured)
    alternatives = [
        getattr(candidate, "name", "")
        for candidate in (getattr(providers, f"{kind}_chain", []) or [])
        if getattr(candidate, "name", "") not in ("", "mock")
        and provider_availability(kind, getattr(candidate, "name", ""))[0]
    ]
    message = (
        f"{kind.upper()} provider 不可用：{reason or '未安装/未配置'}（配置为 {configured}，已禁止回落到 mock）。"
        "请重建镜像（docker compose build voice）或修复 .env 配置（依赖见 requirements.txt）。"
    )
    if alternatives:
        message += f" 可用替代：{', '.join(dict.fromkeys(alternatives))}。"
    raise ProviderUnavailable(message, provider=configured, code="provider_unavailable")

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
    capabilities["heic"] = heif_available()  # task-38：是否支持从相册选 iPhone HEIC/HEIF 照片
    capabilities["image"] = image_available()  # task-52：文生图是否可用（mock 也算可用）
    capabilities["image_provider"] = image_provider_name()  # "zhipu" | "mock" | null
    # task-44：如实上报"配置的 provider 是否真的可用"（线上曾谎报 azure、实际回落到 mock）
    degraded, effective = _provider_status(providers, settings)
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
        "providers_effective": effective,
        "degraded": degraded,
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
    # task-47：language 支持 en / en-US / zh / zh-CN（大小写不敏感），统一成完整 locale
    normalized_language = normalize_language(language)
    if normalized_language is None:
        raise BadRequest(f"language must be one of {SUPPORTED_ASR_LANGUAGES}, got {language!r}")
    data = await _read_upload(audio, settings.max_upload_bytes)
    clip = await run_in_threadpool(decode_audio, data, 16000, settings.max_audio_seconds)
    providers = get_providers()

    result, provider_name, fallback, errors = execution.run_chain(
        providers.asr_chain,
        lambda provider: provider.recognize(clip, language=normalized_language, prompt=prompt),
        execution.TIMEOUTS["asr"],
        kind="asr",
    )
    if result is None:
        # 连 mock 都失败了：ASR 没有任何可产出的降级内容，只能报 502
        raise ProviderError("all ASR providers failed", provider=provider_name or "asr", detail=errors[-3:])

    actual_provider = getattr(result, "provider", provider_name)
    # task-56：纯静音/太短时有的 provider（如本地 whisper）会返回空文本 → 统一按"没听到"处理，
    # 不能返回 200 + 空 text 让前端误以为识别成功。
    if not (getattr(result, "text", "") or "").strip():
        raise ProviderError("没有识别到语音（静音或说话太短），请再说一次", provider=actual_provider or "asr")
    if (
        settings.mode != "mock"
        and actual_provider in ("mock", "degraded")
        and _errors_are_no_speech(errors)
    ):
        # task-56：纯静音/太短 → 真实 provider 报 "no match"；这时不能拿 mock 文本冒充识别结果，
        # 也不能报成"provider 不可用"，而要给出原有的 no-speech 语义（502 provider_error）。
        raise ProviderError("没有识别到语音（静音或说话太短），请再说一次", provider="asr")
    _ensure_real_provider("asr", actual_provider)
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
    _ensure_real_provider("pa", getattr(result, "provider", provider_name))
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

    # task-46：允许任意**合法**的 Azure 语音名（如 zh-CN-XiaoxiaoNeural）透传；
    # 含引号/尖括号等字符的一律 400（voice 会进 SSML 属性，必须防注入）。
    if payload.voice and not is_valid_voice_name(payload.voice):
        raise BadRequest(f"invalid voice name: {payload.voice!r}（只允许字母/数字/./_/-）")

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
            bad = await run_in_threadpool(
                _purge_low_rate_wav_cache, cache, cache_hash, cached_audio, cached_ext, tts_provider
            )
            if bad is not None:
                hit = None  # 当作 miss：重新合成并写入新缓存（cache_state 仍为 "miss"）
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
            if (
                again is not None
                and _purge_low_rate_wav_cache(cache, cache_hash, again[0], again[1], tts_provider) is None
            ):
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

    # task-44：非 mock 模式下，回落到 mock/degraded 必须报 503，绝不能把合成音当示范音返回 200
    _ensure_real_provider("tts", provider_name)

    # 只缓存"主 provider 正常产出"的音频：降级音/兜底音绝不能固化（否则会永久给错音频）
    # 另外要求**实际产出者 == 缓存 key 里的 provider**，否则会把 piper/mock 音频写进 azure 的 key（污染）
    if cache_hash is not None and not fallback and provider_name != "degraded" and provider_name == tts_provider:
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


def _purge_low_rate_wav_cache(cache, key: str, audio: bytes, ext: str, provider_name: str | None = None) -> dict | None:
    """缓存自愈（task-42）：命中 **azure** 的 wav 但采样率 <24kHz → 删音频 + 连带 F0，返回 header 信息。

    只解析 WAV 头部（≤1KB），不解码整个文件。返回 None 表示"不是坏缓存"。

    只对 azure 生效：16kHz 是 Azure 旧 bug（SDK 静默退回默认格式）的产物；
    mock TTS 本身就是 16kHz、Piper 是 22.05kHz，都是合法输出，不能误伤它们的缓存。
    """
    if (provider_name or "").lower() != "azure":
        return None
    if (ext or "").lower() not in ("wav", "wave"):
        return None
    info = wav_header_info(audio)
    rate = info["sample_rate"] if info else None
    if rate is None or rate >= MIN_TTS_WAV_SAMPLE_RATE:
        return None
    logger.warning(
        "tts cache hit with low sample rate (%dHz < %dHz): purge & re-synthesize "
        "(key=%s, duration=%sms, bytes=%d)",
        rate,
        MIN_TTS_WAV_SAMPLE_RATE,
        key,
        info.get("duration_ms"),
        len(audio),
    )
    cache.delete_audio(key)
    cache.delete_f0(key)  # F0 是对坏音频算的，一并删掉
    return info


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
# 11. image/illustrate（task-52：故事 -> 儿童绘本插画，智谱 GLM-Image）
# --------------------------------------------------------------------------------------
@router.post("/image/illustrate")
async def image_illustrate(payload: ImageIllustrateRequest, force: bool = False) -> dict:
    settings = get_settings()
    return await run_in_threadpool(
        generate_illustration,
        payload.story_text,
        title_en=payload.title_en,
        style=payload.style,
        force=force,
        settings=settings,
    )


# --------------------------------------------------------------------------------------
# 10. story/rewrite（task-47：中文讲述 -> 分级英文故事）
# --------------------------------------------------------------------------------------
@router.post("/story/rewrite")
async def story_rewrite(payload: StoryRewriteRequest) -> dict:
    settings = get_settings()
    return await run_in_threadpool(
        rewrite_story,
        payload.text_zh,
        level=payload.level,
        max_sentences=payload.max_sentences,
        weak_phonemes=payload.weak_phonemes,
        avoid_words=payload.avoid_words,
        settings=settings,
    )


@router.post("/story/retell")
async def story_retell(payload: StoryRetellRequest) -> dict:
    settings = get_settings()
    return await run_in_threadpool(
        retell_story,
        payload.story_sentences,
        payload.transcript,
        level=payload.level,
        settings=settings,
    )


# --------------------------------------------------------------------------------------
# 9. ocr（task-25：拍照识别书页英文，离线 rapidocr，不落盘）
# --------------------------------------------------------------------------------------
@router.post("/ocr")
async def ocr(image: UploadFile = File(...), return_image: str | None = Form(None)) -> dict:
    settings = get_settings()
    data = await _read_upload(image, settings.max_ocr_bytes)
    if not data:
        raise BadRequest("empty image payload")
    wants_image = str(return_image or "").strip().lower() in ("1", "true", "yes", "on")
    result = await run_in_threadpool(recognize_image, data, settings, wants_image)
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
