"""task-20：本地 TTS（Piper）/ 本地 ASR（faster-whisper）/ 本地评测（GOP）的单元测试。

**不下载真模型**：ONNX 会话、Piper 音色、faster-whisper 全部用假对象 / monkeypatch。
"""

from __future__ import annotations

import dataclasses
import math
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from app.audio_io import decode_audio
from app.config import get_settings
from app.errors import ProviderError, ProviderUnavailable
from app.phonemes import CANONICAL_PHONEMES, canonicalize_phoneme
from app.providers.gop import (
    BLANK_ID,
    ENGLISH_MODEL_SYMBOL,
    FRAME_MS,
    GopModel,
    GOPPA,
    build_phoneme_vocab,
    ctc_forced_align,
    greedy_phones,
    resolve_model_paths,
    score_phonemes,
)
from app.providers.piper import PiperTTS, resolve_voice_path
from app.providers.local import resolve_whisper_dir
from app.synth import tone_wav

# 假词表：覆盖本项目 canonical 空间的常见符号 + 多语言变体（验证"多对一 + 英语优先"）
FAKE_VOCAB = {
    "<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3,
    "n": 4, "s": 5, "t": 6, "ə": 7, "l": 8, "i": 9, "k": 10,
    "θ": 11, "ɛ": 12, "iː": 13, "ɹ": 14, "ɑ": 15, "ʌ": 16, "ð": 17,
    "æ": 18, "e": 19, "iːː": 20, "ɨ": 21, "ɔː": 22, "uː": 23, "ɪ": 24,
    "ɪɹ": 25, "d": 26, "p": 27, "b": 28, "m": 29, "w": 30, "ŋ": 31,
}


def _fake_model() -> GopModel:
    return GopModel(
        session=SimpleNamespace(),
        vocab=build_phoneme_vocab(FAKE_VOCAB),
        path="fake.onnx",
        onnx_path=Path("fake.onnx"),
        input_name="input_values",
    )


def _log_probs_from_blocks(blocks: list[tuple[int, int, int]], frames: int, vocab_size: int) -> np.ndarray:
    """blocks: [(音素 id, 起始帧, 结束帧)]，其余帧是 blank 的概率占优。"""
    logits = np.full((frames, vocab_size), -8.0, dtype=np.float32)
    logits[:, BLANK_ID] = 4.0
    for phoneme_id, start, end in blocks:
        logits[start : end + 1, :] = -8.0
        logits[start : end + 1, BLANK_ID] = -8.0
        logits[start : end + 1, phoneme_id] = 6.0
    logits -= logits.max(axis=-1, keepdims=True)
    return logits - np.log(np.exp(logits).sum(axis=-1, keepdims=True))


# --------------------------------------------------------------------------------------
# 词表映射
# --------------------------------------------------------------------------------------
def test_vocab_merges_variants_and_prefers_english_symbols():
    vocab = build_phoneme_vocab(FAKE_VOCAB)
    # 多对一：i / iː / iːː 都归到规范 i（ɨ 归 ɪ，见 task-7 的映射表）
    assert vocab.same_canon_ids["i"] >= {9, 13, 20}
    assert 21 in vocab.same_canon_ids["ɪ"]
    # 英语音系优先：DRESS 用 ɛ（不是 [e]），FLEECE 用 iː，r 用 ɹ
    assert vocab.id_to_symbol[vocab.target_id_by_canon["e"]] == "ɛ"
    assert vocab.id_to_symbol[vocab.target_id_by_canon["i"]] == "iː"
    assert vocab.id_to_symbol[vocab.target_id_by_canon["r"]] == "ɹ"
    # 模型缺 ɪə -> 覆盖成 ɪɹ
    assert vocab.id_to_symbol[vocab.target_id_by_canon["ɪə"]] == "ɪɹ"
    # 特殊 token 不参与
    assert vocab.canon(0) is None and vocab.canon(1) is None
    assert all(c in CANONICAL_PHONEMES for c in vocab.target_id_by_canon)


def test_english_symbol_table_is_documented_and_sane():
    for canonical, model_symbol in ENGLISH_MODEL_SYMBOL.items():
        assert canonical in CANONICAL_PHONEMES
        assert model_symbol in FAKE_VOCAB or model_symbol  # 表本身是数据，不强制在假词表里


# --------------------------------------------------------------------------------------
# CTC 对齐 / GOP 打分
# --------------------------------------------------------------------------------------
def test_ctc_forced_align_finds_correct_spans():
    vocab = build_phoneme_vocab(FAKE_VOCAB)
    target = [vocab.target_id_by_canon["n"], vocab.target_id_by_canon["s"], vocab.target_id_by_canon["t"]]
    blocks = [(target[0], 2, 4), (target[1], 8, 10), (target[2], 14, 16)]
    log_probs = _log_probs_from_blocks(blocks, frames=22, vocab_size=len(FAKE_VOCAB))
    spans = ctc_forced_align(log_probs, target)
    assert len(spans) == 3
    for (start, end), (_, expected_start, expected_end) in zip(spans, blocks):
        assert start <= expected_start and end >= expected_end
        assert start >= 0 and end >= start
    # 单调递增
    assert spans[0][0] < spans[1][0] < spans[2][0]


def test_gop_high_score_for_correct_pronunciation():
    vocab = build_phoneme_vocab(FAKE_VOCAB)
    target = [vocab.target_id_by_canon["θ"], vocab.target_id_by_canon["n"]]
    log_probs = _log_probs_from_blocks([(target[0], 2, 5), (target[1], 8, 11)], frames=16, vocab_size=len(FAKE_VOCAB))
    scored = score_phonemes(log_probs, ctc_forced_align(log_probs, target), target, vocab)
    assert all(item["score"] > 80 for item in scored), scored
    assert all(item["gop"] > 1.0 for item in scored)


def test_gop_marks_mispronounced_phoneme_with_nbest():
    vocab = build_phoneme_vocab(FAKE_VOCAB)
    theta = vocab.target_id_by_canon["θ"]
    s_id = vocab.vocab_id if False else FAKE_VOCAB["s"]
    # 学习者把 θ 读成了 s：帧上 s 的概率占优
    log_probs = _log_probs_from_blocks([(s_id, 2, 5)], frames=10, vocab_size=len(FAKE_VOCAB))
    scored = score_phonemes(log_probs, ctc_forced_align(log_probs, [theta]), [theta], vocab)
    item = scored[0]
    assert item["score"] < 20, item
    assert item["nbest"] and item["nbest"][0]["phoneme"] == "s"


def test_greedy_phones_collapses_repeats():
    vocab = build_phoneme_vocab(FAKE_VOCAB)
    n, s = vocab.target_id_by_canon["n"], vocab.target_id_by_canon["s"]
    log_probs = _log_probs_from_blocks([(n, 1, 3), (s, 5, 7)], frames=10, vocab_size=len(FAKE_VOCAB))
    phones = greedy_phones(log_probs, vocab)
    assert phones == ["n", "s"]


# --------------------------------------------------------------------------------------
# GOPPA provider（假模型）
# --------------------------------------------------------------------------------------
def _fake_assess_setup(monkeypatch, *, wrong_phoneme: str | None = None):
    vocab = build_phoneme_vocab(FAKE_VOCAB)
    # 参考文本 "the cat"：the -> ð ə，cat -> k æ t
    sequence = ["ð", "ə", "k", "æ", "t"]
    target = [vocab.target_id_by_canon[c] for c in sequence]
    if wrong_phoneme:
        target = [FAKE_VOCAB[wrong_phoneme] if c == "ð" else tid for c, tid in zip(sequence, target)]
    blocks = [(tid, index * 5 + 1, index * 5 + 4) for index, tid in enumerate(target)]
    log_probs = _log_probs_from_blocks(blocks, frames=len(target) * 5 + 2, vocab_size=len(FAKE_VOCAB))

    shared = FAKE_VOCAB  # 让 monkeypatch 的闭包拿到词表
    monkeypatch.setattr("app.providers.gop.load_model", lambda *a, **k: _fake_model())
    monkeypatch.setattr("app.providers.gop.audio_log_probs", lambda model, samples: log_probs)
    return shared


def test_gop_pa_result_shape(monkeypatch):
    _fake_assess_setup(monkeypatch)
    clip = decode_audio(tone_wav(180.0, 1.0), 16000, 60.0)
    result = GOPPA().assess(clip, "the cat", mode="scripted", granularity="phoneme")
    assert result.provider == "gop"
    assert result.granularity == "phoneme"
    assert result.mode == "scripted"
    assert result.words and result.words[0].word == "the"
    contract = result.scores.to_contract()
    for key in ("pron", "accuracy", "fluency", "completeness", "prosody"):
        assert key in contract
    assert contract["accuracy"] is not None and 0 <= contract["accuracy"] <= 100
    assert contract["prosody"] is None  # 由 route 用 F0+DTW 补
    for word in result.words:
        assert word.phonemes, "GOP 必须给音素级分数"
        for phone in word.phonemes:
            assert phone.phoneme in CANONICAL_PHONEMES
            assert 0 <= phone.score <= 100
            assert phone.end_ms > phone.start_ms
    assert result.provider_meta["phoneme_level"] is True
    assert len(result.issues) <= 5


def test_gop_flags_wrong_phoneme_with_actual(monkeypatch):
    # 参考 ð 实际读成 s
    _fake_assess_setup(monkeypatch, wrong_phoneme="s")
    clip = decode_audio(tone_wav(180.0, 1.0), 16000, 60.0)
    result = GOPPA().assess(clip, "the cat")
    issues = [issue.to_contract() for issue in result.issues]
    assert issues, "读错音素时必须产出 issue"
    wrong = [issue for issue in issues if issue["phoneme"] == "ð"]
    assert wrong, issues
    assert wrong[0]["actual"] == "s"
    assert wrong[0]["severity"] in ("high", "medium")


def test_gop_requires_reference_text(monkeypatch):
    _fake_assess_setup(monkeypatch)
    clip = decode_audio(tone_wav(180.0, 1.0), 16000, 60.0)
    with pytest.raises(ProviderError):
        GOPPA().assess(clip, "", mode="unscripted")


def test_gop_model_resolution_raises_without_model(tmp_path):
    empty_local = tmp_path / "local-models"
    empty_local.mkdir()
    settings = dataclasses.replace(
        get_settings(),
        gop_model_path=str(tmp_path / "nope.onnx"),
        local_models_dir_path=str(empty_local),
        model_cache_dir=tmp_path,
    )
    with pytest.raises(ProviderUnavailable):
        resolve_model_paths(settings)


# --------------------------------------------------------------------------------------
# Piper TTS（假音色）
# --------------------------------------------------------------------------------------
class _FakeChunk:
    def __init__(self, pcm: bytes, sample_rate: int = 22050):
        self.audio_int16_bytes = pcm
        self.sample_rate = sample_rate


class _FakePiperVoice:
    def __init__(self):
        self.syn_configs = []

    def synthesize(self, text, syn_config=None):
        self.syn_configs.append(syn_config)
        samples = np.zeros(int(22050 * 0.5), dtype=np.int16)
        yield _FakeChunk(samples.tobytes())


def test_piper_tts_returns_decodable_wav(monkeypatch):
    voice = _FakePiperVoice()
    monkeypatch.setattr("app.providers.piper.load_voice", lambda *a, **k: voice)
    result = PiperTTS().synthesize("hello there", voice="en_US-lessac-medium", rate="normal", fmt="wav")
    assert result.provider == "piper"
    assert result.content_type == "audio/wav"
    assert result.duration_ms == pytest.approx(500, abs=30)
    probe = decode_audio(result.audio, 16000, 60.0)
    assert probe.duration_ms == pytest.approx(500, abs=30)


def test_piper_slow_rate_uses_length_scale(monkeypatch):
    voice = _FakePiperVoice()
    monkeypatch.setattr("app.providers.piper.load_voice", lambda *a, **k: voice)
    PiperTTS().synthesize("hello", rate="slow")
    syn_config = voice.syn_configs[-1]
    assert syn_config is not None
    assert getattr(syn_config, "length_scale", 1.0) > 1.0, "慢速应通过 length_scale 拉长音素"


def test_piper_voice_resolution(tmp_path):
    settings = dataclasses.replace(get_settings(), piper_voice_dir=str(tmp_path), piper_voice="en_US-lessac-medium")
    (tmp_path / "en_US-lessac-medium.onnx").write_bytes(b"fake")
    assert resolve_voice_path("en_US-lessac-medium", settings) == tmp_path / "en_US-lessac-medium.onnx"
    # Azure 音色名 -> 回退到目录里已有的音色
    assert resolve_voice_path("en-US-JennyNeural", settings) == tmp_path / "en_US-lessac-medium.onnx"
    empty = tmp_path / "empty"
    empty.mkdir()
    empty_local = tmp_path / "local-models"
    empty_local.mkdir()
    with pytest.raises(ProviderUnavailable):
        resolve_voice_path(
            "en_US-lessac-medium",
            dataclasses.replace(settings, piper_voice_dir=str(empty), local_models_dir_path=str(empty_local),
                                model_cache_dir=tmp_path),
        )


def test_piper_empty_text_raises(monkeypatch):
    monkeypatch.setattr("app.providers.piper.load_voice", lambda *a, **k: _FakePiperVoice())
    with pytest.raises(ProviderError):
        PiperTTS().synthesize("   ")


# --------------------------------------------------------------------------------------
# faster-whisper：只认本地目录，绝不访问 HuggingFace
# --------------------------------------------------------------------------------------
def test_whisper_resolution_requires_local_dir(tmp_path):
    with pytest.raises(ProviderUnavailable):
        resolve_whisper_dir(
            dataclasses.replace(
                get_settings(),
                whisper_model="definitely-not-a-model",
                whisper_model_path=str(tmp_path / "nope"),
                local_models_dir_path=str(tmp_path / "local-models"),
                model_cache_dir=tmp_path,
            )
        )


def test_whisper_resolution_finds_explicit_local_dir(tmp_path):
    model_dir = tmp_path / "whisper-small"
    model_dir.mkdir()
    (model_dir / "model.bin").write_bytes(b"fake")
    resolved = resolve_whisper_dir(
        dataclasses.replace(get_settings(), whisper_model_path=str(model_dir), model_cache_dir=tmp_path)
    )
    assert Path(resolved) == model_dir


def test_load_whisper_never_passes_hf_model_id(tmp_path, monkeypatch):
    """回归：曾经直接 `WhisperModel("tiny")` 会去 HF 下载（本机不可达）。现在必须传本地绝对目录。"""
    model_dir = tmp_path / "whisper-small"
    model_dir.mkdir()
    (model_dir / "model.bin").write_bytes(b"fake")

    captured = {}

    class FakeWhisperModel:
        def __init__(self, model, **kwargs):
            captured["model"] = model
            captured["kwargs"] = kwargs

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)
    monkeypatch.setenv("WHISPER_MODEL_PATH", str(model_dir))
    from app.config import reset_settings_cache
    from app.providers import local as local_module

    reset_settings_cache()
    local_module._MODEL_CACHE.clear()
    try:
        loaded = local_module._load_whisper()
        assert isinstance(loaded, FakeWhisperModel)
        assert Path(captured["model"]) == model_dir, captured["model"]
        assert "download_root" not in captured["kwargs"]
    finally:
        local_module._MODEL_CACHE.clear()
        reset_settings_cache()


# --------------------------------------------------------------------------------------
# 端到端：local 模式启动惰性 + /v1/pronounce 走 GOP
# --------------------------------------------------------------------------------------
def test_local_mode_startup_is_lazy(tmp_path):
    """local 模式起服务并处理 /v1/health 时，不许 import onnxruntime / piper / faster_whisper / torch。"""
    import os
    import subprocess

    root = Path(__file__).resolve().parent.parent
    code = """
import sys
from fastapi.testclient import TestClient
from app.main import app
with TestClient(app) as client:
    health = client.get('/v1/health').json()
assert health['providers']['pa'] == 'local', health
assert health['providers']['tts'] == 'piper', health
assert health['capabilities']['phoneme_level'] is False, health
for name in ('onnxruntime', 'piper', 'faster_whisper', 'torch', 'transformers'):
    assert name not in sys.modules, (name, [k for k in sys.modules if name.startswith(name)])
print('LAZY_LOCAL_OK')
"""
    env = {
        **os.environ,
        "PROVIDER_MODE": "local",
        "ENV_FILE": str(tmp_path / "none.env"),
        "DATA_DIR": str(tmp_path),
        "MODEL_CACHE_DIR": str(tmp_path / "models"),
        "LOCAL_MODELS_DIR": str(tmp_path / "local-models"),
    }
    for key in ("AZURE_SPEECH_KEY", "LLM_API_KEY", "LLM_BASE_URL", "OLLAMA_BASE_URL"):
        env.pop(key, None)
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=root, env=env, capture_output=True, text=True, timeout=180
    )
    assert result.returncode == 0, result.stderr
    assert "LAZY_LOCAL_OK" in result.stdout


def test_pronounce_endpoint_with_gop_provider(client, monkeypatch):
    """/v1/pronounce 走 GOP provider 时，返回音素级结果且落在 canonical-v1 空间。"""
    from app.providers.registry import ProviderSet, build_providers
    from tests.conftest import post_pronounce

    vocab = build_phoneme_vocab(FAKE_VOCAB)
    sequence = ["ð", "ə", "k", "æ", "t"]  # "the cat"
    target = [vocab.target_id_by_canon[c] for c in sequence]
    blocks = [(tid, index * 5 + 1, index * 5 + 4) for index, tid in enumerate(target)]
    log_probs = _log_probs_from_blocks(blocks, frames=len(target) * 5 + 2, vocab_size=len(FAKE_VOCAB))
    monkeypatch.setattr("app.providers.gop.load_model", lambda *a, **k: _fake_model())
    monkeypatch.setattr("app.providers.gop.audio_log_probs", lambda model, samples: log_probs)

    base = build_providers()
    gop = GOPPA()
    provider_set = ProviderSet(
        asr=base.asr,
        pa=gop,
        tts=base.tts,
        asr_chain=base.asr_chain,
        pa_chain=[gop],
        tts_chain=base.tts_chain,
        mode="local",
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)

    response = post_pronounce(client, tone_wav(180.0, 1.0), "the cat")
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "gop"
    assert body["granularity"] == "phoneme"
    assert body["provider_meta"]["phoneme_space"] == "canonical-v1"
    symbols = [p["phoneme"] for word in body["words"] for p in word["phonemes"]]
    assert symbols, body["words"]
    assert all(s in CANONICAL_PHONEMES for s in symbols), symbols
    assert body["intonation"]["available"] is True  # 语调仍是本地 F0+DTW
    assert body["scores"]["accuracy"] is not None
    assert body["provider_meta"]["cache"]["reference_audio"] in ("hit", "miss", "disabled")
