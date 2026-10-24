"""本地发音评测（GOP：Goodness of Pronunciation）——CPU、离线、音素级。

路线（task-20 段 C）：
1. **音素 CTC 声学模型**：wav2vec2 音素模型（ONNX，onnxruntime CPU，**不需要 torch**）。
   模型来源：ModelScope `onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX`（espeak IPA 词表，392 符号）。
2. **强制对齐**：CTC Viterbi（等价 `torchaudio.functional.forced_align`，这里用 numpy 自己实现，
   避免为了对齐引入 2GB 的 torch）。
3. **打分**：每个目标音素在其对齐帧上的 `GOP = mean_t[log p(target) - log max_{q≠target} p(q)]`
   （同类变体与 blank 不参与竞争），再用 logistic 映射到 0–100：
   GOP=0 → 50，GOP=+2 → 88，GOP=-2 → 12。竞争音素排序给出 nbest（例如 /θ/→/s/）。
4. **音素空间**：全部走 `app/phonemes.py` 的 canonical-v1，与 Azure 路径同空间。
5. 输出字段形状尽量贴近 Azure 路径（words[].phonemes[].score / issues / scores），
   prosody 仍由 route 用与 provider 无关的 F0+DTW 补齐。

模型文件放 `.local-models/gop/`（`model_int8.onnx` + `vocab.json`），不进 git。
"""

from __future__ import annotations

import json
import logging
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..audio_io import AudioClip
from ..config import Settings, get_settings
from ..errors import ProviderError, ProviderUnavailable
from ..phonemes import CANONICAL_PHONEMES, canonicalize_phoneme
from ..text import tokens, word_phonemes
from .base import (
    Capabilities,
    PAResult,
    PAScores,
    PhonemeScore,
    WordScore,
    build_issue,
    pron_score_from_words,
    sort_and_cap_issues,
)

logger = logging.getLogger("voice.gop")

SAMPLE_RATE = 16000
MAX_AUDIO_SECONDS = 30.0
BLANK_ID = 0
FRAME_MS = 20.0  # wav2vec2 stride 320 / 16000Hz
SCORE_WEIGHT = 1.0  # logistic 斜率：score = 100 / (1 + exp(-GOP / SCORE_WEIGHT))

# 模型词表里没有的规范符号 -> 用它的近邻（数据驱动写在注释里，改动只需改这张表）
MODEL_SYMBOL_OVERRIDES: dict[str, str] = {
    "ɪə": "ɪɹ",  # 模型只有 GA 的 ɪɹ，没有 RP 的 ɪə
}

# 规范空间把长度符/变体合并了（iː→i、ɛ→e…），但模型词表是 espeak 的多语言词表，
# 同一个规范符号会对应多个模型符号（i / iː / ɨ…）。这里按**英语音系**挑选代表符号
# （espeak-ng en-us 的习惯写法），而不是"字符串完全相等"——否则 FLEECE 会错选 [i]、
# DRESS 会错选 [e]（真值是 [ɛ]），GOP 会系统性偏低。这是语言学先验，不是按评测集调参。
ENGLISH_MODEL_SYMBOL: dict[str, str] = {
    "i": "iː",
    "u": "uː",
    "ɔ": "ɔː",
    "ɜ": "ɜː",
    "e": "ɛ",
    "r": "ɹ",
    "əʊ": "oʊ",
}

_MODEL_LOCK = threading.Lock()
_MODEL_CACHE: dict[str, "GopModel"] = {}


def resolve_model_paths(settings: Settings | None = None) -> tuple[Path, Path]:
    """-> (onnx 路径, vocab.json 路径)。只认本地文件（HF 不可达，禁止联网下载）。"""
    settings = settings or get_settings()
    candidates: list[Path] = []
    if settings.gop_model_path:
        given = Path(settings.gop_model_path).expanduser()
        if given.is_file() and given.suffix == ".onnx":
            return given, given.parent / "vocab.json"
        candidates.append(given)
    candidates += [
        settings.local_models_dir / "gop",
        settings.model_cache_dir / "local" / "gop",
    ]

    for directory in candidates:
        if not directory.is_dir():
            continue
        for name in ("model_int8.onnx", "model_quantized.onnx", "model.onnx"):
            onnx = directory / name
            vocab = directory / "vocab.json"
            if onnx.is_file() and vocab.is_file():
                return onnx, vocab
        # ModelScope 快照：onnx 在子目录、vocab 在根目录
        for onnx in sorted(directory.glob("**/*.onnx")):
            for vocab in (directory / "vocab.json", onnx.parent / "vocab.json"):
                if vocab.is_file():
                    return onnx, vocab

    raise ProviderUnavailable(
        "找不到本地 GOP 音素模型（需要 model_int8.onnx + vocab.json）。请从 ModelScope 下载 "
        "onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX 放到 .local-models/gop/ 或用 GOP_MODEL_PATH 指定；"
        "本服务不会访问 HuggingFace。",
        provider="gop",
    )


@dataclass
class PhonemeVocab:
    id_to_symbol: dict[int, str]
    canon_by_id: dict[int, str | None]
    target_id_by_canon: dict[str, int]
    same_canon_ids: dict[str, set[int]] = field(default_factory=dict)

    def canon(self, index: int) -> str | None:
        return self.canon_by_id.get(index)


def build_phoneme_vocab(vocab: dict[str, int]) -> PhonemeVocab:
    """把模型词表映射到 canonical-v1 空间（数据驱动，多对一合并）。"""
    id_to_symbol: dict[int, str] = {}
    canon_by_id: dict[int, str | None] = {}
    for symbol, index in vocab.items():
        id_to_symbol[int(index)] = symbol
        if symbol.startswith("<") or symbol in ("<pad>", "<s>", "</s>", "<unk>"):
            canon_by_id[int(index)] = None
            continue
        canon = canonicalize_phoneme(symbol, record_unknown=False)
        canon_by_id[int(index)] = canon if canon in CANONICAL_PHONEMES else None

    same: dict[str, set[int]] = {}
    for index, canon in canon_by_id.items():
        if canon:
            same.setdefault(canon, set()).add(index)

    target: dict[str, int] = {}
    for canon, indices in same.items():
        preferred_symbol = ENGLISH_MODEL_SYMBOL.get(canon)
        preferred = [i for i in indices if id_to_symbol[i] == preferred_symbol] if preferred_symbol else []
        exact = [i for i in indices if id_to_symbol[i] == canon]
        if preferred:
            pick = preferred[0]
        elif exact:
            pick = exact[0]
        else:
            pick = min(sorted(indices), key=lambda i: (len(id_to_symbol[i]), i))
        target[canon] = pick
    for canon, model_symbol in MODEL_SYMBOL_OVERRIDES.items():
        index = vocab.get(model_symbol)
        if index is not None and canon not in target:
            target[canon] = int(index)
    return PhonemeVocab(
        id_to_symbol=id_to_symbol,
        canon_by_id=canon_by_id,
        target_id_by_canon=target,
        same_canon_ids=same,
    )


@dataclass
class GopModel:
    session: object
    vocab: PhonemeVocab
    path: str
    onnx_path: Path
    input_name: str


def load_model(settings: Settings | None = None) -> GopModel:
    settings = settings or get_settings()
    onnx_path, vocab_path = resolve_model_paths(settings)
    key = f"{onnx_path}|{vocab_path}"
    with _MODEL_LOCK:
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            return cached
        try:
            import onnxruntime as ort  # 惰性导入
        except Exception as exc:  # pragma: no cover - 依赖未安装
            raise ProviderUnavailable(
                "onnxruntime 未安装；pip install onnxruntime", provider="gop", detail=str(exc)
            ) from exc
        try:
            session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
            vocab = build_phoneme_vocab(json.loads(vocab_path.read_text(encoding="utf-8")))
        except Exception as exc:
            raise ProviderError(f"GOP 模型加载失败: {exc}", provider="gop") from exc
        model = GopModel(
            session=session,
            vocab=vocab,
            path=str(onnx_path),
            onnx_path=onnx_path,
            input_name=session.get_inputs()[0].name,
        )
        _MODEL_CACHE[key] = model
        logger.info("GOP model loaded: %s (vocab=%d, canonical targets=%d)",
                    onnx_path.name, len(vocab.id_to_symbol), len(vocab.target_id_by_canon))
        return model


# --------------------------------------------------------------------------------------
# 参考音素：优先用 espeak-ng（piper 自带数据），它的音素清单与 CTC 模型训练时一致
# --------------------------------------------------------------------------------------
_ESPEAK_LOCK = threading.Lock()
_ESPEAK: dict[str, object] = {}
_WORD_PHONEME_CACHE: dict[str, tuple[str, ...]] = {}

_STRESS_TOKENS = {"ˈ", "ˌ", "ː", "ˑ"}
_DIPHTHONG_PAIRS = {
    ("a", "ɪ"): "aɪ",
    ("e", "ɪ"): "eɪ",
    ("ɔ", "ɪ"): "ɔɪ",
    ("o", "ʊ"): "oʊ",
    ("ə", "ʊ"): "əʊ",
    ("a", "ʊ"): "aʊ",
    ("i", "ə"): "iə",
    ("ɛ", "ə"): "eə",
    ("ʊ", "ə"): "ʊə",
}


def _espeak_phonemizer():
    """惰性加载 piper 自带的 espeak-ng（不需要联网，也不需要 torch）。"""
    with _ESPEAK_LOCK:
        if "ph" in _ESPEAK:
            return _ESPEAK["ph"]
        try:
            from piper.phonemize_espeak import EspeakPhonemizer  # 惰性导入
        except Exception as exc:  # pragma: no cover - 依赖未安装
            raise ProviderUnavailable("piper 未安装（espeak-ng 音素化需要它）", provider="gop", detail=str(exc)) from exc
        _ESPEAK["ph"] = EspeakPhonemizer()
        return _ESPEAK["ph"]


def espeak_tokens_to_phonemes(tokens: list[str]) -> list[str]:
    """把 espeak 的原始 token 序列合并成 canonical-v1 音素序列。

    espeak 会把双元音拆成两个 token（a+ɪ、o+ʊ…）、把长度/重音当成独立 token，
    还会返回空格与标点。这里按 espeak 的惯例合并，保证和 CTC 模型的音素切分一致。
    """
    out: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in _STRESS_TOKENS or not token.strip():
            index += 1
            continue
        pair = _DIPHTHONG_PAIRS.get((token, tokens[index + 1])) if index + 1 < len(tokens) else None
        if pair:
            out.append(pair)
            index += 2
            # 双元音后面可能还跟长度符
            while index < len(tokens) and tokens[index] == "ː":
                index += 1
            continue
        out.append(token)
        index += 1
    canonical: list[str] = []
    for phone in out:
        canon = canonicalize_phoneme(phone, record_unknown=False)
        if canon in CANONICAL_PHONEMES:
            canonical.append(canon)
    return canonical


def espeak_word_phonemes(word: str) -> list[str] | None:
    """单个词的 espeak 音素（缓存）；失败返回 None（调用方回退到内置词典）。"""
    key = (word or "").lower().strip()
    if not key:
        return None
    cached = _WORD_PHONEME_CACHE.get(key)
    if cached is not None:
        return list(cached)
    try:
        phonemizer = _espeak_phonemizer()
        sentences = phonemizer.phonemize("en-us", key)
        phones = espeak_tokens_to_phonemes(sentences[0]) if sentences else []
    except Exception:  # espeak 不可用时安静回退
        return None
    if not phones:
        return None
    _WORD_PHONEME_CACHE[key] = tuple(phones)
    return phones


def reference_phonemes(word: str) -> list[str]:
    """参考音素：espeak 优先（与 CTC 模型同清单），否则回退到本项目 lexicon/字素近似。"""
    espeak = espeak_word_phonemes(word)
    if espeak:
        return espeak
    return [canonicalize_phoneme(p, record_unknown=False) for p in word_phonemes(word)]


# --------------------------------------------------------------------------------------
# 声学前向 / 对齐 / 打分（纯 numpy，可单测）
# --------------------------------------------------------------------------------------
def audio_log_probs(model: GopModel, samples: np.ndarray) -> np.ndarray:
    """16k mono float32 -> [T, V] log-softmax（等价 wav2vec2 的 do_normalize 前处理）。"""
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    if audio.size < 400:
        audio = np.pad(audio, (0, 400 - audio.size))
    mean = float(audio.mean())
    var = float(audio.var())
    normalized = (audio - mean) / math.sqrt(var + 1e-7)
    logits = model.session.run(None, {model.input_name: normalized[None, :]})[0][0]
    return log_softmax(logits)


def log_softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=-1, keepdims=True)
    return shifted - np.log(np.exp(shifted).sum(axis=-1, keepdims=True))


def ctc_forced_align(log_probs: np.ndarray, target_ids: list[int], blank_id: int = BLANK_ID) -> list[tuple[int, int]]:
    """CTC Viterbi 强制对齐：返回每个目标音素的 (start_frame, end_frame)（含两端）。

    等价 torchaudio.functional.forced_align 的 best-path；实现为扩展状态上的 DP：
    状态序列 blank, t1, blank, t2, ..., blank，允许停留/前进一格/在"跳过 blank"规则下前进两格。
    """
    if not target_ids:
        return []
    frames = int(log_probs.shape[0])
    length = len(target_ids)
    if frames < length:
        raise ProviderError(f"音频帧数({frames})少于音素数({length})，无法对齐", provider="gop")

    ext: list[int] = [blank_id]
    for tid in target_ids:
        ext.extend([int(tid), blank_id])
    states = len(ext)
    NEG = -1e30

    dp = np.full((frames, states), NEG, dtype=np.float64)
    back = np.full((frames, states), -1, dtype=np.int16)
    dp[0, 0] = log_probs[0, ext[0]]
    if states > 1:
        dp[0, 1] = log_probs[0, ext[1]]

    for t in range(1, frames):
        for s in range(states):
            best = dp[t - 1, s]
            prev = s
            if s >= 1 and dp[t - 1, s - 1] > best:
                best = dp[t - 1, s - 1]
                prev = s - 1
            if s >= 2 and ext[s] != blank_id and ext[s] != ext[s - 2] and dp[t - 1, s - 2] > best:
                best = dp[t - 1, s - 2]
                prev = s - 2
            if best <= NEG / 2:
                continue
            dp[t, s] = best + log_probs[t, ext[s]]
            back[t, s] = prev

    # 收尾：最后一个状态可以是末尾 blank 或最后一个音素
    end_state = states - 1
    if states >= 2 and dp[frames - 1, states - 2] > dp[frames - 1, end_state]:
        end_state = states - 2
    if dp[frames - 1, end_state] <= NEG / 2:
        raise ProviderError("CTC 对齐失败（无法到达终止状态）", provider="gop")

    path = np.empty(frames, dtype=np.int32)
    state = end_state
    for t in range(frames - 1, -1, -1):
        path[t] = state
        state = int(back[t, state]) if t > 0 else -1

    spans: list[tuple[int, int]] = []
    for index in range(length):
        state = 2 * index + 1
        hit = np.where(path == state)[0]
        if hit.size == 0:
            # 极短音素可能一帧都没占到：退化到前后最近位置
            spans.append((int(hit.min()) if hit.size else 0, int(hit.max()) if hit.size else 0))
            continue
        spans.append((int(hit[0]), int(hit[-1])))
    return spans


def score_phonemes(
    log_probs: np.ndarray,
    spans: list[tuple[int, int]],
    target_ids: list[int],
    vocab: PhonemeVocab,
    blank_id: int = BLANK_ID,
) -> list[dict]:
    """GOP：目标音素后验 vs 最佳竞争音素（排除同规范变体与 blank），映射到 0–100。"""
    results: list[dict] = []
    for (start, end), tid in zip(spans, target_ids):
        start = max(0, min(int(start), log_probs.shape[0] - 1))
        end = max(start, min(int(end), log_probs.shape[0] - 1))
        frames = log_probs[start : end + 1]
        target_canon = vocab.canon(tid)
        same_ids = sorted(vocab.same_canon_ids.get(target_canon or "", set()))
        masked = frames.copy()
        # 竞争音素：只允许"真实的音素符号"参与。
        # blank / <s> / </s> / <unk> 不是发音，绝不能让它们当"最佳竞争音素"把 GOP 打成负分
        # （这是 task-20 调参时发现的真实 bug：多语言词表里 <s>/<unk> 在静音帧上概率很高）。
        non_phoneme_ids = [index for index, canon in vocab.canon_by_id.items() if canon is None]
        masked[:, sorted(set(same_ids) | set(non_phoneme_ids) | {blank_id})] = -np.inf
        best_other = masked.max(axis=1)
        gop = float(np.mean(frames[:, tid] - best_other))
        score = 100.0 / (1.0 + math.exp(-gop / SCORE_WEIGHT))

        # nbest：竞争音素按平均对数概率排序，取不同规范符号的前两个
        mean_comp = masked.mean(axis=0)
        order = np.argsort(mean_comp)[::-1][:12]
        nbest: list[dict] = []
        for index in order:
            symbol = vocab.canon(int(index))
            if not symbol or symbol == target_canon:
                continue
            if any(item["phoneme"] == symbol for item in nbest):
                continue
            rel = float(mean_comp[index] - frames[:, tid].mean())
            nbest.append({"phoneme": symbol, "score": round(100.0 / (1.0 + math.exp(-rel / SCORE_WEIGHT)), 1)})
            if len(nbest) == 2:
                break

        results.append(
            {
                "phoneme": target_canon,
                "score": round(score, 1),
                "gop": round(gop, 3),
                "start_frame": start,
                "end_frame": end,
                "start_ms": int(round(start * FRAME_MS)),
                "end_ms": int(round((end + 1) * FRAME_MS)),
                "nbest": nbest,
            }
        )
    return results


def greedy_phones(log_probs: np.ndarray, vocab: PhonemeVocab, blank_id: int = BLANK_ID) -> list[str]:
    """贪心解码（只看是否/怎么说了）：用于 completeness 估计。"""
    best = log_probs.argmax(axis=1)
    out: list[str] = []
    prev = -1
    for index in best:
        index = int(index)
        if index != prev and index != blank_id:
            symbol = vocab.canon(index)
            if symbol:
                out.append(symbol)
        prev = index
    return out


# --------------------------------------------------------------------------------------
# Provider
# --------------------------------------------------------------------------------------
class GOPPA:
    """本地音素级发音评测 provider（provider 名 "gop"）。"""

    name = "gop"
    capabilities = Capabilities(phoneme_level=True, prosody=False, nbest_phonemes=True, ssml=False)

    def score_word_targets(
        self,
        clip: AudioClip,
        word_targets: list[tuple[str, list[str]]],
    ) -> tuple[list[tuple[str, list[dict]]], np.ndarray, int, list[str]]:
        """给"按词的参考音素序列"打分（音素级）。

        返回 ([(word, [音素分…])], log_probs, 跳过的音素数, 贪心解码音素序列)。
        参考音素可以用本项目 lexicon（`assess` 内部），也可以用别处的参考发音（对照实验用）——
        两者走完全相同的声学模型与对齐逻辑，便于做 apples-to-apples 比较。
        """
        model = load_model(get_settings())
        target_ids: list[int] = []
        word_entries: list[tuple[str, list[dict]]] = []
        skipped = 0
        for word, phones in word_targets:
            entries: list[dict] = []
            for phone in phones:
                canon = canonicalize_phoneme(phone, record_unknown=False)
                model_id = model.vocab.target_id_by_canon.get(canon)
                if model_id is None:
                    skipped += 1
                    continue
                entries.append({"phoneme": canon, "model_id": int(model_id)})
                target_ids.append(int(model_id))
            word_entries.append((word, entries))
        if not target_ids:
            return [], np.zeros((0, 1)), skipped, []

        max_samples = int(MAX_AUDIO_SECONDS * SAMPLE_RATE)
        log_probs = audio_log_probs(model, clip.samples[:max_samples])
        spans = ctc_forced_align(log_probs, target_ids)
        scored = score_phonemes(log_probs, spans, target_ids, model.vocab)

        cursor = 0
        results: list[tuple[str, list[dict]]] = []
        for word, entries in word_entries:
            if not entries:
                results.append((word, []))
                continue
            results.append((word, scored[cursor : cursor + len(entries)]))
            cursor += len(entries)
        recognized = greedy_phones(log_probs, model.vocab)
        return results, log_probs, skipped, recognized

    def assess(
        self,
        clip: AudioClip,
        reference_text: str,
        mode: str = "scripted",
        granularity: str = "phoneme",
        with_intonation: bool = True,
        learner_age_band: str | None = None,
    ) -> PAResult:
        if not (reference_text or "").strip():
            raise ProviderError("GOP 需要参考文本（scripted 模式）；自由说模式请用 local/azure provider", provider="gop")
        settings = get_settings()
        model = load_model(settings)

        # 参考音素序列（按词分组，用本项目 lexicon/字素近似）
        word_targets: list[tuple[str, list[str]]] = [
            (word, reference_phonemes(word)) for word in tokens(reference_text)
        ]
        scored_words, log_probs, skipped, recognized = self.score_word_targets(clip, word_targets)
        if not scored_words:
            raise ProviderError("参考文本的音素都无法映射到 GOP 模型词表", provider="gop")

        words: list[WordScore] = []
        issues = []
        all_phoneme_scores: list[float] = []
        for word, entries in scored_words:
            if not entries:
                continue
            for entry in entries:
                all_phoneme_scores.append(float(entry["score"]))
            phoneme_scores = [
                PhonemeScore(
                    phoneme=entry["phoneme"],
                    score=float(entry["score"]),
                    start_ms=entry["start_ms"],
                    end_ms=max(entry["start_ms"] + 20, entry["end_ms"]),
                    nbest=entry["nbest"],
                )
                for entry in entries
            ]
            word_score = float(round(np.mean([p.score for p in phoneme_scores]), 1))
            error_type = "Mispronunciation" if word_score < 70.0 else "None"
            word_start = min(p.start_ms for p in phoneme_scores)
            word_end = max(p.end_ms for p in phoneme_scores)
            words.append(
                WordScore(
                    word=word,
                    start_ms=word_start,
                    end_ms=word_end,
                    score=word_score,
                    error_type=error_type,
                    phonemes=phoneme_scores,
                )
            )
            if error_type != "None":
                worst = min(phoneme_scores, key=lambda p: p.score)
                actual = worst.nbest[0]["phoneme"] if worst.nbest else None
                issues.append(
                    build_issue(
                        word=word,
                        phoneme=worst.phoneme,
                        expected=worst.phoneme,
                        actual=actual,
                        score=worst.score,
                        start_ms=worst.start_ms,
                        end_ms=worst.end_ms,
                        error_type="Mispronunciation",
                    )
                )

        accuracy = float(round(np.mean(all_phoneme_scores), 1)) if all_phoneme_scores else None
        completeness = _completeness(reference_text, recognized)
        fluency = _fluency(clip, learner_age_band)
        word_values = [w.score for w in words]

        return PAResult(
            provider=self.name,
            granularity="phoneme",
            mode=mode or "scripted",
            reference_text=reference_text,
            recognized_text="",
            duration_ms=clip.duration_ms,
            scores=PAScores(
                pron=pron_score_from_words(word_values) if word_values else accuracy,
                accuracy=accuracy,
                fluency=fluency,
                completeness=completeness,
                prosody=None,  # route 用 F0+DTW 补齐
            ),
            words=words,
            issues=sort_and_cap_issues(issues, limit=5),
            warnings=[],
            provider_meta={
                "gop_model": Path(model.path).name,
                "alignment": "ctc_viterbi",
                "frame_ms": FRAME_MS,
                "phoneme_level": True,
                "skipped_reference_phonemes": skipped,
                "recognized_phonemes": " ".join(recognized[:60]),
            },
        )


def _completeness(reference_text: str, recognized_phones: list[str]) -> float | None:
    """"说了多少"的粗估：参考音素序列 vs 贪心解码音素序列的 LCS 比例（0–100）。"""
    ref: list[str] = []
    for word in tokens(reference_text):
        ref.extend(reference_phonemes(word))
    if not ref:
        return None
    if not recognized_phones:
        return 0.0
    # LCS 长度（音素级）
    prev = [0] * (len(recognized_phones) + 1)
    for item in ref:
        current = [0]
        for j, other in enumerate(recognized_phones, start=1):
            current.append(prev[j - 1] + 1 if item == other else max(prev[j], current[j - 1]))
        prev = current
    return round(100.0 * prev[-1] / len(ref), 1)


def _fluency(clip: AudioClip, learner_age_band: str | None) -> float:
    """时长/停顿时长粗估（与 provider 无关，和 mock/local 的口径一致）。"""
    envelope = clip.rms_frames(20)
    if envelope.size == 0:
        return 40.0
    threshold = max(1e-3, float(envelope.mean()) * 0.25)
    silence = envelope < threshold
    pauses = 0
    run = 0
    for flag in silence:
        if flag:
            run += 1
        else:
            if run >= 15:  # 300ms
                pauses += 1
            run = 0
    if run >= 15:
        pauses += 1
    seconds = max(0.3, clip.duration_s)
    rate_score = min(100.0, max(40.0, 100.0 - 20.0 * abs(pauses - 1) / max(1, seconds / 3)))
    silence_ratio = float(silence.mean())
    return float(round(max(35.0, rate_score - 25.0 * max(0.0, silence_ratio - 0.25)), 1))
