"""参考音频 / 参考 F0 曲线的内容寻址缓存（契约 v1.1 §12）。

- 音频：`DATA_DIR/cache/audio/<sha1(text \\x1f voice \\x1f rate)>.<ext>`
- F0  ：`DATA_DIR/cache/f0/<同一个 hash>.json`，内容是**归一化之前**的 `[time_ms, f0_hz|null]` 序列
- 对外 id 仍是 `ref_<hash 前12位>.<ext>`（v1.0 的 `reference_audio_url` 形态不变）
- 读取必须**校验后使用**：JSON 坏 / 点数异常一律当未命中重新生成，绝不因坏缓存给错分
- LRU 上限（默认 500MB / 2000 条，环境变量可覆盖）
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("voice.cache")

KEY_SEP = "\x1f"
# 契约 v1.2 §12.2：版本前缀参与 hash，规则变更时旧缓存自动失效（缓存可再生，重新预热即可）
KEY_VERSION = "v3"
F0_SCHEMA_VERSION = 1
MIN_F0_POINTS = 2
MAX_F0_POINTS = 600

STATE_HIT = "hit"
STATE_MISS = "miss"
STATE_DISABLED = "disabled"

EXT_CONTENT_TYPES = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
    "m4a": "audio/mp4",
    "opus": "audio/ogg",
    "webm": "audio/webm",
}
CONTENT_TYPE_EXTS = {value: key for key, value in EXT_CONTENT_TYPES.items()}
SUPPORTED_EXTS = tuple(EXT_CONTENT_TYPES)


def cache_key(
    text: str,
    voice: str | None,
    rate: str | None,
    tts_provider: str | None,
    fmt: str | None,
) -> str:
    """sha1("v3" + "\\x1f" + tts_provider + "\\x1f" + fmt + "\\x1f" + text + "\\x1f" + voice + "\\x1f" + rate)。

    契约 v1.3 §12.2 逐字实现。三个分量都必须有：

    - **`tts_provider`**（实际产出音频的 provider 名，与 `/v1/health` 的 `providers.tts` 同口径）：
      v1.1 缺它时，`azure_tts_voice` / `edge_tts_voice` / `default_tts_voice` 默认值相同，
      于是 mock 预热出的**合成音 + 合成 F0** 会被 azure 模式命中——用户把蜂鸣当"母语者示范"听，
      真实语音还被拿去和合成扫频曲线做 DTW。
    - **`fmt`**（`mp3` / `wav`）：两者是**不同产物**（容器、编码、码率都不同），
      而且历史上 Azure 的格式设置静默失效导致缓存里存的是 16kHz 坏音频，
      所以 `KEY_VERSION` 从 `"v2"` 升到 `"v3"`，旧条目一律不再命中。
    """
    payload = (
        f"{KEY_VERSION}{KEY_SEP}{tts_provider or ''}{KEY_SEP}{fmt or ''}{KEY_SEP}{text or ''}"
        f"{KEY_SEP}{voice or ''}{KEY_SEP}{rate or 'normal'}"
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def legacy_v2_cache_key(text: str, voice: str | None, rate: str | None, tts_provider: str | None) -> str:
    """v1.2 的旧 key（含 provider、不含 fmt、无 v3 前缀）。仅用于回归测试/迁移说明。"""
    payload = (
        f"v2{KEY_SEP}{tts_provider or ''}{KEY_SEP}{text or ''}"
        f"{KEY_SEP}{voice or ''}{KEY_SEP}{rate or 'normal'}"
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def legacy_v11_cache_key(text: str, voice: str | None, rate: str | None) -> str:
    """v1.1 的旧 key 形态（无版本前缀、无 provider）。

    仅用于回归测试与迁移说明：v1.2 起不会再命中这些旧条目，升级后需重新预热一次。
    """
    payload = f"{text or ''}{KEY_SEP}{voice or ''}{KEY_SEP}{rate or 'normal'}"
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def ext_from_content_type(content_type: str | None, default: str = "wav") -> str:
    base = (content_type or "").split(";")[0].strip().lower()
    return CONTENT_TYPE_EXTS.get(base, default)


def external_audio_id(key: str, ext: str) -> str:
    """对外 id 形态沿用 v1.0：ref_<sha1前12位>.<ext>。"""
    return f"ref_{key[:12]}.{ext.lstrip('.')}"


def validate_f0_points(payload) -> list[list] | None:
    """结构校验：不合法返回 None（调用方视为缓存未命中并重新生成）。

    接受两种落盘形态：裸数组 `[[t,f],...]` 或信封 `{"v":1,"points":[...]}`。
    """
    if isinstance(payload, dict):
        raw = payload.get("points")
        if raw is None:
            raw = payload.get("f0")
    else:
        raw = payload
    if not isinstance(raw, list) or not (MIN_F0_POINTS <= len(raw) <= MAX_F0_POINTS):
        return None

    points: list[list] = []
    previous_t: float | None = None
    voiced = 0
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            return None
        time_ms, value = item
        if isinstance(time_ms, bool) or not isinstance(time_ms, (int, float)):
            return None
        time_ms = float(time_ms)
        if not math.isfinite(time_ms):
            return None
        if previous_t is not None and time_ms <= previous_t:
            return None  # 时间轴必须严格递增
        previous_t = time_ms
        if value is None:
            f0 = None
        elif isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or float(value) <= 0:
            return None
        else:
            f0 = float(value)
            voiced += 1
        points.append([time_ms, f0])
    if voiced == 0:
        return None  # 全是清音 -> 不可能是有效的参考曲线，宁可重算
    return points


def f0_payload(points: list[list]) -> dict:
    return {"v": F0_SCHEMA_VERSION, "step_ms": 20, "count": len(points), "points": points}


@dataclass(frozen=True)
class CacheLimits:
    max_bytes: int = 500 * 1024 * 1024
    max_entries: int = 2000


class WarmupCache:
    """线程安全的文件缓存。所有写操作先写 .tmp 再原子 rename。"""

    def __init__(self, root: Path, max_bytes: int = 500 * 1024 * 1024, max_entries: int = 2000, enabled: bool = True):
        self.root = Path(root)
        self.audio_dir = self.root / "audio"
        self.f0_dir = self.root / "f0"
        self.limits = CacheLimits(max_bytes=max_bytes, max_entries=max_entries)
        self.enabled = bool(enabled)
        self._lock = threading.RLock()
        if self.enabled:
            self.audio_dir.mkdir(parents=True, exist_ok=True)
            self.f0_dir.mkdir(parents=True, exist_ok=True)

    # ---------------------------------------------------------------- helpers
    def _touch(self, path: Path) -> None:
        try:
            os.utime(path, None)  # LRU：访问即更新 mtime
        except Exception:
            pass

    def _audio_candidates(self, key: str) -> list[Path]:
        if not self.audio_dir.is_dir():
            return []
        return sorted(p for ext in SUPPORTED_EXTS for p in self.audio_dir.glob(f"{key}.{ext}"))

    def has_audio(self, key: str) -> bool:
        return self.enabled and bool(self._audio_candidates(key))

    # ---------------------------------------------------------------- audio
    def get_audio(self, key: str) -> tuple[bytes, str] | None:
        if not self.enabled:
            return None
        for path in self._audio_candidates(key):
            try:
                data = path.read_bytes()
            except Exception:
                continue
            if not data:
                continue
            self._touch(path)
            return data, path.suffix.lstrip(".").lower()
        return None

    def put_audio(self, key: str, data: bytes, ext: str) -> str:
        """写入音频并返回对外 id（ref_<前12位>.<ext>）。"""
        ext = (ext or "wav").lstrip(".").lower()
        if not self.enabled:
            return external_audio_id(key, ext)  # CACHE_ENABLED=false 时绝不落盘
        target = self.audio_dir / f"{key}.{ext}"
        with self._lock:
            self.audio_dir.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(target.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
            tmp.write_bytes(data)
            tmp.replace(target)
            for path in self._audio_candidates(key):
                if path != target:
                    path.unlink(missing_ok=True)  # provider 变了（wav<->mp3）就删掉旧格式
            self.evict()
        return external_audio_id(key, ext)

    def audio_external_id(self, key: str) -> str | None:
        for path in self._audio_candidates(key):
            return external_audio_id(key, path.suffix.lstrip(".").lower())
        return None

    # ---------------------------------------------------------------- f0
    def get_f0(self, key: str) -> list[list] | None:
        if not self.enabled:
            return None
        path = self.f0_dir / f"{key}.json"
        if not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("f0 cache unreadable (treated as miss): %s", path.name)
            return None
        points = validate_f0_points(payload)
        if points is None:
            logger.warning("f0 cache invalid (treated as miss): %s", path.name)
            return None
        self._touch(path)
        return points

    def put_f0(self, key: str, points: list[list]) -> None:
        if not self.enabled:
            return  # CACHE_ENABLED=false 时绝不落盘
        validated = validate_f0_points(points)
        if validated is None:
            return  # 自己都不合法的数据绝不落盘
        with self._lock:
            self.f0_dir.mkdir(parents=True, exist_ok=True)
            target = self.f0_dir / f"{key}.json"
            tmp = target.with_suffix(f".json.{os.getpid()}.{threading.get_ident()}.tmp")
            tmp.write_text(json.dumps(f0_payload(validated)), encoding="utf-8")
            tmp.replace(target)
            self.evict()

    # ---------------------------------------------------------------- resolve
    def resolve_external_id(self, audio_id: str) -> Path | None:
        """把对外 id（ref_<12位>.<ext>）解析回缓存文件。"""
        if not self.enabled or not audio_id.startswith("ref_"):
            return None
        stem, _, ext = audio_id[len("ref_") :].partition(".")
        if not stem or not ext:
            return None
        matches = sorted(self.audio_dir.glob(f"{stem}*.{ext}")) if self.audio_dir.is_dir() else []
        if not matches:
            return None
        for path in matches:
            if path.stem[: len(stem)] == stem:
                self._touch(path)
                return path
        return None

    # ---------------------------------------------------------------- stats/evict
    def entries(self) -> list[tuple[Path, float, int]]:
        items: list[tuple[Path, float, int]] = []
        for directory in (self.audio_dir, self.f0_dir):
            if not directory.is_dir():
                continue
            for path in directory.iterdir():
                if not path.is_file() or path.name.endswith(".tmp"):
                    continue
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                items.append((path, stat.st_mtime, stat.st_size))
        return items

    def stats(self) -> dict:
        audio_entries = f0_entries = total_bytes = 0
        for path, _mtime, size in self.entries():
            total_bytes += size
            if path.parent == self.audio_dir:
                audio_entries += 1
            else:
                f0_entries += 1
        return {"audio_entries": audio_entries, "f0_entries": f0_entries, "bytes": total_bytes}

    def evict(self) -> int:
        """LRU：超出条数/字节上限时按 mtime 从旧到新删除。返回删除的文件数。"""
        with self._lock:
            items = sorted(self.entries(), key=lambda item: item[1])
            total_bytes = sum(item[2] for item in items)
            count = len(items)
            removed = 0
            for path, _mtime, size in items:
                if count <= self.limits.max_entries and total_bytes <= self.limits.max_bytes:
                    break
                try:
                    path.unlink()
                except FileNotFoundError:
                    continue
                count -= 1
                total_bytes -= size
                removed += 1
            return removed

    def clear(self) -> None:
        with self._lock:
            for path, _mtime, _size in self.entries():
                path.unlink(missing_ok=True)


class SingleFlight:
    """同一 key 并发只执行一次（预热/跟读共用，避免重复调用云 TTS = 真花钱）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._inflight: dict[str, dict] = {}

    def run(self, key: str, fn):
        with self._lock:
            entry = self._inflight.get(key)
            leader = entry is None
            if leader:
                entry = {"event": threading.Event(), "value": None, "error": None}
                self._inflight[key] = entry
        if leader:
            try:
                entry["value"] = fn()
            except BaseException as exc:  # noqa: BLE001 - 原样传给跟随者
                entry["error"] = exc
            finally:
                with self._lock:
                    self._inflight.pop(key, None)
                entry["event"].set()
            if entry["error"] is not None:
                raise entry["error"]
            return entry["value"]
        entry["event"].wait(timeout=180)
        if entry["error"] is not None:
            raise entry["error"]
        return entry["value"]

    @property
    def inflight(self) -> int:
        with self._lock:
            return len(self._inflight)


SINGLE_FLIGHT = SingleFlight()


# --------------------------------------------------------------------------------------
# 进程级单例（跟随 Settings；settings 一变就自动重建，避免环境变量改了还用旧上限）
# --------------------------------------------------------------------------------------
_CACHE: WarmupCache | None = None
_CACHE_FINGERPRINT: tuple | None = None
_CACHE_LOCK = threading.Lock()


def get_cache() -> WarmupCache:
    global _CACHE, _CACHE_FINGERPRINT
    from .config import get_settings

    settings = get_settings()
    fingerprint = (
        str(settings.cache_dir),
        bool(settings.cache_enabled),
        int(settings.cache_max_bytes),
        int(settings.cache_max_entries),
    )
    with _CACHE_LOCK:
        if _CACHE is None or _CACHE_FINGERPRINT != fingerprint:
            _CACHE = WarmupCache(
                settings.cache_dir,
                max_bytes=settings.cache_max_bytes,
                max_entries=settings.cache_max_entries,
                enabled=settings.cache_enabled,
            )
            _CACHE_FINGERPRINT = fingerprint
        return _CACHE


def reset_cache() -> None:
    global _CACHE, _CACHE_FINGERPRINT
    with _CACHE_LOCK:
        _CACHE = None
        _CACHE_FINGERPRINT = None
