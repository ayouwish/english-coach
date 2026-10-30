"""azure provider：Azure Speech SDK（ASR + Pronunciation Assessment + Neural TTS）。

- **惰性导入**：只有真的选到 azure 时才 ``import azure.cognitiveservices.speech``；
  没装 SDK 或没配 key 只会抛 ``ProviderUnavailable``，mock 模式启动完全不受影响。
- Pronunciation Assessment 参数按 task-1：Phoneme granularity、enable_miscue、enable_prosody_assessment、
  phoneme_alphabet=IPA、nbest_phoneme_count=5。
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading

from ..audio_io import AudioClip, probe_audio, trim_wav_silence
from ..config import Settings, get_settings
from ..languages import normalize_language
from ..voice_names import normalize_voice_name, voice_locale
from ..errors import ProviderError, ProviderTimeout, ProviderUnavailable
from ..hints import LIKELY_SUBSTITUTION
from ..text import syllable_count, tokens
from .base import (
    ASRResult,
    Capabilities,
    PAResult,
    PAScores,
    PhonemeScore,
    TTSResult,
    WordScore,
    WordTiming,
    build_issue,
    sort_and_cap_issues,
)

logger = logging.getLogger("voice.azure")

TICKS_PER_MS = 10_000  # Azure offset/duration 单位是 100ns


def _speechsdk():
    try:
        import azure.cognitiveservices.speech as speechsdk  # 惰性导入
    except Exception as exc:  # pragma: no cover - 依赖未安装
        raise ProviderUnavailable(
            "azure-cognitiveservices-speech is not installed; run `uv sync --extra azure`",
            provider="azure",
            detail=str(exc),
        ) from exc
    return speechsdk


def _speech_config(settings: Settings, speechsdk):
    if not settings.azure_speech_key:
        raise ProviderUnavailable("AZURE_SPEECH_KEY is not set", provider="azure")
    if settings.azure_speech_endpoint:
        config = speechsdk.SpeechConfig(subscription=settings.azure_speech_key, endpoint=settings.azure_speech_endpoint)
    elif settings.azure_speech_region:
        config = speechsdk.SpeechConfig(subscription=settings.azure_speech_key, region=settings.azure_speech_region)
    else:
        raise ProviderUnavailable("AZURE_SPEECH_REGION (or AZURE_SPEECH_ENDPOINT) is not set", provider="azure")
    config.speech_recognition_language = "en-US"
    return config


def _write_temp_wav(clip: AudioClip) -> str:
    handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    handle.write(clip.to_wav_bytes())
    handle.close()
    return handle.name


def _ms(ticks) -> int:
    try:
        return int(round(float(ticks) / TICKS_PER_MS))
    except Exception:
        return 0


def _check_result(result, speechsdk, provider: str = "azure"):
    reason = getattr(result, "reason", None)
    if reason == speechsdk.ResultReason.Canceled:
        try:
            cancellation = result.cancellation_details
            detail = f"{cancellation.reason}: {cancellation.error_details}"
        except Exception:
            detail = "canceled"
        if "timeout" in detail.lower():
            raise ProviderTimeout(f"{provider} timed out: {detail}", provider=provider)
        raise ProviderError(f"{provider} request failed: {detail}", provider=provider)
    return result


def azure_status() -> tuple[bool, str | None]:
    """健康检查用：Azure 语音是否**真的可用**（SDK 已安装 + key/region 已配置）。"""
    try:
        _speechsdk()
    except ProviderUnavailable as exc:
        return False, exc.message
    settings = get_settings()
    if not settings.azure_speech_key:
        return False, "AZURE_SPEECH_KEY 未配置"
    if not (settings.azure_speech_endpoint or settings.azure_speech_region):
        return False, "AZURE_SPEECH_REGION（或 AZURE_SPEECH_ENDPOINT）未配置"
    return True, None



# --------------------------------------------------------------------------------------
# 连续识别（task-56）：recognize_once 遇到第一段静音就返回 → 中间停顿会丢后半句
# --------------------------------------------------------------------------------------
def _apply_segmentation_timeout(config, speechsdk, settings: Settings) -> None:
    """放宽"段间静音判定"（默认 1500ms），避免一口气读完被切成很多碎段。"""
    try:
        property_id = getattr(speechsdk.PropertyId, "Speech_SegmentationSilenceTimeoutMs", None)
        if property_id is None:
            return
        value = str(int(settings.azure_segmentation_silence_timeout_ms))
        config.set_property(property_id, value)
    except Exception as exc:  # 老版本 SDK 不支持该属性时不要影响识别
        logger.warning("azure set segmentation silence timeout failed: %s", exc)


def _continuous_recognize(speechsdk, recognizer, settings: Settings) -> list:
    """连续识别：收集所有 RecognizedSpeech 事件，等会话结束/超时后停止。

    - 返回 result 列表（空 = 没有识别到语音，由调用方映射成原有 no-speech 语义）
    - `speechsdk.CancellationReason.Error` → ProviderError（原有 provider error 语义）
    - 等不到会话结束且零结果 → ProviderTimeout（原有超时语义）
    """
    results: list = []
    errors: list[str] = []
    done = threading.Event()

    def on_recognized(event) -> None:
        try:
            result = getattr(event, "result", None)
            if result is None:
                return
            if getattr(result, "reason", None) == speechsdk.ResultReason.RecognizedSpeech:
                text = (getattr(result, "text", "") or "").strip()
                if text:
                    results.append(result)
        except Exception as exc:  # 事件回调异常不能影响会话
            logger.warning("azure recognized-event handler failed: %s", exc)

    def on_canceled(event) -> None:
        try:
            result = getattr(event, "result", None)
            details = getattr(result, "cancellation_details", None)
            reason = getattr(details, "reason", None)
            cancellation_reason = getattr(speechsdk, "CancellationReason", None)
            if cancellation_reason is not None and reason == getattr(cancellation_reason, "Error", None):
                errors.append(getattr(details, "error_details", "") or "canceled")
        except Exception as exc:
            logger.warning("azure canceled-event handler failed: %s", exc)
        finally:
            done.set()

    def on_session_stopped(event) -> None:  # noqa: ARG001 - 会话结束（文件读完 EOF）
        done.set()

    recognizer.recognized.connect(on_recognized)
    recognizer.canceled.connect(on_canceled)
    recognizer.session_stopped.connect(on_session_stopped)

    start_future = recognizer.start_continuous_recognition_async()
    if hasattr(start_future, "get"):
        start_future.get()
    finished = done.wait(float(settings.azure_asr_timeout_s))
    try:
        stop_future = recognizer.stop_continuous_recognition_async()
        if hasattr(stop_future, "get"):
            stop_future.get()
    except Exception as exc:
        logger.warning("azure stop continuous recognition failed: %s", exc)

    if errors:
        raise ProviderError(f"azure continuous recognition failed: {errors[0]}", provider="azure")
    if not finished and not results:
        raise ProviderTimeout("azure continuous recognition timed out", provider="azure")
    if not finished:
        logger.warning("azure continuous recognition timed out with %d partial result(s)", len(results))
    return results


def _join_recognized_text(results: list) -> str:
    return " ".join((getattr(result, "text", "") or "").strip() for result in results if (getattr(result, "text", "") or "").strip())


class AzureASR:
    name = "azure"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def recognize(self, clip: AudioClip, language: str = "en", prompt: str | None = None) -> ASRResult:
        speechsdk = _speechsdk()
        settings = get_settings()
        config = _speech_config(settings, speechsdk)
        # task-47：language 可能是 en/zh（短代码）或完整 locale；统一成 Azure 需要的 en-US / zh-CN
        locale = normalize_language(language) or "en-US"
        config.speech_recognition_language = locale
        _apply_segmentation_timeout(config, speechsdk, settings)
        path = _write_temp_wav(clip)
        try:
            audio_config = speechsdk.audio.AudioConfig(filename=path)
            recognizer = speechsdk.SpeechRecognizer(speech_config=config, audio_config=audio_config)
            # task-56：连续识别（recognize_once 遇第一段静音就返回，会丢后半句）
            results = _continuous_recognize(speechsdk, recognizer, settings)
            if not results:
                raise ProviderError("azure returned no match", provider="azure")
            text = _join_recognized_text(results)
            if not text:
                raise ProviderError("azure returned no match", provider="azure")
            words = []
            for result in results:
                words.extend(_words_from_json(result))
            return ASRResult(
                text=text,  # 中文也原样返回（不做英文后处理/过滤）
                language=locale,
                duration_ms=clip.duration_ms,
                words=words,
                provider=self.name,
                provider_meta={"region": settings.azure_speech_region or "endpoint", "segments": len(results)},
            )
        finally:
            _safe_unlink(path)


class AzurePA:
    name = "azure"
    capabilities = Capabilities(phoneme_level=True, prosody=True, nbest_phonemes=True, ssml=False)

    def assess(
        self,
        clip: AudioClip,
        reference_text: str,
        mode: str = "scripted",
        granularity: str = "phoneme",
        with_intonation: bool = True,
        learner_age_band: str | None = None,
    ) -> PAResult:
        speechsdk = _speechsdk()
        settings = get_settings()
        config = _speech_config(settings, speechsdk)
        _apply_segmentation_timeout(config, speechsdk, settings)
        path = _write_temp_wav(clip)
        try:
            audio_config = speechsdk.audio.AudioConfig(filename=path)
            recognizer = speechsdk.SpeechRecognizer(speech_config=config, audio_config=audio_config)
            scripted = bool(reference_text.strip()) and mode != "unscripted"
            if scripted:
                pa_config = speechsdk.PronunciationAssessmentConfig(
                    reference_text=reference_text,
                    grading_system=speechsdk.PronunciationAssessmentGradingSystem.HundredMark,
                    granularity=speechsdk.PronunciationAssessmentGranularity.Phoneme,
                    enable_miscue=True,
                )
                try:
                    pa_config.phoneme_alphabet = "IPA"
                    pa_config.nbest_phoneme_count = 5
                except Exception:
                    pass
                try:
                    pa_config.enable_prosody_assessment()
                except Exception:
                    pass
                pa_config.apply_to(recognizer)

            # task-56：连续识别（遇到停顿不再丢掉后半句）；各段按空格拼接
            results = _continuous_recognize(speechsdk, recognizer, settings)
            if not results:
                raise ProviderError("azure returned no match", provider="azure")
            recognized_text = _join_recognized_text(results)

            if not scripted:
                return PAResult(
                    provider=self.name,
                    granularity="word",
                    mode=mode or "scripted",
                    reference_text=reference_text or "",
                    recognized_text=recognized_text,
                    duration_ms=clip.duration_ms,
                    scores=PAScores(
                        pron=None,
                        accuracy=None,
                        fluency=_fluency_from_text(recognized_text, clip.duration_ms, learner_age_band),
                        completeness=None,
                        prosody=None,
                    ),
                    words=[],
                    issues=[],
                    warnings=[],
                    provider_meta={"unscripted": True, "segments": len(results)},
                )

            # 多段合并：words 串联；分数按每段"词时长"加权平均（单段时与原行为一致）
            words: list[WordScore] = []
            issues = []
            totals = {key: 0.0 for key in ("pron", "accuracy", "fluency", "completeness", "prosody")}
            weight_by_key = {key: 0.0 for key in totals}
            for result in results:
                try:
                    assessment = speechsdk.PronunciationAssessmentResult(result)
                except Exception as exc:
                    logger.warning("azure PA result parse failed for one segment: %s", exc)
                    continue
                segment_words: list[WordScore] = []
                for item in getattr(assessment, "words", None) or []:
                    start = _ms(getattr(item, "offset", 0))
                    end = start + _ms(getattr(item, "duration", 0))
                    phonemes: list[PhonemeScore] = []
                    for ph in getattr(item, "phonemes", None) or []:
                        ph_start = _ms(getattr(ph, "offset", 0))
                        ph_end = ph_start + _ms(getattr(ph, "duration", 0))
                        nbest = []
                        for candidate in getattr(ph, "nbest_phonemes", None) or []:
                            nbest.append(
                                {
                                    "phoneme": getattr(candidate, "phoneme", None),
                                    "score": float(getattr(candidate, "score", 0.0) or 0.0),
                                }
                            )
                        phonemes.append(
                            PhonemeScore(
                                phoneme=getattr(ph, "phoneme", "") or "",
                                score=float(getattr(ph, "accuracy_score", 0.0) or 0.0),
                                start_ms=ph_start,
                                end_ms=ph_end,
                                nbest=nbest,
                            )
                        )
                    error_type = getattr(item, "error_type", "None") or "None"
                    segment_words.append(
                        WordScore(
                            word=getattr(item, "word", "") or "",
                            start_ms=start,
                            end_ms=end,
                            score=float(getattr(item, "accuracy_score", 0.0) or 0.0),
                            error_type=error_type,
                            phonemes=phonemes,
                        )
                    )
                    if error_type != "None":
                        culprit = min(phonemes, key=lambda p: p.score) if phonemes else None
                        actual = None
                        if culprit and culprit.nbest:
                            best = max(culprit.nbest, key=lambda n: n.get("score") or 0.0)
                            if best.get("phoneme") and best.get("phoneme") != culprit.phoneme:
                                actual = best.get("phoneme")
                        if actual is None and culprit:
                            actual = LIKELY_SUBSTITUTION.get(culprit.phoneme)
                        issues.append(
                            build_issue(
                                word=getattr(item, "word", "") or "",
                                phoneme=culprit.phoneme if culprit else None,
                                expected=culprit.phoneme if culprit else None,
                                actual=actual,
                                score=culprit.score if culprit else float(getattr(item, "accuracy_score", 0.0) or 0.0),
                                start_ms=culprit.start_ms if culprit else start,
                                end_ms=culprit.end_ms if culprit else end,
                                error_type=error_type,
                            )
                        )
                weight = max(1.0, float(sum(max(1, word.end_ms - word.start_ms) for word in segment_words) or 1))
                for key, attr in (
                    ("pron", "pronunciation_score"),
                    ("accuracy", "accuracy_score"),
                    ("fluency", "fluency_score"),
                    ("completeness", "completeness_score"),
                    ("prosody", "prosody_score"),
                ):
                    value = _opt(getattr(assessment, attr, None))
                    if value is not None:
                        totals[key] += value * weight
                        weight_by_key[key] += weight
                words.extend(segment_words)

            merged = {
                key: (totals[key] / weight_by_key[key] if weight_by_key[key] > 0 else None)
                for key in totals
            }
            warnings: list[str] = []
            granularity_out = "phoneme" if granularity == "phoneme" else "word"
            if granularity_out == "word":
                for word in words:
                    word.phonemes = []

            return PAResult(
                provider=self.name,
                granularity=granularity_out,
                mode=mode or "scripted",
                reference_text=reference_text,
                recognized_text=recognized_text,
                duration_ms=clip.duration_ms,
                scores=PAScores(
                    pron=merged["pron"],
                    accuracy=merged["accuracy"],
                    fluency=merged["fluency"],
                    completeness=merged["completeness"],
                    prosody=merged["prosody"],
                ),
                words=words,
                issues=sort_and_cap_issues(issues, limit=5),
                warnings=warnings,
                provider_meta={"grading_system": "HundredMark", "phoneme_alphabet": "IPA", "segments": len(results)},
            )
        finally:
            _safe_unlink(path)


class AzureTTS:
    name = "azure"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=True)

    _FORMATS = {
        "mp3": ("Audio24Khz96KBitRateMonoMp3", "audio/mpeg"),
        "wav": ("Riff24Khz16BitMonoPcm", "audio/wav"),
    }

    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        rate: str = "normal",
        fmt: str = "mp3",
        ssml: str | None = None,
    ) -> TTSResult:
        speechsdk = _speechsdk()
        settings = get_settings()
        config = _speech_config(settings, speechsdk)
        # task-46：语音名必须是安全字符（防 SSML/配置注入）；非法则回退默认音色
        voice_name = normalize_voice_name(voice) or normalize_voice_name(settings.azure_tts_voice) or settings.azure_tts_voice
        config.speech_synthesis_voice_name = voice_name
        fmt_key, fmt_name, content_type = self._resolve_format(fmt)
        _apply_output_format(config, speechsdk, fmt_name)
        synth = speechsdk.SpeechSynthesizer(speech_config=config, audio_config=None)

        if ssml:
            result = synth.speak_ssml_async(ssml).get()
        elif rate == "slow":
            escaped = (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            # task-46：xml:lang 必须与语音的 locale 一致（否则 zh 音色会被写成 en-US → 念歪/400）。
            # 推导：voice -> 默认音色 -> en-US。
            locale = voice_locale(voice_name, settings.azure_tts_voice)
            ssml_payload = (
                f'<speak version="1.0" xml:lang="{locale}"><voice name="{voice_name}">'
                f'<prosody rate="-30%">{escaped}</prosody></voice></speak>'
            )
            result = synth.speak_ssml_async(ssml_payload).get()
        else:
            result = synth.speak_text_async(text or "").get()

        _check_result(result, speechsdk)
        audio = getattr(result, "audio_data", None)
        if not audio:
            raise ProviderError("azure TTS returned empty audio", provider="azure")
        audio_bytes = bytes(audio)
        # 防回归：只有解码真实字节才能发现"标称 mp3、实物 16kHz PCM"这类静默失效
        probe = verify_audio_format(audio_bytes, fmt_key)
        duration_ms = probe.duration_ms if probe is not None else 0
        if not duration_ms:
            try:
                duration_ms = int(getattr(result, "audio_duration", 0).total_seconds() * 1000)
            except Exception:
                duration_ms = 0
        # task-39：Azure 对短词会在尾部带 ~1.3s 低电平噪声（"think" 总 1.82s、语音 0.19s）。
        # 只对 WAV(PCM) 裁首尾静音；mp3 不裁（无 ffmpeg，重编码不值得）。裁剪后的字节进缓存。
        if fmt_key == "wav" and settings.tts_trim_silence:
            trimmed, changed = trim_wav_silence(
                audio_bytes, settings.tts_trim_threshold_db, settings.tts_trim_keep_ms
            )
            if changed:
                new_probe = probe_audio(trimmed)
                logger.info(
                    "azure TTS trimmed silence: %dms -> %dms (text=%.40r)",
                    duration_ms,
                    new_probe.duration_ms,
                    text or "",
                )
                audio_bytes = trimmed
                duration_ms = new_probe.duration_ms
        return TTSResult(audio=audio_bytes, content_type=content_type, provider=self.name, duration_ms=duration_ms, format=fmt_key)

    @classmethod
    def _resolve_format(cls, fmt: str | None) -> tuple[str, str, str]:
        fmt_key = (fmt or "mp3").lower()
        fmt_name, content_type = cls._FORMATS.get(fmt_key, cls._FORMATS["mp3"])
        if fmt_key not in cls._FORMATS:
            fmt_key = "mp3"
        return fmt_key, fmt_name, content_type


# 请求格式 -> 期望的真实容器/编码（用于防回归校验）
_EXPECTED_CONTAINERS = {"mp3": {"mp3"}, "wav": {"wav", "wav_pcm"}}
# task-42：wav 必须 ≥24kHz（我们只产出 Riff24Khz；16kHz 是"SDK 静默退回默认格式"的坏产物，电话音）
_EXPECTED_MIN_RATE = {"mp3": 16000, "wav": 24000}


def _apply_output_format(config, speechsdk, fmt_name: str) -> None:
    """用**正确 API** 设置输出格式。

    坑（task-15 的真实 bug）：Azure SDK 的 `SpeechConfig` **没有**
    `speech_synthesis_output_format` 属性，只有 `set_speech_synthesis_output_format()`。
    写成 `config.speech_synthesis_output_format = ...` 不会报错（Python 允许动态加属性），
    只是加了个没人读的属性 → SDK 一直用默认 `Riff16Khz16BitMonoPcm`（16kHz，听起来发闷），
    而 `content_type` 仍标成 mp3。所以这里既要求 setter 存在，也绝不允许退回属性赋值。
    """
    output_format = getattr(speechsdk.SpeechSynthesisOutputFormat, fmt_name, None)
    if output_format is None:
        raise ProviderError(f"azure SDK 缺少 SpeechSynthesisOutputFormat.{fmt_name}", provider="azure")
    setter = getattr(config, "set_speech_synthesis_output_format", None)
    if not callable(setter):
        raise ProviderError(
            "azure SpeechConfig 缺少 set_speech_synthesis_output_format()（SDK 版本不兼容）；"
            "不要退回属性赋值——那样会静默失效并产出 16kHz 音频",
            provider="azure",
        )
    setter(output_format)


def verify_audio_format(data: bytes, fmt: str):
    """校验返回字节的真实容器/采样率是否与请求格式相符；不符则打 ERROR 日志（不静默）。

    返回 `AudioProbe`（失败时返回 None）。可用性优先：不因为格式不符就抛错让用户没声音，
    但**必须留下响亮的日志**，并且 `/v1/tts` 会把真实的 codec/rate 回在响应头里。
    """
    from ..audio_io import probe_audio

    try:
        probe = probe_audio(data)
    except Exception as exc:
        logger.warning("azure TTS 音频无法探测格式: %s", exc)
        return None

    expected_containers = _EXPECTED_CONTAINERS.get(fmt, set())
    container_ok = probe.container in expected_containers or (fmt == "mp3" and probe.codec.startswith("mp3"))
    min_rate = _EXPECTED_MIN_RATE.get(fmt, 16000)
    if probe.sample_rate < min_rate:
        # 低采样率 = 带宽被限（16kHz 只有 ~4kHz 高频）→ "浑浊/电话音"。
        # 绝不静默返回：抛错让调用链降级，避免把坏音频写进缓存（task-42 的旧 bug 就是这么进缓存的）。
        raise ProviderError(
            f"azure TTS 输出采样率过低：请求 {fmt}（≥{min_rate}Hz），实际 {probe.sample_rate}Hz"
            "（检查 set_speech_synthesis_output_format 是否生效——旧 bug 会静默退回 16kHz）",
            provider="azure",
        )
    if not container_ok:
        logger.error(
            "azure TTS 返回的音频容器与请求格式不符：请求 %s，实际 container=%s codec=%s rate=%sHz",
            fmt,
            probe.container,
            probe.codec,
            probe.sample_rate,
        )
    return probe


def _words_from_json(result) -> list[WordTiming]:
    import json

    try:
        payload = json.loads(getattr(result, "json", "") or "{}")
        best = (payload.get("NBest") or [{}])[0]
        out = []
        for item in best.get("Words", []) or []:
            start = _ms(item.get("Offset", 0))
            out.append(
                WordTiming(
                    word=str(item.get("Word", "")),
                    start_ms=start,
                    end_ms=start + _ms(item.get("Duration", 0)),
                    probability=float(item.get("Confidence", 0.0) or 0.0),
                )
            )
        return out
    except Exception:
        return []


def _opt(value):
    try:
        return None if value is None else float(value)
    except Exception:
        return None


def _fluency_from_text(text: str, duration_ms: int, learner_age_band: str | None) -> float:
    syllables = sum(syllable_count(w) for w in tokens(text)) or 1
    seconds = max(0.25, duration_ms / 1000.0)
    ideal = 2.6 if (learner_age_band or "child") == "child" else 3.8
    rate = syllables / seconds
    return float(round(min(100.0, max(40.0, 100.0 - 28.0 * abs(rate - ideal) / ideal)), 1))


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except Exception:
        pass
