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

from ..audio_io import AudioClip
from ..config import Settings, get_settings
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


class AzureASR:
    name = "azure"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def recognize(self, clip: AudioClip, language: str = "en", prompt: str | None = None) -> ASRResult:
        speechsdk = _speechsdk()
        settings = get_settings()
        config = _speech_config(settings, speechsdk)
        if language:
            config.speech_recognition_language = "en-US" if language == "en" else language
        path = _write_temp_wav(clip)
        try:
            audio_config = speechsdk.audio.AudioConfig(filename=path)
            recognizer = speechsdk.SpeechRecognizer(speech_config=config, audio_config=audio_config)
            result = _check_result(recognizer.recognize_once_async().get(), speechsdk)
            if result.reason == speechsdk.ResultReason.NoMatch:
                raise ProviderError("azure returned no match", provider="azure")
            text = getattr(result, "text", "") or ""
            words = _words_from_json(result)
            return ASRResult(
                text=text,
                language=language or "en",
                duration_ms=clip.duration_ms,
                words=words,
                provider=self.name,
                provider_meta={"region": settings.azure_speech_region or "endpoint"},
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

            result = _check_result(recognizer.recognize_once_async().get(), speechsdk)
            if result.reason == speechsdk.ResultReason.NoMatch:
                raise ProviderError("azure returned no match", provider="azure")

            if not scripted:
                return PAResult(
                    provider=self.name,
                    granularity="word",
                    mode=mode or "scripted",
                    reference_text=reference_text or "",
                    recognized_text=getattr(result, "text", "") or "",
                    duration_ms=clip.duration_ms,
                    scores=PAScores(
                        pron=None,
                        accuracy=None,
                        fluency=_fluency_from_text(getattr(result, "text", "") or "", clip.duration_ms, learner_age_band),
                        completeness=None,
                        prosody=None,
                    ),
                    words=[],
                    issues=[],
                    warnings=[],
                    provider_meta={"unscripted": True},
                )

            assessment = speechsdk.PronunciationAssessmentResult(result)
            words: list[WordScore] = []
            issues = []
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
                words.append(
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
                recognized_text=getattr(result, "text", "") or "",
                duration_ms=clip.duration_ms,
                scores=PAScores(
                    pron=_opt(getattr(assessment, "pronunciation_score", None)),
                    accuracy=_opt(getattr(assessment, "accuracy_score", None)),
                    fluency=_opt(getattr(assessment, "fluency_score", None)),
                    completeness=_opt(getattr(assessment, "completeness_score", None)),
                    prosody=_opt(getattr(assessment, "prosody_score", None)),
                ),
                words=words,
                issues=sort_and_cap_issues(issues, limit=5),
                warnings=warnings,
                provider_meta={"grading_system": "HundredMark", "phoneme_alphabet": "IPA"},
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
        config.speech_synthesis_voice_name = voice or settings.azure_tts_voice
        fmt_key, fmt_name, content_type = self._resolve_format(fmt)
        _apply_output_format(config, speechsdk, fmt_name)
        synth = speechsdk.SpeechSynthesizer(speech_config=config, audio_config=None)

        if ssml:
            result = synth.speak_ssml_async(ssml).get()
        elif rate == "slow":
            escaped = (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            ssml_payload = (
                f'<speak version="1.0" xml:lang="en-US"><voice name="{voice or settings.azure_tts_voice}">'
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
_EXPECTED_MIN_RATE = 16000


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
    if not container_ok or probe.sample_rate < _EXPECTED_MIN_RATE:
        logger.error(
            "azure TTS 返回的音频与请求格式不符：请求 %s，实际 container=%s codec=%s rate=%sHz "
            "（检查 set_speech_synthesis_output_format 是否真的生效）",
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
