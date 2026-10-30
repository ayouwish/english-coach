"""local provider（本地兜底）：faster-whisper 词级置信度 + 文本比对 + 停顿分析。

红线（契约 §3.2）：**绝不允许拿 ASR 置信度冒充音素级发音分。**
所以这里只产出 ``granularity="word"`` 的结果，并强制带 ``phoneme_level_unavailable`` warning。

faster-whisper / edge-tts 全部**惰性导入**：没装也不影响 mock 模式启动，只有真的用到 local 才加载。
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import numpy as np

from ..audio_io import AudioClip
from ..config import get_settings
from ..errors import ProviderError, ProviderUnavailable
from ..text import align_sequences, estimate_word_timings, syllable_count, tokens
from .base import (
    ASRResult,
    Capabilities,
    PAResult,
    PAScores,
    TTSResult,
    WordScore,
    WordTiming,
    build_issue,
    pron_score_from_words,
    sort_and_cap_issues,
)

_MODEL_LOCK = threading.Lock()
_MODEL_CACHE: dict[str, object] = {}

PAUSE_MS = 450
MISSING_PAUSE_MS = 120


def resolve_whisper_dir(settings=None) -> str:
    """找到本地 faster-whisper（CTranslate2 格式）模型目录。

    **绝不访问 HuggingFace**（本机 HF 完全不可达）：只认本地路径，模型从 ModelScope 下载，例如
    `snapshot_download("pengzhendong/faster-whisper-small.en", cache_dir=MODELSCOPE_CACHE)`。
    查找顺序：WHISPER_MODEL_PATH → <MODEL_CACHE_DIR>/local/whisper/<name> →
    <voice>/.local-models/whisper/<name> → ModelScope 快照布局。
    """
    settings = settings or get_settings()
    candidates: list[Path] = []
    if settings.whisper_model_path:
        candidates.append(Path(settings.whisper_model_path).expanduser())
    name = settings.whisper_model
    candidates += [
        settings.local_models_dir / "whisper" / name,
        settings.model_cache_dir / "local" / "whisper" / name,
    ]
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "model.bin").is_file():
            return str(candidate)
    raise ProviderUnavailable(
        f"找不到本地 faster-whisper 模型 {name!r}（需要 model.bin）。"
        "请从 ModelScope 下载（如 pengzhendong/faster-whisper-small.en）并用 WHISPER_MODEL_PATH 指定；"
        "本服务不会访问 HuggingFace。",
        provider="local",
    )


def _load_whisper():
    settings = get_settings()
    model_dir = resolve_whisper_dir(settings)
    key = f"{model_dir}|{settings.whisper_device}|{settings.whisper_compute_type}|{settings.whisper_cpu_threads}"
    with _MODEL_LOCK:
        if key in _MODEL_CACHE:
            return _MODEL_CACHE[key]
        try:
            from faster_whisper import WhisperModel  # 惰性导入
        except Exception as exc:  # pragma: no cover - 依赖未安装
            raise ProviderUnavailable(
                "faster-whisper is not installed; run `uv pip install faster-whisper`",
                provider="local",
                detail=str(exc),
            ) from exc
        try:
            model = WhisperModel(
                model_dir,
                device=settings.whisper_device,
                compute_type=settings.whisper_compute_type,
                cpu_threads=max(1, int(settings.whisper_cpu_threads)),
            )
        except Exception as exc:  # pragma: no cover - 模型加载失败
            raise ProviderError(f"failed to load faster-whisper model: {exc}", provider="local") from exc
        _MODEL_CACHE[key] = model
        return model


def transcribe_words(clip: AudioClip, language: str = "en") -> tuple[str, list[WordTiming], dict]:
    """faster-whisper -> (text, word timings, meta)。"""
    model = _load_whisper()
    try:
        segments, info = model.transcribe(
            np.asarray(clip.samples, dtype=np.float32),
            language=language or "en",
            word_timestamps=True,
            vad_filter=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        words: list[WordTiming] = []
        pieces: list[str] = []
        for segment in segments:
            pieces.append((segment.text or "").strip())
            for word in getattr(segment, "words", None) or []:
                token = (word.word or "").strip()
                if not token:
                    continue
                words.append(
                    WordTiming(
                        word=token,
                        start_ms=int(round(float(word.start) * 1000)),
                        end_ms=int(round(float(word.end) * 1000)),
                        probability=float(word.probability) if getattr(word, "probability", None) is not None else None,
                    )
                )
        text = " ".join(p for p in pieces if p).strip()
        text = " ".join(text.split())  # whisper 的词间空格可能重复，压成单空格
        meta = {
            "model": get_settings().whisper_model,
            "language_probability": float(getattr(info, "language_probability", 0.0) or 0.0),
        }
        return text, words, meta
    except (ProviderError, ProviderUnavailable):
        raise
    except Exception as exc:  # pragma: no cover
        raise ProviderError(f"faster-whisper transcription failed: {exc}", provider="local") from exc


class LocalASR:
    name = "local"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def recognize(self, clip: AudioClip, language: str = "en", prompt: str | None = None) -> ASRResult:
        # task-47：faster-whisper 只接受 ISO 639-1（en/zh），从完整 locale 取语言部分
        from ..languages import normalize_language, whisper_language

        normalized = normalize_language(language) or "en-US"
        text, words, meta = transcribe_words(clip, language=whisper_language(normalized))
        if prompt:
            meta["prompt_ignored"] = True
        return ASRResult(
            text=text,
            language=normalized,
            duration_ms=clip.duration_ms,
            words=words,
            provider=self.name,
            provider_meta=meta,
        )


class LocalPA:
    name = "local"
    capabilities = Capabilities(phoneme_level=False, prosody=False, nbest_phonemes=False, ssml=False)

    def assess(
        self,
        clip: AudioClip,
        reference_text: str,
        mode: str = "scripted",
        granularity: str = "phoneme",
        with_intonation: bool = True,
        learner_age_band: str | None = None,
    ) -> PAResult:
        text, hyp_words, meta = transcribe_words(clip)
        ref_tokens = tokens(reference_text)
        scripted = bool(ref_tokens) and mode != "unscripted"
        duration_ms = clip.duration_ms
        warnings = ["phoneme_level_unavailable"]

        if not hyp_words:
            estimated = estimate_word_timings(text, max(200, duration_ms))
            hyp_words = [
                WordTiming(word=item["word"], start_ms=item["start_ms"], end_ms=item["end_ms"], probability=None)
                for item in estimated
            ]

        word_scores: list[WordScore] = []
        issues = []
        if scripted:
            hyp_tokens = [w.word.lower().strip(".,!?;:'\"") for w in hyp_words]
            cursor = 0
            for tag, i1, i2, j1, j2 in align_sequences(ref_tokens, hyp_tokens):
                if tag == "equal":
                    for j in range(j1, j2):
                        hw = hyp_words[j]
                        score = round(min(100.0, (hw.probability or 0.6) * 100.0), 1)
                        word_scores.append(
                            WordScore(word=hw.word, start_ms=hw.start_ms, end_ms=hw.end_ms, score=score, error_type="None", phonemes=[])
                        )
                    cursor = i2
                elif tag == "replace":
                    for offset in range(max(i2 - i1, j2 - j1)):
                        ref_word = ref_tokens[i1 + offset] if i1 + offset < i2 else None
                        hw = hyp_words[j1 + offset] if j1 + offset < j2 else None
                        label = (hw.word if hw else (ref_word or ""))
                        start = hw.start_ms if hw else _estimate_ms(ref_tokens, ref_word, duration_ms)
                        end = hw.end_ms if hw else start + 200
                        score = round(min(100.0, (hw.probability or 0.35) * 78.0), 1) if hw else 25.0
                        word_scores.append(
                            WordScore(word=label, start_ms=start, end_ms=end, score=score, error_type="Mispronunciation", phonemes=[])
                        )
                        issues.append(
                            build_issue(
                                word=label,
                                phoneme=None,
                                expected=ref_word,
                                actual=hw.word if hw else None,
                                score=score,
                                start_ms=start,
                                end_ms=end,
                                error_type="Mispronunciation",
                            )
                        )
                    cursor = i2
                elif tag == "delete":
                    for i in range(i1, i2):
                        start = _estimate_ms(ref_tokens, ref_tokens[i], duration_ms)
                        word_scores.append(
                            WordScore(
                                word=ref_tokens[i],
                                start_ms=start,
                                end_ms=start + 200,
                                score=0.0,
                                error_type="Omission",
                                phonemes=[],
                            )
                        )
                        issues.append(
                            build_issue(
                                word=ref_tokens[i],
                                phoneme=None,
                                expected=ref_tokens[i],
                                actual=None,
                                score=0.0,
                                start_ms=start,
                                end_ms=start + 200,
                                error_type="Omission",
                            )
                        )
                elif tag == "insert":
                    for j in range(j1, j2):
                        hw = hyp_words[j]
                        word_scores.append(
                            WordScore(
                                word=hw.word,
                                start_ms=hw.start_ms,
                                end_ms=hw.end_ms,
                                score=40.0,
                                error_type="Insertion",
                                phonemes=[],
                            )
                        )
                        issues.append(
                            build_issue(hw.word, None, None, hw.word, 40.0, hw.start_ms, hw.end_ms, "Insertion")
                        )
            matched = sum(1 for w in word_scores if w.error_type == "None")
            completeness = round(100.0 * matched / max(1, len(ref_tokens)), 1)
        else:
            for hw in hyp_words:
                score = round(min(100.0, (hw.probability or 0.6) * 100.0), 1)
                word_scores.append(
                    WordScore(word=hw.word, start_ms=hw.start_ms, end_ms=hw.end_ms, score=score, error_type="None", phonemes=[])
                )
            completeness = None

        # 停顿分析（UnexpectedBreak）
        for prev, nxt in zip(hyp_words, hyp_words[1:]):
            gap = nxt.start_ms - prev.end_ms
            if gap >= PAUSE_MS:
                issues.append(
                    build_issue(
                        word=nxt.word,
                        phoneme=None,
                        expected="fluent",
                        actual=f"{gap}ms pause",
                        score=None,
                        start_ms=prev.end_ms,
                        end_ms=nxt.start_ms,
                        error_type="UnexpectedBreak",
                    )
                )

        values = [w.score for w in word_scores]
        accuracy = round(float(np.mean(values)), 1) if values else None
        pron = pron_score_from_words(values)
        fluency = _fluency(hyp_words, duration_ms, learner_age_band)
        meta["reference_alignment"] = "difflib"
        return PAResult(
            provider=self.name,
            granularity="word",  # provider 能力不足：自动降级并带 warning
            mode=mode or "scripted",
            reference_text=reference_text or "",
            recognized_text=text,
            duration_ms=duration_ms,
            scores=PAScores(
                pron=pron,
                accuracy=accuracy,
                fluency=fluency,
                completeness=completeness,
                prosody=None,  # 由 route 的语调模块补齐
            ),
            words=word_scores,
            issues=sort_and_cap_issues(issues, limit=5),
            warnings=warnings,
            provider_meta=meta,
        )


def _estimate_ms(ref_tokens: list[str], word: str | None, duration_ms: int) -> int:
    timings = estimate_word_timings(" ".join(ref_tokens), duration_ms)
    for item in timings:
        if word and item["word"] == word:
            return int(item["start_ms"])
    return 0


def _fluency(words: list[WordTiming], duration_ms: int, learner_age_band: str | None) -> float:
    if not words:
        return 40.0
    seconds = max(0.25, duration_ms / 1000.0)
    syllables = sum(syllable_count(w.word) for w in words) or 1
    rate = syllables / seconds
    ideal = 2.6 if (learner_age_band or "child") == "child" else 3.8
    score = 100.0 - 28.0 * abs(rate - ideal) / ideal
    long_pauses = sum(1 for a, b in zip(words, words[1:]) if b.start_ms - a.end_ms >= PAUSE_MS)
    score -= 6.0 * long_pauses
    return float(round(min(100.0, max(35.0, score)), 1))


class LocalTTS:
    name = "local"
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
        payload = _plain_text(ssml) if ssml else text
        try:
            audio = _edge_tts_sync(payload, voice or settings.edge_tts_voice, "+0%" if rate != "slow" else "-30%")
        except Exception as exc:
            raise ProviderError(f"edge-tts failed: {exc}", provider="local") from exc
        return TTSResult(audio=audio, content_type="audio/mpeg", provider=self.name, duration_ms=0, format="mp3")


def _plain_text(ssml: str) -> str:
    import re

    return " ".join(re.sub(r"<[^>]+>", " ", ssml or "").split())


def _edge_tts_sync(text: str, voice: str, rate: str) -> bytes:
    try:
        import edge_tts  # 惰性导入
    except Exception as exc:  # pragma: no cover
        raise ProviderUnavailable("edge-tts is not installed; run `uv sync --extra local`", provider="local", detail=str(exc)) from exc

    async def _run() -> bytes:
        communicate = edge_tts.Communicate(text, voice, rate=rate)
        chunks = bytearray()
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio":
                chunks.extend(chunk.get("data", b""))
        return bytes(chunks)

    def _worker() -> bytes:
        return asyncio.run(_run())

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(_worker).result(timeout=20)
