"""语调模块：合成信号验证 F0 提取、DTW 对齐与 worst_regions 定位。

覆盖两条路径：
1. 波形级（正弦/扫频 -> praat F0 -> DTW）；
2. 注入 F0 序列（完全确定性，验证半音归一化与区间定位分类）。
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.audio_io import decode_audio
from app.intonation import (
    compare_intonation,
    extract_f0,
    find_worst_regions,
    normalize_semitones,
    prosody_score_from_distance,
    series_from_f0,
)
from app.synth import sweep_wav, tone_wav

STEP_MS = 20


def _series(values: list[float | None]):
    return series_from_f0(values, step_ms=STEP_MS)


def _flat(hz: float, frames: int) -> list[float]:
    return [hz] * frames


def _ramp(start: float, end: float, frames: int) -> list[float]:
    return list(np.linspace(start, end, frames))


# --------------------------------------------------------------------------------------
# 1. F0 提取（praat）
# --------------------------------------------------------------------------------------
def test_extract_f0_tracks_sine_sweep():
    clip = decode_audio(sweep_wav(150.0, 250.0, 2.0))  # 线性扫频 150->250Hz
    series = extract_f0(clip.samples, clip.sample_rate, step_ms=STEP_MS)
    assert series.voiced_count > len(series) * 0.6, "扫频信号应该大部分帧都有基频"
    voiced = [(t, f) for t, f in zip(series.times_ms, series.f0) if math.isfinite(f)]
    mid = voiced[len(voiced) // 4 : 3 * len(voiced) // 4]
    assert mid, "中段必须有浊音帧"
    for time_ms, f0 in mid:
        expected = 150.0 + (250.0 - 150.0) * (time_ms / 1000.0) / 2.0
        assert abs(f0 - expected) / expected < 0.08, f"t={time_ms}ms f0={f0} expected≈{expected}"
    # 20ms 步长
    assert np.allclose(np.diff(series.times_ms), STEP_MS, atol=0.51)


def test_extract_f0_marks_silence_unvoiced():
    silence = np.zeros(16000, dtype=np.float32)
    series = extract_f0(silence, 16000, step_ms=STEP_MS)
    assert series.voiced_count == 0


def test_prosody_score_mapping():
    assert prosody_score_from_distance(0.0) == 100.0
    assert 0.0 <= prosody_score_from_distance(0.42) <= 100.0
    assert prosody_score_from_distance(3.0) == 0.0
    assert prosody_score_from_distance(None) is None


# --------------------------------------------------------------------------------------
# 2. DTW
# --------------------------------------------------------------------------------------
def test_dtw_distance_zero_for_identical_curves():
    f0 = _flat(180.0, 50) + _ramp(180.0, 240.0, 50)
    result = compare_intonation(_series(f0), _series(f0))
    assert result.available is True
    assert result.dtw_distance == pytest.approx(0.0, abs=1e-6)
    assert result.worst_regions == []


def test_dtw_is_octave_shift_invariant_after_semitone_normalization():
    """各自减去自身均值再取半音 -> 整体升八度不应改变距离。"""
    ref = _flat(200.0, 60) + _ramp(200.0, 300.0, 60)
    user = [value * 2.0 for value in ref]
    same = compare_intonation(_series(ref), _series(ref)).dtw_distance
    shifted = compare_intonation(_series(user), _series(ref)).dtw_distance
    assert same == pytest.approx(0.0, abs=1e-6)
    assert shifted == pytest.approx(same, abs=1e-6)

    st_ref, mean_ref = normalize_semitones(np.asarray(ref, dtype=float))
    st_user, mean_user = normalize_semitones(np.asarray(user, dtype=float))
    assert mean_user == pytest.approx(mean_ref * 2.0)
    assert np.allclose(st_ref, st_user, atol=1e-9)


def test_dtw_distance_grows_with_deviation():
    ref = _ramp(180.0, 260.0, 100)
    close = compare_intonation(_series([v + 2 for v in ref]), _series(ref)).dtw_distance
    far = compare_intonation(_series(_flat(220.0, 100)), _series(ref)).dtw_distance
    assert close < far


# --------------------------------------------------------------------------------------
# 3. worst_regions 定位
# --------------------------------------------------------------------------------------
def test_rise_region_detected_as_expected_rise_but_flat():
    """参考曲线在后半段上扬，用户全程平 -> 命中 expected_rise_but_flat。"""
    ref = _flat(200.0, 50) + _ramp(200.0, 320.0, 50)  # 0-1s 平，1-2s 上扬
    user = _flat(150.0, 100)
    result = compare_intonation(_series(user), _series(ref))
    assert result.available is True
    regions = result.worst_regions
    assert regions, "应定位到偏差区间"
    hits = [r for r in regions if r["issue"] == "expected_rise_but_flat"]
    assert hits, regions
    region = hits[0]
    assert region["start_ms"] < 2000 and region["end_ms"] > 1000, "区间应落在上扬段"
    assert region["ref_slope"] > 1.0
    assert abs(region["user_slope"]) < 0.9


def test_fall_region_detected_as_expected_fall_but_flat():
    ref = _flat(320.0, 50) + _ramp(320.0, 200.0, 50)
    user = _flat(220.0, 100)
    regions = compare_intonation(_series(user), _series(ref)).worst_regions
    assert any(r["issue"] == "expected_fall_but_flat" for r in regions), regions


def test_opposite_direction_detected_as_wrong_direction():
    ref = _flat(200.0, 50) + _ramp(200.0, 320.0, 50)
    user = _flat(300.0, 50) + _ramp(300.0, 180.0, 50)
    regions = compare_intonation(_series(user), _series(ref)).worst_regions
    assert any(r["issue"] == "wrong_direction" for r in regions), regions


def test_user_gap_detected_as_unexpected_pause():
    ref = _flat(200.0, 100)
    user: list[float | None] = _flat(200.0, 100)
    for idx in range(50, 70):  # 400ms 该出声却停住
        user[idx] = None
    regions = compare_intonation(_series(user), _series(ref)).worst_regions
    pauses = [r for r in regions if r["issue"] == "unexpected_pause"]
    assert pauses, regions
    assert pauses[0]["start_ms"] >= 900 and pauses[0]["end_ms"] <= 1500, pauses[0]


def test_monotone_overall_when_reference_has_wide_pitch_range():
    frames = 120
    ref = [220.0 + 60.0 * math.sin(2 * math.pi * idx / 60) for idx in range(frames)]
    user = _flat(200.0, frames)
    regions = compare_intonation(_series(user), _series(ref)).worst_regions
    assert any(r["issue"] == "monotone_overall" for r in regions), regions


def test_find_worst_regions_returns_contract_fields():
    times = np.arange(100, dtype=float) * STEP_MS
    ref_st = np.linspace(0.0, 6.0, 100)
    user_st = np.zeros(100)
    regions = find_worst_regions(times, ref_st, user_st, word_timings=[{"word": "today", "start_ms": 1000, "end_ms": 2000}])
    assert regions
    for region in regions:
        assert set(region) == {"start_ms", "end_ms", "text", "issue", "user_slope", "ref_slope"}
        assert region["text"] == "today"


# --------------------------------------------------------------------------------------
# 4. 波形级端到端
# --------------------------------------------------------------------------------------
def test_waveform_level_flat_user_vs_rising_reference():
    ref_clip = decode_audio(sweep_wav(180.0, 320.0, 2.0))
    user_clip = decode_audio(tone_wav(200.0, 2.0))
    result = compare_intonation(
        extract_f0(user_clip.samples, user_clip.sample_rate, step_ms=STEP_MS),
        extract_f0(ref_clip.samples, ref_clip.sample_rate, step_ms=STEP_MS),
    )
    assert result.available is True
    assert result.dtw_distance > 0.5
    assert result.user_f0 and result.reference_f0
    assert len(result.user_f0) == len(result.reference_f0)
    assert any(r["issue"] == "expected_rise_but_flat" for r in result.worst_regions), result.worst_regions


def test_waveform_level_identical_signals_have_no_worst_regions():
    payload = sweep_wav(160.0, 240.0, 1.6)
    first = decode_audio(payload)
    second = decode_audio(payload)
    result = compare_intonation(
        extract_f0(first.samples, first.sample_rate),
        extract_f0(second.samples, second.sample_rate),
    )
    assert result.available is True
    assert result.dtw_distance == pytest.approx(0.0, abs=1e-6)
    assert result.worst_regions == []


def test_compare_unavailable_when_user_is_silent():
    ref = _series(_ramp(180.0, 240.0, 60))
    result = compare_intonation(_series([None] * 60), ref)
    assert result.available is False
    assert result.reason == "user_too_few_voiced_frames"
    payload = result.to_contract()
    assert payload["available"] is False
    assert payload["dtw_distance"] is None
    assert payload["user_f0"] is None
    assert payload["reference_f0"] is None


def test_curves_are_capped_at_600_points():
    """契约：最多 600 个点，超过则等间隔抽稀；两条曲线仍必须同长度同时间轴。"""
    frames = 2000  # 40 秒 @20ms
    ref = [180.0 + 40.0 * math.sin(2 * math.pi * idx / 100) for idx in range(frames)]
    user = [200.0 + 25.0 * math.sin(2 * math.pi * idx / 100) for idx in range(frames)]
    result = compare_intonation(_series(user), _series(ref))
    assert result.available is True
    assert len(result.user_f0) == len(result.reference_f0) == 600
    assert [p[0] for p in result.user_f0] == [p[0] for p in result.reference_f0]
    # 抽稀后步长 > 20ms，但时间轴仍单调递增
    times = [p[0] for p in result.user_f0]
    assert times == sorted(times) and len(set(times)) == 600
    assert result.dtw_distance is not None


def test_low_periodicity_signals_yield_unavailable_intonation():
    """无基频结构的输入必须显式降级（available=false），而不是编造曲线。"""
    rng = np.random.default_rng(0)
    sr = 16000
    t = np.arange(sr) / sr
    cases = {
        "silence": np.zeros(sr, dtype=np.float32),
        "dc_offset": np.full(sr, 0.3, dtype=np.float32),
        "white_noise": (0.4 * rng.standard_normal(sr)).astype(np.float32),
        "aperiodic_impulses": ((rng.random(sr) < 0.002).astype(np.float32) * 0.9),
        "sub_audible_30hz": (0.5 * np.sin(2 * np.pi * 30 * t)).astype(np.float32),
    }
    ref = _series(_ramp(180.0, 240.0, 80))
    for name, samples in cases.items():
        series = extract_f0(samples, sr)
        assert series.voiced_count == 0, f"{name} 不应被判定为浊音"
        result = compare_intonation(series, ref)
        assert result.available is False, name
        assert result.reason == "user_too_few_voiced_frames", name


@pytest.mark.parametrize("hz", [120.0, 180.0, 440.0, 900.0])
def test_pure_sine_still_tracks(hz):
    """纯正弦（基频在 praat 搜索区间内，或高到足以锁定其分谐波）仍应产出可用语调曲线。"""
    clip = decode_audio(tone_wav(hz, 1.5))
    series = extract_f0(clip.samples, clip.sample_rate)
    assert series.voiced_count > len(series) * 0.5, f"{hz}Hz 应被跟踪"
    ref_clip = decode_audio(sweep_wav(150.0, 250.0, 1.5))
    assert compare_intonation(series, extract_f0(ref_clip.samples, ref_clip.sample_rate)).available is True


def test_too_short_audio_has_too_few_voiced_frames():
    """≈50ms 的音频只有 1 帧，无法做 DTW -> 显式 unavailable。"""
    clip = decode_audio(tone_wav(180.0, 0.05))
    series = extract_f0(clip.samples, clip.sample_rate)
    assert series.voiced_count < 3
    assert compare_intonation(series, _series(_flat(200.0, 80))).available is False
