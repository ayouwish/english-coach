"""语调模块：F0 提取 → 半音归一化 → DTW 对齐 → worst_regions 定位。

设计要点（契约 §3.1）：
- **与 provider 无关**：任何 provider（含 mock）下都应返回 ``intonation``，纯本地计算，离线可用。
- ``user_f0`` / ``reference_f0``：``[time_ms, f0_hz|null]``，20ms 步长，最多 600 点，等间隔抽稀；
  两条曲线使用**同一时间轴、同一长度**（DTW 对齐后输出）。
- ``dtw_distance``：各自减去自身浊音段 F0 均值、取 ``12*log2`` 半音归一化后的归一化距离。
- 不可用时 ``available=false`` 且其余字段为 null。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

FRAME_STEP_MS = 20
MAX_POINTS = 600
MIN_VOICED_FRAMES = 3
UNVOICED_COST = 2.0  # 半音：一边清音一边浊音时的固定代价
PITCH_FLOOR = 60.0
PITCH_CEILING = 500.0

ISSUE_TYPES: tuple[str, ...] = (
    "expected_rise_but_flat",
    "expected_fall_but_flat",
    "wrong_direction",
    "stress_misplaced",
    "monotone_overall",
    "unexpected_pause",
)


@dataclass
class F0Series:
    times_ms: np.ndarray
    f0: np.ndarray  # nan = 清音/无基频

    def __post_init__(self) -> None:
        self.times_ms = np.asarray(self.times_ms, dtype=np.float64).reshape(-1)
        self.f0 = np.asarray(self.f0, dtype=np.float64).reshape(-1)

    def __len__(self) -> int:
        return int(self.f0.size)

    @property
    def voiced_mask(self) -> np.ndarray:
        return np.isfinite(self.f0) & (self.f0 > 0)

    @property
    def voiced_count(self) -> int:
        return int(np.count_nonzero(self.voiced_mask))

    def decimate(self, max_points: int = MAX_POINTS) -> "F0Series":
        if self.f0.size <= max_points:
            return self
        idx = np.unique(np.linspace(0, self.f0.size - 1, num=max_points).round().astype(int))
        return F0Series(self.times_ms[idx], self.f0[idx])

    def to_pairs(self) -> list[list]:
        out: list[list] = []
        for t, f in zip(self.times_ms, self.f0):
            out.append([int(round(float(t))), None if not math.isfinite(float(f)) or f <= 0 else float(round(float(f), 2))])
        return out


@dataclass
class IntonationResult:
    available: bool = False
    dtw_distance: float | None = None
    user_f0: list[list] | None = None
    reference_f0: list[list] | None = None
    worst_regions: list[dict] = field(default_factory=list)
    reference_audio_url: str | None = None
    reason: str | None = None
    reference_series: F0Series | None = None

    def to_contract(self) -> dict:
        if not self.available:
            return {
                "available": False,
                "dtw_distance": None,
                "user_f0": None,
                "reference_f0": None,
                "worst_regions": [],
                "reference_audio_url": self.reference_audio_url,
            }
        return {
            "available": True,
            "dtw_distance": self.dtw_distance,
            "user_f0": self.user_f0,
            "reference_f0": self.reference_f0,
            "worst_regions": self.worst_regions,
            "reference_audio_url": self.reference_audio_url,
        }


# --------------------------------------------------------------------------------------
# F0 extraction
# --------------------------------------------------------------------------------------
def extract_f0(
    samples: np.ndarray,
    sample_rate: int,
    step_ms: int = FRAME_STEP_MS,
    floor: float = PITCH_FLOOR,
    ceiling: float = PITCH_CEILING,
) -> F0Series:
    """用 praat-parselmouth（自相关法）提取基频，清音帧为 nan。"""
    import parselmouth  # 惰性导入：只有真的算语调才需要

    audio = np.asarray(samples, dtype=np.float64).reshape(-1)
    if audio.size == 0:
        return F0Series(np.zeros(0), np.zeros(0))
    sound = parselmouth.Sound(audio, sampling_frequency=float(sample_rate))
    pitch = sound.to_pitch(time_step=step_ms / 1000.0, pitch_floor=floor, pitch_ceiling=ceiling)
    f0 = np.asarray(pitch.selected_array["frequency"], dtype=np.float64)
    times = np.asarray(pitch.xs(), dtype=np.float64) * 1000.0
    f0 = np.where(np.isfinite(f0) & (f0 > 0), f0, np.nan)
    series = F0Series(times, f0)
    return series.decimate(MAX_POINTS)


def series_from_pairs(pairs: list) -> F0Series:
    times: list[float] = []
    values: list[float] = []
    for item in pairs or []:
        if isinstance(item, dict):
            t, v = item.get("time_ms"), item.get("f0_hz")
        else:
            t, v = item[0], item[1]
        times.append(float(t))
        values.append(float("nan") if v is None else float(v))
    return F0Series(np.asarray(times, dtype=np.float64), np.asarray(values, dtype=np.float64))


def series_from_f0(
    f0: list[float | None],
    times_ms: list[float] | None = None,
    step_ms: int = FRAME_STEP_MS,
) -> F0Series:
    values = np.asarray([float("nan") if v is None else float(v) for v in f0], dtype=np.float64)
    if times_ms is None:
        times = np.arange(values.size, dtype=np.float64) * step_ms
    else:
        times = np.asarray(times_ms, dtype=np.float64)
    return F0Series(times, values).decimate(MAX_POINTS)


# --------------------------------------------------------------------------------------
# Normalization / DTW
# --------------------------------------------------------------------------------------
def normalize_semitones(f0: np.ndarray) -> tuple[np.ndarray, float | None]:
    """各自减去自身浊音段 F0 均值再取 12*log2 -> 半音域，清音保持 nan。"""
    values = np.asarray(f0, dtype=np.float64)
    mask = np.isfinite(values) & (values > 0)
    if not np.any(mask):
        return np.full(values.shape, np.nan), None
    mean = float(np.mean(values[mask]))
    if mean <= 0:
        return np.full(values.shape, np.nan), None
    out = np.full(values.shape, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        out[mask] = 12.0 * np.log2(values[mask] / mean)
    return out, mean


def local_cost(a: float, b: float) -> float:
    a_nan = not math.isfinite(a)
    b_nan = not math.isfinite(b)
    if a_nan and b_nan:
        return 0.0
    if a_nan or b_nan:
        return UNVOICED_COST
    return abs(a - b)


def dtw_align(user_st: np.ndarray, ref_st: np.ndarray) -> tuple[list[tuple[int, int]], float]:
    """经典 DP（无外部依赖）。返回 (path, normalized_distance)。

    normalized_distance = 累计代价 / 路径长度，单位是半音，越小越接近。
    """
    n = int(user_st.size)
    m = int(ref_st.size)
    if n == 0 or m == 0:
        return [], float("inf")
    inf = float("inf")
    cost = np.full((n, m), 0.0, dtype=np.float64)
    for i in range(n):
        ui = user_st[i]
        for j in range(m):
            cost[i, j] = local_cost(ui, ref_st[j])
    acc = np.full((n + 1, m + 1), inf, dtype=np.float64)
    acc[0, 0] = 0.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            acc[i, j] = cost[i - 1, j - 1] + min(acc[i - 1, j - 1], acc[i - 1, j], acc[i, j - 1])
    if not math.isfinite(acc[n, m]):
        return [], float("inf")
    path: list[tuple[int, int]] = []
    i, j = n, m
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        candidates = ((acc[i - 1, j - 1], i - 1, j - 1), (acc[i - 1, j], i - 1, j), (acc[i, j - 1], i, j - 1))
        _, i, j = min(candidates, key=lambda item: item[0])
    path.reverse()
    return path, float(acc[n, m] / max(1, len(path)))


def align_user_to_reference(
    user_st: np.ndarray,
    ref_st: np.ndarray,
    path: list[tuple[int, int]],
) -> np.ndarray:
    """把 user 半音曲线按 DTW 路径映射到 reference 的时间轴（同一长度）。"""
    m = int(ref_st.size)
    buckets: list[list[float]] = [[] for _ in range(m)]
    for i, j in path:
        if 0 <= j < m:
            buckets[j].append(float(user_st[i]))
    aligned = np.full(m, np.nan, dtype=np.float64)
    for j, values in enumerate(buckets):
        finite = [v for v in values if math.isfinite(v)]
        if finite:
            aligned[j] = float(np.mean(finite))
        elif values:
            aligned[j] = float("nan")
    return aligned


# --------------------------------------------------------------------------------------
# worst_regions
# --------------------------------------------------------------------------------------
def _moving_average(values: np.ndarray, window: int = 3) -> np.ndarray:
    if values.size == 0 or window <= 1:
        return values
    kernel = np.ones(window, dtype=np.float64) / window
    padded = np.pad(values, (window // 2, window - 1 - window // 2), mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def _slope(times_ms: np.ndarray, values: np.ndarray) -> float:
    """线性回归斜率，单位 半音/秒。"""
    mask = np.isfinite(values)
    if np.count_nonzero(mask) < 2:
        return 0.0
    x = times_ms[mask] / 1000.0
    y = values[mask]
    if float(np.ptp(x)) <= 1e-6:
        return 0.0
    return float(np.polyfit(x, y, 1)[0])


def _runs(mask: np.ndarray, min_len: int) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    start: int | None = None
    for idx, flag in enumerate(mask):
        if flag and start is None:
            start = idx
        elif not flag and start is not None:
            if idx - start >= min_len:
                out.append((start, idx - 1))
            start = None
    if start is not None and mask.size - start >= min_len:
        out.append((start, mask.size - 1))
    return out


def _merge(runs: list[tuple[int, int]], max_gap: int) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for run in runs:
        if merged and run[0] - merged[-1][1] <= max_gap:
            merged[-1] = (merged[-1][0], run[1])
        else:
            merged.append(run)
    return merged


def classify_region(ref_slope: float, user_slope: float) -> str:
    rise, flat_limit = 1.0, 0.9
    if ref_slope >= rise and abs(user_slope) < flat_limit:
        return "expected_rise_but_flat"
    if ref_slope <= -rise and abs(user_slope) < flat_limit:
        return "expected_fall_but_flat"
    if ref_slope * user_slope < 0 and abs(ref_slope) >= rise and abs(user_slope) >= flat_limit:
        return "wrong_direction"
    if abs(user_slope - ref_slope) > 2.5:
        return "wrong_direction"
    return "stress_misplaced"


def find_worst_regions(
    times_ms: np.ndarray,
    ref_st: np.ndarray,
    user_st: np.ndarray,
    word_timings: list[dict] | None = None,
    max_regions: int = 3,
) -> list[dict]:
    """定位语调偏差最大的区间；输出与契约 ``worst_regions[]`` 一致。"""
    from .text import words_in_span

    if ref_st.size == 0 or ref_st.size != user_st.size:
        return []
    diff = np.abs(user_st - ref_st)
    diff = np.where(np.isfinite(diff), diff, UNVOICED_COST)
    smooth = _moving_average(diff, 3)
    finite_diff = diff[np.isfinite(diff)]
    baseline = float(np.median(finite_diff)) if finite_diff.size else 0.0
    threshold = max(1.2, baseline + 0.8)
    runs = _merge(_runs(smooth >= threshold, min_len=3), max_gap=2)

    regions: list[dict] = []
    for start, end in runs:
        span_ref = ref_st[start : end + 1]
        span_user = user_st[start : end + 1]
        span_times = times_ms[start : end + 1]
        ref_slope = _slope(span_times, span_ref)
        user_slope = _slope(span_times, span_user)
        issue = classify_region(ref_slope, user_slope)
        regions.append(
            {
                "start_ms": int(round(float(span_times[0]))),
                "end_ms": int(round(float(span_times[-1]))),
                "text": words_in_span(word_timings or [], float(span_times[0]), float(span_times[-1])),
                "issue": issue,
                "user_slope": round(user_slope, 2),
                "ref_slope": round(ref_slope, 2),
                "_weight": float(np.mean(smooth[start : end + 1])),
            }
        )

    # 全程平调（monotone）：参考曲线起伏明显而用户几乎不动
    ref_voiced = ref_st[np.isfinite(ref_st)]
    user_voiced = user_st[np.isfinite(user_st)]
    if ref_voiced.size >= 4 and user_voiced.size >= 4:
        if float(np.std(ref_voiced)) > 1.8 and float(np.std(user_voiced)) < 0.9:
            regions.append(
                {
                    "start_ms": int(round(float(times_ms[0]))),
                    "end_ms": int(round(float(times_ms[-1]))),
                    "text": words_in_span(word_timings or [], float(times_ms[0]), float(times_ms[-1])),
                    "issue": "monotone_overall",
                    "user_slope": round(_slope(times_ms, user_st), 2),
                    "ref_slope": round(_slope(times_ms, ref_st), 2),
                    "_weight": float(np.nanmax(smooth)) if smooth.size else 1.5,
                }
            )

    # 用户该出声却停住的段（超过 250ms）
    gap_mask = ~np.isfinite(user_st) & np.isfinite(ref_st)
    for start, end in _runs(gap_mask, min_len=max(3, int(250 / FRAME_STEP_MS))):
        span_times = times_ms[start : end + 1]
        if span_times.size < 2 or float(span_times[-1] - span_times[0]) < 220:
            continue
        regions.append(
            {
                "start_ms": int(round(float(span_times[0]))),
                "end_ms": int(round(float(span_times[-1]))),
                "text": words_in_span(word_timings or [], float(span_times[0]), float(span_times[-1])),
                "issue": "unexpected_pause",
                "user_slope": 0.0,
                "ref_slope": round(_slope(span_times, ref_st[start : end + 1]), 2),
                "_weight": UNVOICED_COST + 0.5,
            }
        )

    regions.sort(key=lambda item: item["_weight"], reverse=True)
    trimmed = regions[:max_regions]
    # 同类 issue 只保留权重最高的一个，避免三条都是同一类
    seen_issues: set[str] = set()
    final: list[dict] = []
    for region in trimmed:
        if region["issue"] in seen_issues and region["issue"] != "unexpected_pause":
            continue
        seen_issues.add(region["issue"])
        region.pop("_weight", None)
        final.append(region)
    return final


# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------
def prosody_score_from_distance(distance: float | None) -> float | None:
    if distance is None or not math.isfinite(distance):
        return None
    return float(round(min(100.0, max(0.0, 100.0 - 90.0 * distance)), 1))


def compare_intonation(
    user_series: F0Series | None,
    reference_series: F0Series | None,
    word_timings: list[dict] | None = None,
    reference_audio_url: str | None = None,
    max_regions: int = 3,
) -> IntonationResult:
    """对齐两条 F0 曲线并给出 worst_regions。任何异常都降级为 available=false，不抛错。"""
    result = IntonationResult(reference_audio_url=reference_audio_url)
    if reference_series is None or user_series is None:
        result.reason = "missing_audio"
        return result
    if user_series.voiced_count < MIN_VOICED_FRAMES:
        result.reason = "user_too_few_voiced_frames"
        return result
    if reference_series.voiced_count < MIN_VOICED_FRAMES:
        result.reason = "reference_too_few_voiced_frames"
        return result
    try:
        user_series = user_series.decimate(MAX_POINTS)
        reference_series = reference_series.decimate(MAX_POINTS)
        user_st, user_mean = normalize_semitones(user_series.f0)
        ref_st, ref_mean = normalize_semitones(reference_series.f0)
        path, distance = dtw_align(user_st, ref_st)
        if not path or not math.isfinite(distance):
            result.reason = "dtw_failed"
            return result
        user_aligned = align_user_to_reference(user_st, ref_st, path)
        # 半音域是负数域，契约要求输出 Hz：用各自的浊音均值还原回 Hz（时间轴仍取 reference）
        with np.errstate(over="ignore", invalid="ignore"):
            user_hz = np.where(np.isfinite(user_aligned), (user_mean or 0.0) * np.power(2.0, user_aligned / 12.0), np.nan)
        # 同一时间轴 = reference 的时间轴；两条曲线同长度
        result.available = True
        result.dtw_distance = round(float(distance), 4)
        result.reference_f0 = F0Series(reference_series.times_ms, reference_series.f0).to_pairs()
        result.user_f0 = F0Series(reference_series.times_ms, user_hz).to_pairs()
        result.worst_regions = find_worst_regions(
            reference_series.times_ms, ref_st, user_aligned, word_timings=word_timings, max_regions=max_regions
        )
        result.reference_series = reference_series
        return result
    except Exception as exc:  # 语调永远不能把请求打成 500
        result.available = False
        result.reason = f"error:{type(exc).__name__}"
        return result
