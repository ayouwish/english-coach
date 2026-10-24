"""task-7：音素符号归一化接缝（canonical-v1）。

覆盖 lead 指定的 5 条：
1. 变体覆盖表逐项断言；2. 幂等 f(f(x))==f(x)；3. nbest 排序/分数不变；
4. 未在表中的符号原样返回（不丢信息）；5. issues 的 expected/actual 同步归一化。
"""

from __future__ import annotations

import pytest

from app.phonemes import (
    CANONICAL_MAP,
    CANONICAL_PHONEMES,
    PHONEME_SPACE_ID,
    canonicalize_all,
    canonicalize_pa_result,
    canonicalize_phoneme,
    looks_like_phoneme,
    reset_unknown_phonemes,
    seen_unknown_phonemes,
    variants_of,
)
from app.hints import derive_hint_key
from app.providers.base import Capabilities, PAIssue, PAResult, PAScores, PhonemeScore, WordScore
from app.providers.registry import ProviderSet, build_providers
from tests.conftest import post_pronounce

TEXT = "I think the weather is really nice today."


@pytest.fixture(autouse=True)
def _clean_unknown():
    reset_unknown_phonemes()
    yield
    reset_unknown_phonemes()


# --------------------------------------------------------------------------------------
# 1. 变体覆盖表逐项断言（task 明确列出的每一项）
# --------------------------------------------------------------------------------------
REQUIRED_VARIANTS = [
    # 辅音变体
    ("ɹ", "r"),
    ("ɻ", "r"),
    ("ʤ", "dʒ"),
    ("ʧ", "tʃ"),
    ("t͡ʃ", "tʃ"),
    ("d͡ʒ", "dʒ"),
    ("g", "ɡ"),
    ("ɡ", "ɡ"),  # 规范符号本身原样返回
    # 元音变体
    ("ɛ", "e"),
    ("ɝ", "ɜ"),
    ("ɚ", "ə"),
    ("ɐ", "ʌ"),
    ("ᵻ", "ɪ"),
    # 长度符
    ("iː", "i"),
    ("i", "i"),
    ("uː", "u"),
    ("u", "u"),
    ("ɔː", "ɔ"),
    ("ɔ", "ɔ"),
    ("ɜː", "ɜ"),
    ("ɜ", "ɜ"),
    ("ɑː", "ɑ"),
    ("ɑ", "ɑ"),
    ("ɒ", "ɑ"),  # cot-caught 合并
    # 双元音
    ("oʊ", "əʊ"),
    ("eɪ", "eɪ"),
    ("aɪ", "aɪ"),
    ("aʊ", "aʊ"),
    ("ɔɪ", "ɔɪ"),
]


@pytest.mark.parametrize("variant,canonical", REQUIRED_VARIANTS)
def test_required_variant_coverage(variant, canonical):
    assert canonicalize_phoneme(variant) == canonical
    assert canonical in CANONICAL_PHONEMES


@pytest.mark.parametrize("symbol", ["ɒ", "ɑː", "ɔː", "ɜː", "iː", "uː", "əʊ", "ʊə", "eə", "ɪə"])
def test_corpus_rp_symbols_never_fall_through_as_unknown(symbol):
    """语料用的 RP 符号必须都被覆盖（映射或本身就是规范符号），否则会出现两张卡。"""
    out = canonicalize_phoneme(symbol)
    assert out in CANONICAL_PHONEMES
    assert seen_unknown_phonemes() == [], f"{symbol} 未被表覆盖"


@pytest.mark.parametrize(
    "raw,canonical",
    [("n̩", "n"), ("l̩", "l"), ("m̩", "m"), ("æː", "æ"), ("t͜ʃ", "tʃ"), ("d͜ʒ", "dʒ"), ("ɑɪ", "aɪ"), ("ou", "əʊ")],
)
def test_diacritic_and_tiebar_variants(raw, canonical):
    assert canonicalize_phoneme(raw) == canonical


def test_table_invariants():
    assert CANONICAL_MAP, "映射表不能为空"
    for variant, canonical in CANONICAL_MAP.items():
        assert canonical in CANONICAL_PHONEMES, f"{variant} -> {canonical} 不在规范空间里"
        assert CANONICAL_MAP.get(canonical, canonical) == canonical, f"{canonical} 又被二次映射，会破坏幂等"
    assert len(CANONICAL_PHONEMES) >= 30
    # 反查可用（文档/排查）
    assert "ɹ" in variants_of("r") and "ɛ" in variants_of("e")
    assert {"ɒ", "ɒː"}.issubset(set(variants_of("ɑ")))


# --------------------------------------------------------------------------------------
# 2. 幂等
# --------------------------------------------------------------------------------------
IDEMPOTENCE_SAMPLES = (
    list(CANONICAL_MAP)
    + list(CANONICAL_MAP.values())
    + sorted(CANONICAL_PHONEMES)
    + ["", "   ", "ʘ", "q", "a", "fluent", "1125ms pause", "n̩", "æː", "t͡ʃ", "ˈθ", "θː", "ABC"]
)


@pytest.mark.parametrize("symbol", IDEMPOTENCE_SAMPLES)
def test_canonicalization_is_idempotent(symbol):
    once = canonicalize_phoneme(symbol)
    assert canonicalize_phoneme(once) == once


def test_canonical_symbols_are_not_reported_as_unknown():
    for symbol in sorted(CANONICAL_PHONEMES):
        canonicalize_phoneme(symbol)
    assert seen_unknown_phonemes() == []


# --------------------------------------------------------------------------------------
# 3. 未在表中的符号原样返回（不丢信息）+ 可观测
# --------------------------------------------------------------------------------------
@pytest.mark.parametrize("unknown", ["ʘ", "ǀ", "q", "a", "ɢ", "fluent", "1125ms pause"])
def test_unknown_symbols_pass_through_unchanged(unknown):
    assert canonicalize_phoneme(unknown) == unknown


def test_unknown_symbols_are_recorded_once():
    canonicalize_phoneme("ʘ")
    canonicalize_phoneme("ʘ")
    canonicalize_phoneme("q")
    assert seen_unknown_phonemes() == ["q", "ʘ"]
    reset_unknown_phonemes()
    assert seen_unknown_phonemes() == []


def test_canonicalize_all_dedupes_and_preserves_order():
    assert canonicalize_all(["ɹ", "r", "ɛ", "ɒ", "ɑː", "ɑ", "θ"]) == ["r", "e", "ɑ", "θ"]
    assert canonicalize_all(["ɹ", "r"], dedupe=False) == ["r", "r"]
    assert canonicalize_all([]) == []
    assert canonicalize_all([None, "", "  ", "θ"]) == ["θ"]
    assert canonicalize_all(["iː", "i", "ɪ"]) == ["i", "ɪ"]


def test_looks_like_phoneme_guard():
    assert looks_like_phoneme("θ") and looks_like_phoneme("dʒ") and looks_like_phoneme("r")
    assert not looks_like_phoneme("1125ms pause")
    assert not looks_like_phoneme("fluent")
    assert not looks_like_phoneme("")
    assert not looks_like_phoneme(None)
    assert not looks_like_phoneme("drum")
    assert not looks_like_phoneme("abc")


# --------------------------------------------------------------------------------------
# 4. nbest 排序/分数不变；issues expected/actual 同步归一化
# --------------------------------------------------------------------------------------
def _result_with_ga_symbols() -> PAResult:
    return PAResult(
        provider="fake_ga",
        granularity="phoneme",
        mode="scripted",
        reference_text=TEXT,
        recognized_text="really hot",
        duration_ms=800,
        scores=PAScores(pron=60.0, accuracy=60.0, fluency=70.0, completeness=100.0, prosody=None),
        words=[
            WordScore(
                word="really",
                start_ms=0,
                end_ms=200,
                score=55.0,
                error_type="Mispronunciation",
                phonemes=[
                    PhonemeScore(
                        phoneme="ɹ",
                        score=50.0,
                        start_ms=0,
                        end_ms=60,
                        nbest=[
                            {"phoneme": "w", "score": 100.0},
                            {"phoneme": "ɹ", "score": 62.0},
                            {"phoneme": "l", "score": 41.0},
                        ],
                    )
                ],
            ),
            WordScore(
                word="hot",
                start_ms=200,
                end_ms=400,
                score=48.0,
                error_type="Mispronunciation",
                phonemes=[
                    PhonemeScore(
                        phoneme="ɒ",
                        score=40.0,
                        start_ms=200,
                        end_ms=260,
                        nbest=[{"phoneme": "ɑː", "score": 100.0}, {"phoneme": "ɔ", "score": 70.0}],
                    )
                ],
            ),
        ],
        issues=[
            PAIssue("Mispronunciation", "high", "really", "ɹ", "ɹ", "w", 50.0, 0, 60, "r_l_v"),
            PAIssue("Mispronunciation", "high", "hot", "ɒ", "ɒ", "ɑː", 40.0, 200, 260, None),
        ],
    )


def test_nbest_order_length_and_scores_unchanged():
    result = _result_with_ga_symbols()
    canonicalize_pa_result(result)
    first = result.words[0].phonemes[0]
    assert first.phoneme == "r"
    # 顺序不变、不去重、分数原样挂在原来的位置上
    assert [entry["phoneme"] for entry in first.nbest] == ["w", "r", "l"]
    assert [entry["score"] for entry in first.nbest] == [100.0, 62.0, 41.0]
    second = result.words[1].phonemes[0]
    assert second.phoneme == "ɑ"
    assert [entry["phoneme"] for entry in second.nbest] == ["ɑ", "ɔ"]  # ɑː -> ɑ，仍保留两条
    assert [entry["score"] for entry in second.nbest] == [100.0, 70.0]


def test_nbest_keeps_duplicates_when_variants_collapse():
    """两个不同写法归一到同一个符号时，nbest 不能被去重（否则会改变 nbest 条数与排序）。"""
    phoneme = PhonemeScore(
        "ɔ", 50.0, 0, 100, [{"phoneme": "ɒ", "score": 100.0}, {"phoneme": "ɑː", "score": 62.0}, {"phoneme": "ɔ", "score": 41.0}]
    )
    result = PAResult(
        provider="fake", granularity="phoneme", mode="scripted", reference_text="hot", recognized_text="hot",
        duration_ms=100, words=[WordScore("hot", 0, 100, 50.0, "Mispronunciation", [phoneme])],
    )
    canonicalize_pa_result(result)
    assert [entry["phoneme"] for entry in phoneme.nbest] == ["ɑ", "ɑ", "ɔ"]
    assert [entry["score"] for entry in phoneme.nbest] == [100.0, 62.0, 41.0]


def test_issues_expected_and_actual_are_normalized():
    result = _result_with_ga_symbols()
    canonicalize_pa_result(result)
    first, second = result.issues
    assert (first.phoneme, first.expected, first.actual) == ("r", "r", "w")
    assert first.hint_key == "r_l_v"
    assert (second.phoneme, second.expected, second.actual) == ("ɑ", "ɑ", "ɑ")
    assert second.hint_key in {
        "final_consonant",
        "stress_wrong",
        "schwa",
        "ae_e",
        "short_i_long_i",
    }


def test_non_phoneme_issue_text_is_left_alone():
    """local provider 的 UnexpectedBreak 会写 'fluent' / '1125ms pause'，不能被当符号处理。"""
    issue = PAIssue("UnexpectedBreak", "medium", "the", None, "fluent", "1125ms pause", None, 0, 100, "pause_wrong")
    result = PAResult(
        provider="local", granularity="word", mode="scripted", reference_text="the", recognized_text="the",
        duration_ms=200, words=[], issues=[issue],
    )
    canonicalize_pa_result(result)
    assert issue.expected == "fluent"
    assert issue.actual == "1125ms pause"
    assert issue.hint_key == "pause_wrong"
    assert seen_unknown_phonemes() == [], "非音素文本不应污染 unknown 列表"

    # provider 把描述性文本塞进 phoneme 字段时也要原样保留（不记录为未知符号）
    weird = PAIssue("Mispronunciation", "low", "the", "fluent", None, None, 60.0, 0, 50, None)
    result2 = PAResult(
        provider="local", granularity="word", mode="scripted", reference_text="the", recognized_text="the",
        duration_ms=100, words=[], issues=[weird],
    )
    canonicalize_pa_result(result2)
    assert weird.phoneme == "fluent"
    assert seen_unknown_phonemes() == []


def test_derive_hint_key_normalizes_inputs():
    assert derive_hint_key("ɹ", "w", "really") == "r_l_v"
    assert derive_hint_key("ɛ", None, "bed") == "ae_e"
    assert derive_hint_key("θ", "s", "think") == "th_voiceless"
    assert derive_hint_key("ð", "z", "weather") == "th_voiced"
    for phoneme in ("ɹ", "ɛ", "ɝ", "ɚ", "ʤ", "ɒ", "ɑː", "iː", "oʊ", "θ"):
        assert derive_hint_key(phoneme, None, "weather") in (
            "th_voiceless", "th_voiced", "r_l_v", "v_w", "short_i_long_i", "ae_e", "s_sh",
            "n_ng", "l_dark", "schwa", "final_consonant", "consonant_cluster", "stress_wrong",
            "monotone", "pause_wrong", "omission", "insertion",
        )


# --------------------------------------------------------------------------------------
# 5. 端到端：provider 输出 GA 符号 -> 响应落在规范空间
# --------------------------------------------------------------------------------------
class FakeGAPA:
    """模拟"Azure 返回 GA 风格 IPA"的 provider（不需要真实密钥）。"""

    name = "fake_ga"
    capabilities = Capabilities(phoneme_level=True, prosody=True, nbest_phonemes=True)

    def assess(self, clip, reference_text, mode="scripted", granularity="phoneme", with_intonation=True, learner_age_band=None):
        result = _result_with_ga_symbols()
        result.duration_ms = clip.duration_ms
        result.reference_text = reference_text
        return result


def _patch_ga(monkeypatch):
    base = build_providers()
    fake = FakeGAPA()
    provider_set = ProviderSet(
        asr=base.asr,
        pa=fake,
        tts=base.tts,
        asr_chain=base.asr_chain,
        pa_chain=[fake],
        tts_chain=base.tts_chain,
        mode=base.mode,
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    return fake


def test_endpoint_outputs_only_canonical_symbols(client, monkeypatch, sweep):
    _patch_ga(monkeypatch)
    response = post_pronounce(client, sweep, TEXT)
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "fake_ga"
    assert body["provider_meta"]["phoneme_space"] == PHONEME_SPACE_ID

    phonemes = [p["phoneme"] for word in body["words"] for p in word["phonemes"]]
    nbest = [n["phoneme"] for word in body["words"] for p in word["phonemes"] for n in p["nbest"]]
    issues = [i[key] for i in body["issues"] for key in ("phoneme", "expected", "actual")]
    symbols = [s for s in phonemes + nbest + issues if s]
    assert symbols
    non_canonical = sorted({s for s in symbols if s not in CANONICAL_PHONEMES})
    assert not non_canonical, f"对外输出了非规范符号: {non_canonical}"

    assert phonemes[0] == "r"
    assert [n["phoneme"] for n in body["words"][0]["phonemes"][0]["nbest"]] == ["w", "r", "l"]
    assert [n["score"] for n in body["words"][0]["phonemes"][0]["nbest"]] == [100.0, 62.0, 41.0]
    assert body["words"][1]["phonemes"][0]["phoneme"] == "ɑ"


def test_endpoint_issue_symbols_are_normalized(client, monkeypatch, sweep):
    _patch_ga(monkeypatch)
    body = post_pronounce(client, sweep, TEXT).json()
    issues = body["issues"]
    assert issues[0]["phoneme"] == "r" and issues[0]["expected"] == "r" and issues[0]["actual"] == "w"
    assert issues[1]["phoneme"] == "ɑ" and issues[1]["expected"] == "ɑ"
    for issue in issues:
        assert issue["hint_key"]


def test_mock_provider_output_is_canonical(client, sweep):
    body = post_pronounce(client, sweep, TEXT, learner_age_band="child").json()
    symbols = (
        [p["phoneme"] for word in body["words"] for p in word["phonemes"]]
        + [n["phoneme"] for word in body["words"] for p in word["phonemes"] for n in p["nbest"]]
        + [i[key] for i in body["issues"] for key in ("phoneme", "expected", "actual")]
    )
    bad = sorted({s for s in symbols if s and s not in CANONICAL_PHONEMES})
    assert not bad, f"mock 输出非规范符号: {bad}"
    # 词典里的 ɹ/ɡ 必须已折叠成 r/ɡ
    assert "ɹ" not in symbols
