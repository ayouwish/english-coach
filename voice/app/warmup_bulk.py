"""批量预热所有音色（task-114）：后台任务 + 进度 + 取消 + 去重 + 缓存命中统计。

用途：管理台一键把语料 600 句 × 9 音色 × 2 语速（约 10,800 条）预热进缓存；
跟读换音色时直接命中缓存，不再现场合成。

- 同一时刻**只允许一个** bulk 任务（运行中再 POST → 409 `warmup_running`）
- 生成复用 `warmup.warm_one`（内部走缓存；命中计 cached，不调 TTS）
- `chars_generated` 只累计**实际调用 TTS** 的字符数（缓存命中不计，供成本估算）
- 进度：线程内原子计数 + 每 `WARMUP_BULK_PROGRESS_EVERY` 条写 sidecar
  `DATA_DIR/cache/warmup-bulk.json`（进程重启后可读最后状态；running 且无心跳 → failed）
- 取消：协作式；worker 在条目间检查标志；幂等
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .cache import WarmupCache, cache_key, get_cache
from .config import Settings, get_settings
from .errors import BadRequest, WarmupRunning
from .providers.registry import ProviderSet, get_providers
from .voice_names import is_valid_voice_name
from .warmup import REFERENCE_AUDIO_FORMAT, WarmupItemSpec, tts_provider_name, warm_one

logger = logging.getLogger("voice.warmup_bulk")

BULK_STATES = ("idle", "running", "done", "failed", "cancelled")
MAX_TEXTS = 1000
MAX_TEXT_CHARS = 2000
MAX_VOICES = 12
ALLOWED_RATES = ("normal", "slow")
MAX_CONCURRENCY = 8


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sidecar_path(settings: Settings | None = None) -> Path:
    settings = settings or get_settings()
    return Path(settings.data_dir) / "cache" / "warmup-bulk.json"


def _write_sidecar(settings: Settings, payload: dict) -> None:
    path = sidecar_path(settings)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + f".{time.time_ns()}.tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temp.replace(path)
    except Exception as exc:  # 进度落盘失败不影响预热本身
        logger.warning("warmup-bulk sidecar write failed: %s", exc)


def _read_sidecar(settings: Settings | None = None) -> dict | None:
    path = sidecar_path(settings)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


class _Job:
    def __init__(self, job_id: str, total: int, skipped_duplicates: int, concurrency: int):
        self.job_id = job_id
        self.total = total
        self.skipped_duplicates = skipped_duplicates
        self.concurrency = concurrency
        self.state = "running"
        self.done = 0
        self.generated = 0
        self.cached = 0
        self.failed = 0
        self.chars_generated = 0
        self.started_at = _now_iso()
        self.finished_at: str | None = None
        self.error: str | None = None
        self.last_error: str | None = None
        self.cancel_requested = False
        self.updated_at = self.started_at
        self.lock = threading.RLock()

    def snapshot(self) -> dict:
        with self.lock:
            payload = {
                "job_id": self.job_id,
                "state": self.state,
                "total": self.total,
                "done": self.done,
                "generated": self.generated,
                "cached": self.cached,
                "failed": self.failed,
                "skipped_duplicates": self.skipped_duplicates,
                "chars_generated": self.chars_generated,
                "concurrency": self.concurrency,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "updated_at": self.updated_at,
            }
            if self.error:
                payload["error"] = self.error
            if self.last_error:
                payload["last_error"] = self.last_error
            return payload


class WarmupBulkManager:
    """进程内单例：管理唯一一个后台预热任务 + sidecar 恢复。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._job: _Job | None = None

    # ------------------------------------------------------------------ start
    def start(
        self,
        texts: list[str],
        voices: list[str],
        rates: list[str] | None = None,
        concurrency: int | None = None,
        *,
        settings: Settings | None = None,
        cache: WarmupCache | None = None,
        providers: ProviderSet | None = None,
    ) -> dict:
        settings = settings or get_settings()
        cache = cache or get_cache()
        providers = providers or get_providers()

        cleaned_texts, cleaned_voices, cleaned_rates, requested_concurrency = _validate(
            texts, voices, rates, concurrency, settings
        )
        # 展开并去重（text × voice × rate）
        tts_provider = tts_provider_name(providers)
        specs: list[WarmupItemSpec] = []
        seen: set[str] = set()
        skipped_duplicates = 0
        for text in cleaned_texts:
            for voice in cleaned_voices:
                for rate in cleaned_rates:
                    key = cache_key(text, voice, rate, tts_provider, REFERENCE_AUDIO_FORMAT)
                    if key in seen:
                        skipped_duplicates += 1
                        continue
                    seen.add(key)
                    specs.append(WarmupItemSpec(text=text, voice=voice, rate=rate))
        total = len(specs)
        if total > settings.warmup_bulk_max_items:
            raise BadRequest(
                f"too many unique items: {total} > WARMUP_BULK_MAX_ITEMS ({settings.warmup_bulk_max_items})"
            )

        with self._lock:
            if self._job is not None and self._job.state == "running":
                raise WarmupRunning(
                    "另一个批量预热任务正在运行中，请等待完成或取消",
                    detail={"job_id": self._job.job_id},
                )
            job = _Job(uuid.uuid4().hex, total, skipped_duplicates, int(requested_concurrency))
            self._job = job

        warnings: list[str] = []
        max_entries = int(getattr(getattr(cache, "limits", None), "max_entries", 0) or 0)
        if max_entries and total > max_entries:
            warnings.append("cache_capacity_entries")
            logger.warning(
                "warmup-bulk total %d exceeds cache max entries %d; 旧条目会被 LRU 淘汰（需调大 CACHE_MAX_ENTRIES）",
                total,
                max_entries,
            )
        _write_sidecar(settings, job.snapshot())

        thread = threading.Thread(
            target=self._run,
            args=(job, specs, int(requested_concurrency), settings, cache, providers),
            name="voice-warmup-bulk",
            daemon=True,
        )
        thread.start()
        return {
            "job_id": job.job_id,
            "total": job.total,
            "state": "running",
            "started_at": job.started_at,
            "skipped_duplicates": job.skipped_duplicates,
            "concurrency": job.concurrency,
            "warnings": warnings,
        }

    # ------------------------------------------------------------------ worker
    def _run(self, job: _Job, specs: list[WarmupItemSpec], concurrency: int, settings: Settings,
             cache: WarmupCache, providers: ProviderSet) -> None:
        progress_every = max(1, int(settings.warmup_bulk_progress_every))

        def _persist() -> None:
            with job.lock:
                payload = job.snapshot()
            _write_sidecar(settings, payload)

        def _work(spec: WarmupItemSpec) -> None:
            if job.cancel_requested:
                return
            outcome = "failed"
            error: str | None = None
            try:
                outcome = warm_one(spec.text, spec.voice, spec.rate, cache=cache, providers=providers)
            except BaseException as exc:  # noqa: BLE001 - 单条失败必须隔离
                logger.warning("warmup-bulk item failed: %s", exc)
                error = getattr(exc, "message", None) or f"{type(exc).__name__}: {exc}"
            with job.lock:
                if job.state == "cancelled":
                    return  # 取消后不再推进（已开始的那条不计入）
                job.done += 1
                if outcome == "generated":
                    job.generated += 1
                    job.chars_generated += len(spec.text)
                elif outcome == "cached":
                    job.cached += 1
                else:
                    job.failed += 1
                    if error:
                        job.last_error = error
                job.updated_at = _now_iso()
                should_persist = job.done % progress_every == 0
            if should_persist:
                _persist()

        try:
            workers = max(1, min(concurrency, MAX_CONCURRENCY, max(1, len(specs))))
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="voice-warmup-bulk") as pool:
                list(pool.map(_work, specs))
        except BaseException as exc:  # noqa: BLE001 - 任务级异常 → failed
            logger.exception("warmup-bulk job crashed")
            with job.lock:
                job.state = "failed"
                job.error = f"{type(exc).__name__}: {exc}"
                job.finished_at = _now_iso()
            _persist()
            return

        with job.lock:
            if job.state != "cancelled":
                job.state = "done"
            job.finished_at = _now_iso()
            job.updated_at = job.finished_at
        _persist()

    # ------------------------------------------------------------------ status / cancel
    def status(self) -> dict:
        with self._lock:
            job = self._job
        if job is not None:
            return job.snapshot()
        settings = get_settings()
        sidecar = _read_sidecar(settings)
        if sidecar:
            payload = dict(sidecar)
            if payload.get("state") == "running":
                # 进程重启后 sidecar 仍是 running 且没有活动任务 → 视为 failed（无心跳）
                payload["state"] = "failed"
                payload["error"] = "interrupted (进程重启，running 任务无心跳)"
                payload["finished_at"] = payload.get("finished_at") or _now_iso()
                _write_sidecar(settings, payload)
            return payload
        return {
            "job_id": None,
            "state": "idle",
            "total": 0,
            "done": 0,
            "generated": 0,
            "cached": 0,
            "failed": 0,
            "skipped_duplicates": 0,
            "chars_generated": 0,
            "started_at": None,
            "finished_at": None,
            "updated_at": None,
        }

    def cancel(self) -> dict:
        with self._lock:
            job = self._job
        if job is None:
            sidecar = _read_sidecar(get_settings())
            return {"job_id": sidecar.get("job_id") if sidecar else None, "state": sidecar.get("state", "idle") if sidecar else "idle"}
        with job.lock:
            if job.state == "running":
                job.cancel_requested = True
                job.state = "cancelled"
                job.finished_at = _now_iso()
                job.updated_at = job.finished_at
                payload = job.snapshot()
            else:
                payload = job.snapshot()  # 幂等：已结束的任务保持原状态
        _write_sidecar(get_settings(), payload)
        return {"job_id": payload["job_id"], "state": payload["state"]}


def _validate(
    texts: list[str] | None,
    voices: list[str] | None,
    rates: list[str] | None,
    concurrency: int | None,
    settings: Settings,
) -> tuple[list[str], list[str], list[str], int]:
    texts = [str(item or "") for item in (texts or [])]
    if not 1 <= len(texts) <= MAX_TEXTS:
        raise BadRequest(f"texts must contain 1..{MAX_TEXTS} entries, got {len(texts)}")
    cleaned_texts: list[str] = []
    for index, text in enumerate(texts, start=1):
        stripped = text.strip()
        if not stripped:
            raise BadRequest(f"texts[{index}] is empty")
        if len(stripped) > MAX_TEXT_CHARS:
            raise BadRequest(f"texts[{index}] too long: {len(stripped)} > {MAX_TEXT_CHARS} chars")
        cleaned_texts.append(stripped)

    voices = [str(item or "").strip() for item in (voices or [])]
    if not 1 <= len(voices) <= MAX_VOICES:
        raise BadRequest(f"voices must contain 1..{MAX_VOICES} entries, got {len(voices)}")
    for voice in voices:
        if not is_valid_voice_name(voice):
            raise BadRequest(f"invalid voice name: {voice!r}")

    rates = [str(item or "").strip().lower() for item in (rates if rates is not None else ["normal", "slow"])]
    if not 1 <= len(rates) <= 2 or any(rate not in ALLOWED_RATES for rate in rates):
        raise BadRequest(f"rates must be a non-empty subset of {list(ALLOWED_RATES)}, got {rates!r}")
    rates = list(dict.fromkeys(rates))

    if concurrency is None:
        concurrency = settings.warmup_bulk_concurrency
    try:
        concurrency_value = int(concurrency)
    except (TypeError, ValueError):
        raise BadRequest(f"concurrency must be an integer in 1..{MAX_CONCURRENCY}, got {concurrency!r}") from None
    if not 1 <= concurrency_value <= MAX_CONCURRENCY:
        raise BadRequest(f"concurrency must be in 1..{MAX_CONCURRENCY}, got {concurrency_value}")
    return cleaned_texts, voices, rates, concurrency_value


_MANAGER: WarmupBulkManager | None = None
_MANAGER_LOCK = threading.Lock()


def get_bulk_manager() -> WarmupBulkManager:
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is None:
            _MANAGER = WarmupBulkManager()
        return _MANAGER


def reset_bulk_manager() -> None:
    """测试用：清空单例（sidecar 仍保留，可在新实例里验证恢复逻辑）。"""
    global _MANAGER
    with _MANAGER_LOCK:
        _MANAGER = None
