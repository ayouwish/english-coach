"""task-114：批量预热后台任务（生命周期/去重/缓存命中/取消/409/校验/失败隔离/进度 sidecar）。"""

from __future__ import annotations

import json
import time

import pytest

from app.cache import get_cache, reset_cache
from app.config import get_settings, reset_settings_cache
from app.providers.registry import reset_providers
from app.warmup_bulk import get_bulk_manager, reset_bulk_manager, sidecar_path

VOICES = ["en-US-JennyNeural", "en-US-AriaNeural"]


@pytest.fixture(autouse=True)
def _fresh_manager():
    reset_bulk_manager()
    path = sidecar_path(get_settings())
    path.unlink(missing_ok=True)
    yield
    manager = get_bulk_manager()
    status = manager.status()
    if status.get("state") == "running":
        manager.cancel()
        deadline = time.time() + 10
        while time.time() < deadline:
            if manager.status().get("state") != "running":
                break
            time.sleep(0.02)
    reset_bulk_manager()
    path.unlink(missing_ok=True)


def _post(client, **payload):
    return client.post("/v1/warmup/bulk", json=payload)


def _status(client) -> dict:
    return client.get("/v1/warmup/bulk/status").json()


def _wait_finished(client, timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = _status(client)
        if body["state"] in ("done", "failed", "cancelled"):
            return body
        time.sleep(0.02)
    raise AssertionError(f"warmup bulk 未在 {timeout}s 内结束: {_status(client)}")


# --------------------------------------------------------------------------------------
# 生命周期 / 计数自洽
# --------------------------------------------------------------------------------------
def test_lifecycle_counts_are_consistent(client):
    texts = ["Hello there.", "How are you today?"]
    response = _post(client, texts=texts, voices=VOICES[:1], rates=["normal", "slow"], concurrency=2)
    assert response.status_code == 200, response.text
    started = response.json()
    assert started["state"] == "running"
    assert started["total"] == 4
    assert started["job_id"]
    assert started["skipped_duplicates"] == 0

    final = _wait_finished(client)
    assert final["state"] == "done"
    assert final["total"] == final["done"] == 4
    assert final["generated"] == 4 and final["cached"] == 0 and final["failed"] == 0
    assert final["done"] == final["generated"] + final["cached"] + final["failed"]
    assert final["chars_generated"] == sum(len(text) for text in texts) * 2
    assert final["started_at"] and final["finished_at"]


def test_duplicate_texts_and_combinations_deduped(client):
    response = _post(
        client,
        texts=["Hi.", "Hi.", "Bye."],
        voices=VOICES,
        rates=["normal", "slow"],
        concurrency=1,
    )
    started = response.json()
    assert started["total"] == 8, "2 个唯一 text × 2 voice × 2 rate"
    assert started["skipped_duplicates"] == 4, "展开 12 - 唯一 8"
    final = _wait_finished(client)
    assert final["done"] == 8
    assert final["done"] == final["generated"] + final["cached"] + final["failed"]


def test_second_run_all_cached(client):
    payload = dict(texts=["Good morning."], voices=VOICES[:1], rates=["normal"], concurrency=1)
    assert _post(client, **payload).json()["total"] == 1
    assert _wait_finished(client)["generated"] == 1

    assert _post(client, **payload).json()["total"] == 1
    final = _wait_finished(client)
    assert final["state"] == "done"
    assert final["cached"] == 1 and final["generated"] == 0 and final["failed"] == 0
    assert final["chars_generated"] == 0, "缓存命中不计 TTS 字符（成本）"


# --------------------------------------------------------------------------------------
# 取消 / 409
# --------------------------------------------------------------------------------------
def test_cancel_is_cooperative_and_idempotent(client, monkeypatch):
    import app.warmup_bulk as bulk

    real_warm_one = bulk.warm_one
    calls = {"n": 0}

    def slow_warm_one(*args, **kwargs):
        calls["n"] += 1
        time.sleep(0.02)
        return real_warm_one(*args, **kwargs)

    monkeypatch.setattr(bulk, "warm_one", slow_warm_one)
    response = _post(client, texts=[f"Line {i}." for i in range(20)], voices=VOICES[:1], rates=["normal"], concurrency=1)
    job_id = response.json()["job_id"]
    cancel = client.post("/v1/warmup/bulk/cancel")
    assert cancel.status_code == 200
    assert cancel.json() == {"job_id": job_id, "state": "cancelled"}
    # 幂等
    again = client.post("/v1/warmup/bulk/cancel")
    assert again.status_code == 200 and again.json()["state"] == "cancelled"

    deadline = time.time() + 10
    while time.time() < deadline:
        body = _status(client)
        if body["state"] == "cancelled" and calls["n"] >= 1:
            break
        time.sleep(0.02)
    assert body["state"] == "cancelled"
    assert body["done"] < body["total"], "取消后不应全部完成"


def test_409_when_already_running(client, monkeypatch):
    import app.warmup_bulk as bulk

    real_warm_one = bulk.warm_one
    monkeypatch.setattr(bulk, "warm_one", lambda *a, **k: (time.sleep(0.02), real_warm_one(*a, **k))[1])
    first = _post(client, texts=["One.", "Two.", "Three."], voices=VOICES[:1], rates=["normal"], concurrency=1)
    assert first.status_code == 200
    second = _post(client, texts=["Other."], voices=VOICES[:1], rates=["normal"])
    assert second.status_code == 409
    body = second.json()
    assert body["error"]["code"] == "warmup_running"
    assert body["error"]["detail"]["job_id"] == first.json()["job_id"]
    client.post("/v1/warmup/bulk/cancel")


# --------------------------------------------------------------------------------------
# 参数校验
# --------------------------------------------------------------------------------------
@pytest.mark.parametrize("payload,expected", [
    (dict(texts=[], voices=VOICES[:1]), "texts must contain"),
    (dict(texts=["x" * 2001], voices=VOICES[:1]), "too long"),
    (dict(texts=["Hi."], voices=["bad voice!"]), "invalid voice"),
    (dict(texts=["Hi."], voices=VOICES[:1], rates=["fast"]), "rates must"),
    (dict(texts=["Hi."], voices=VOICES[:1], concurrency=0), "concurrency must"),
    (dict(texts=["Hi."], voices=VOICES[:1], concurrency=9), "concurrency must"),
    (dict(texts=["Hi."], voices=[f"en-US-Voice{i}Neural" for i in range(13)]), "voices must contain"),
])
def test_validation_400(client, payload, expected):
    response = _post(client, **payload)
    assert response.status_code == 400, response.text
    assert expected in response.json()["error"]["message"]


def test_max_items_limit_400(client, monkeypatch):
    monkeypatch.setenv("WARMUP_BULK_MAX_ITEMS", "5")
    reset_settings_cache()
    try:
        response = _post(client, texts=["a.", "b.", "c."], voices=VOICES, rates=["normal"])
        assert response.status_code == 400
        assert "WARMUP_BULK_MAX_ITEMS" in response.json()["error"]["message"]
    finally:
        reset_settings_cache()


# --------------------------------------------------------------------------------------
# 失败隔离 / sidecar / 空闲状态
# --------------------------------------------------------------------------------------
def test_single_failure_does_not_stop_job(client, monkeypatch):
    import app.warmup_bulk as bulk

    real_warm_one = bulk.warm_one
    calls = {"failed": 0}

    def flaky_warm_one(text, voice, rate, **kwargs):
        if text == "boom.":
            calls["failed"] += 1
            raise RuntimeError("synthetic tts failure")
        return real_warm_one(text, voice, rate, **kwargs)

    monkeypatch.setattr(bulk, "warm_one", flaky_warm_one)
    _post(client, texts=["ok one.", "boom.", "ok two."], voices=VOICES[:1], rates=["normal"], concurrency=1)
    final = _wait_finished(client)
    assert final["state"] == "done"
    assert final["failed"] == 1 and calls["failed"] == 1
    assert final["generated"] == 2
    assert final["done"] == final["generated"] + final["cached"] + final["failed"] == 3
    assert "synthetic tts failure" in (final.get("last_error") or "")


def test_sidecar_written_and_restart_running_becomes_failed(client, monkeypatch):
    monkeypatch.setenv("WARMUP_BULK_PROGRESS_EVERY", "1")
    reset_settings_cache()
    try:
        _post(client, texts=["Sidecar one.", "Sidecar two."], voices=VOICES[:1], rates=["normal"], concurrency=1)
        final = _wait_finished(client)
        path = sidecar_path(get_settings())
        assert path.is_file()
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["job_id"] == final["job_id"]
        assert payload["state"] == "done"
        assert payload["done"] == 2
        assert payload["total"] == 2
    finally:
        reset_settings_cache()

    # 模拟进程重启：sidecar 停在 running，新 manager 无活动任务 → 视为 failed
    path = sidecar_path(get_settings())
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload.update({"state": "running", "done": 1, "finished_at": None})
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    reset_bulk_manager()
    status = _status(client)
    assert status["state"] == "failed"
    assert "interrupted" in (status.get("error") or "")


def test_idle_when_no_job(client):
    assert _status(client)["state"] == "idle"


def test_capacity_warning_when_total_exceeds_cache_entries(client, monkeypatch):
    monkeypatch.setenv("CACHE_MAX_ENTRIES", "1")
    reset_settings_cache()
    reset_providers()
    reset_cache()
    try:
        response = _post(client, texts=["a.", "b."], voices=VOICES[:1], rates=["normal"], concurrency=1)
        assert response.status_code == 200
        assert "cache_capacity_entries" in response.json()["warnings"]
        _wait_finished(client)
    finally:
        reset_settings_cache()
        reset_providers()
        reset_cache()
