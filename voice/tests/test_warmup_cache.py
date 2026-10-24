"""契约 v1.1 §12：参考音/参考 F0 缓存 + `/v1/warmup`。

重点验证 lead 指定的三条**容易做错**的点：
1. `requested = generated + cached + failed + skipped_duplicates` 自洽，且第二次全部 cached（幂等）；
2. 坏缓存（坏 JSON / 点数异常）一律视为未命中并重新生成，绝不给出错误分数；
3. 同一 key 并发只生成一次（不重复调云 TTS）。
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import pytest

from app.cache import (
    STATE_DISABLED,
    STATE_HIT,
    STATE_MISS,
    cache_key,
    get_cache,
    validate_f0_points,
)
from app.config import reset_settings_cache
from app.providers.base import Capabilities, TTSResult
from app.providers.mock import MockPA
from app.providers.registry import ProviderSet, build_providers, reset_providers
from app.synth import synthesize_speech_wav
from app.warmup import run_warmup, warm_one
from tests.conftest import post_pronounce

TEXT = "I think the weather is really nice today."
TEXT2 = "Can I have a glass of water please"
TEXT3 = "My name is Lily and I am seven years old"
VOICE = "en-US-JennyNeural"
RATE = "normal"

WARMUP_KEYS = {"requested", "generated", "cached", "failed", "skipped_duplicates", "elapsed_ms", "cache"}


def _self_consistent(body: dict) -> bool:
    return body["requested"] == (
        body["generated"] + body["cached"] + len(body["failed"]) + body["skipped_duplicates"]
    )


def _item(text: str = TEXT, voice: str | None = VOICE, rate: str = RATE) -> dict:
    return {"text": text, "voice": voice, "rate": rate}


class CountingTTS:
    """可计数/可延迟的 TTS（用来证明命缓存时**不再调用** TTS）。"""

    name = "mock"
    capabilities = Capabilities()

    def __init__(self, delay: float = 0.0, fail_texts: tuple[str, ...] = ()):
        self.delay = delay
        self.fail_texts = fail_texts
        self.calls = 0
        self.lock = threading.Lock()

    def synthesize(self, text: str, voice=None, rate="normal", fmt="mp3", ssml=None) -> TTSResult:
        with self.lock:
            self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        for needle in self.fail_texts:
            if needle in text:
                raise RuntimeError(f"boom for {needle}")
        payload = synthesize_speech_wav(text, voice=voice, rate=rate)
        return TTSResult(audio=payload, content_type="audio/wav", provider=self.name, duration_ms=0, format="wav")


def _patch_tts(monkeypatch, provider) -> CountingTTS:
    base = build_providers()
    provider_set = ProviderSet(
        asr=base.asr,
        pa=base.pa or MockPA(),
        tts=provider,
        asr_chain=base.asr_chain,
        pa_chain=base.pa_chain,
        tts_chain=[provider],
        mode=base.mode,
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    monkeypatch.setattr("app.warmup.get_providers", lambda: provider_set)
    provider.provider_set = provider_set  # 方便直接调用 warm_one 的用例复用同一套 provider
    return provider


# --------------------------------------------------------------------------------------
# 1. /v1/warmup 契约与幂等
# --------------------------------------------------------------------------------------
def test_warmup_shape_and_self_consistency(client):
    response = client.post("/v1/warmup", json={"items": [_item(TEXT), _item(TEXT2)]})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == WARMUP_KEYS
    assert body["requested"] == 2
    assert body["generated"] == 2 and body["cached"] == 0
    assert body["failed"] == [] and body["skipped_duplicates"] == 0
    assert isinstance(body["elapsed_ms"], int) and body["elapsed_ms"] >= 0
    assert set(body["cache"]) == {"audio_entries", "f0_entries", "bytes"}
    assert body["cache"]["audio_entries"] == 2 and body["cache"]["f0_entries"] == 2
    assert body["cache"]["bytes"] > 0
    assert _self_consistent(body)


def test_warmup_is_idempotent_second_call_all_cached(client):
    first = client.post("/v1/warmup", json={"items": [_item(TEXT), _item(TEXT2), _item(TEXT3)]}).json()
    assert first["generated"] == 3 and first["cached"] == 0
    assert _self_consistent(first)

    second = client.post("/v1/warmup", json={"items": [_item(TEXT), _item(TEXT2), _item(TEXT3)]}).json()
    assert second["generated"] == 0, second
    assert second["cached"] == 3, second
    assert second["failed"] == []
    assert _self_consistent(second)
    assert second["cache"]["audio_entries"] == first["cache"]["audio_entries"]


def test_warmup_skips_duplicates(client):
    items = [_item(TEXT), _item(TEXT), _item(TEXT2), _item(TEXT2, rate="slow"), _item(TEXT)]
    body = client.post("/v1/warmup", json={"items": items}).json()
    assert body["requested"] == 5
    assert body["skipped_duplicates"] == 2  # 两条重复的 (text,voice,rate)
    assert body["generated"] == 3
    assert _self_consistent(body)


def test_warmup_second_call_skips_duplicates_and_hits_cache(client):
    items = [_item(TEXT), _item(TEXT)]
    client.post("/v1/warmup", json={"items": items})
    body = client.post("/v1/warmup", json={"items": items}).json()
    assert body["requested"] == 2 and body["skipped_duplicates"] == 1 and body["cached"] == 1 and body["generated"] == 0
    assert _self_consistent(body)


def test_warmup_rejects_bad_requests(client):
    assert client.post("/v1/warmup", json={"items": []}).status_code == 400
    assert client.post("/v1/warmup", json={"items": [_item("")]}).status_code == 400
    assert client.post("/v1/warmup", json={"items": [_item("a" * 2001)]}).status_code == 400
    assert client.post("/v1/warmup", json={"items": [_item(TEXT, rate="fastest")]}).status_code == 400
    assert client.post("/v1/warmup", json={"items": [_item(TEXT)], "concurrency": 9}).status_code == 400
    assert client.post("/v1/warmup", json={"items": [_item(TEXT)], "concurrency": 0}).status_code == 400
    for payload in (
        {"items": []},
        {"items": [_item("")]},
        {"items": [_item(TEXT, rate="fastest")]},
    ):
        assert client.post("/v1/warmup", json=payload).json()["error"]["code"] == "bad_request"


def test_warmup_too_many_items_returns_413(client):
    items = [_item(f"{TEXT} #{idx}") for idx in range(501)]
    response = client.post("/v1/warmup", json={"items": items})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_warmup_single_item_failure_is_isolated(client, monkeypatch):
    """单条硬失败（provider 链 + 兜底都救不了）只进 failed 数组，HTTP 仍 200。"""
    from app import warmup as warmup_module
    from app.errors import ProviderError

    original = warmup_module._produce_locked

    def flaky(cache, key, text, voice, rate, providers):
        if "water" in text:
            raise ProviderError("synthetic hard failure", provider="mock")
        return original(cache, key, text, voice, rate, providers)

    monkeypatch.setattr(warmup_module, "_produce_locked", flaky)
    body = client.post("/v1/warmup", json={"items": [_item(TEXT), _item(TEXT2), _item(TEXT3)]}).json()
    assert set(body) == WARMUP_KEYS
    assert body["requested"] == 3
    assert len(body["failed"]) == 1
    failed = body["failed"][0]
    assert set(failed) == {"text", "voice", "rate", "error"}
    assert failed["text"] == TEXT2
    assert failed["error"] == "provider_error"
    assert body["generated"] == 2, body
    assert _self_consistent(body)


def test_warmup_tts_failure_degrades_but_is_not_cached(client, monkeypatch):
    """TTS 挂掉 -> 用本地兜底音（不失败），但**兜底音不进缓存**，下次仍会重试云 TTS。"""
    _patch_tts(monkeypatch, CountingTTS(fail_texts=("water",)))
    first = client.post("/v1/warmup", json={"items": [_item(TEXT), _item(TEXT2)]}).json()
    assert first["failed"] == [], "有兜底实现时不应算失败"
    assert first["generated"] == 2
    key = cache_key(TEXT2, VOICE, RATE, "mock", "wav")
    assert get_cache().get_audio(key) is None, "兜底音不能污染缓存"

    second = client.post("/v1/warmup", json={"items": [_item(TEXT), _item(TEXT2)]}).json()
    assert second["cached"] == 1, "正常生成的那条应命中"
    assert second["generated"] == 1, "兜底那条必须重新尝试"
    assert _self_consistent(second)


def test_warmup_voice_null_shares_key_with_pronounce(client, sweep):
    body = client.post("/v1/warmup", json={"items": [_item(TEXT, voice=None)]}).json()
    assert body["generated"] == 1
    # 默认音色必须与 /v1/pronounce 的 (text, voice, rate) 完全一致 -> 直接命中
    result = post_pronounce(client, sweep, TEXT).json()
    assert result["provider_meta"]["cache"] == {"reference_audio": "hit", "reference_f0": "hit"}


# --------------------------------------------------------------------------------------
# 2. /v1/pronounce 的 provider_meta.cache 与命中/未命中
# --------------------------------------------------------------------------------------
def test_pronounce_cache_miss_then_hit_identical_result(client, sweep):
    first = post_pronounce(client, sweep, TEXT).json()
    assert first["provider_meta"]["cache"] == {"reference_audio": "miss", "reference_f0": "miss"}
    second = post_pronounce(client, sweep, TEXT).json()
    assert second["provider_meta"]["cache"] == {"reference_audio": "hit", "reference_f0": "hit"}
    # 命中缓存不能改变结果
    assert second["intonation"]["dtw_distance"] == first["intonation"]["dtw_distance"]
    assert second["intonation"]["worst_regions"] == first["intonation"]["worst_regions"]
    assert second["scores"] == first["scores"]
    assert second["intonation"]["reference_audio_url"] == first["intonation"]["reference_audio_url"]
    assert second["intonation"]["user_f0"] == first["intonation"]["user_f0"]


def test_pronounce_cache_does_not_call_tts_or_praat_again(client, monkeypatch, sweep):
    provider = _patch_tts(monkeypatch, CountingTTS())
    post_pronounce(client, sweep, TEXT)
    assert provider.calls == 1
    post_pronounce(client, sweep, TEXT)
    post_pronounce(client, sweep, TEXT)
    assert provider.calls == 1, "命缓存后不得再调用 TTS（云 TTS 是真花钱）"


def test_pronounce_cached_call_is_faster(client, monkeypatch, sweep):
    """TTS 慢时（模拟云调用 ~0.6s）缓存应把第二次请求的耗时压下来。"""
    provider = _patch_tts(monkeypatch, CountingTTS(delay=0.6))
    started = time.perf_counter()
    first = post_pronounce(client, sweep, TEXT).json()
    first_ms = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    second = post_pronounce(client, sweep, TEXT).json()
    second_ms = (time.perf_counter() - started) * 1000

    assert first["provider_meta"]["cache"] == {"reference_audio": "miss", "reference_f0": "miss"}
    assert second["provider_meta"]["cache"] == {"reference_audio": "hit", "reference_f0": "hit"}
    assert provider.calls == 1
    assert first_ms > 600
    assert second_ms < first_ms / 2, f"first={first_ms:.1f}ms second={second_ms:.1f}ms"
    assert second["scores"] == first["scores"]


def test_pronounce_reference_audio_served_from_cache_dir(client, sweep):
    body = post_pronounce(client, sweep, TEXT).json()
    key = cache_key(TEXT, VOICE, RATE, "mock", "wav")
    cached_file = get_cache().audio_dir / f"{key}.wav"
    assert cached_file.is_file(), sorted(p.name for p in get_cache().audio_dir.iterdir())
    assert get_cache().f0_dir.joinpath(f"{key}.json").is_file()
    url = body["intonation"]["reference_audio_url"]
    assert url == f"/voice/v1/audio/ref_{key[:12]}.wav"
    audio = client.get(url.replace("/voice", "", 1))
    assert audio.status_code == 200
    assert audio.headers["cache-control"] == "public, max-age=604800"
    assert audio.content == cached_file.read_bytes()


def test_pronounce_cache_disabled_reports_disabled(client, monkeypatch, sweep):
    monkeypatch.setenv("CACHE_ENABLED", "false")
    reset_settings_cache()
    reset_providers()
    body = post_pronounce(client, sweep, TEXT).json()
    assert body["provider_meta"]["cache"] == {"reference_audio": STATE_DISABLED, "reference_f0": STATE_DISABLED}
    assert body["intonation"]["reference_audio_url"]
    audio = client.get(body["intonation"]["reference_audio_url"].replace("/voice", "", 1))
    assert audio.status_code == 200  # 关闭缓存也能正常发声
    assert get_cache().stats()["audio_entries"] == 0, "关闭缓存时不应写缓存目录"


def test_without_intonation_cache_states_are_disabled(client, sweep):
    body = post_pronounce(client, sweep, TEXT, with_intonation="false").json()
    assert body["provider_meta"]["cache"] == {"reference_audio": STATE_DISABLED, "reference_f0": STATE_DISABLED}


# --------------------------------------------------------------------------------------
# 3. 坏缓存绝不给出错误分数
# --------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "poison",
    [
        "{not json at all",
        "[]",
        '{"v":1,"points":[[0,100.0]]}',  # 点数太少
        '{"v":1,"points":[[0,null],[20,null]]}',  # 全是清音
        '{"v":1,"points":[[20,100.0],[0,120.0]]}',  # 时间轴倒序
        '{"v":1,"points":[[0,"x"],[20,120.0]]}',  # 值类型错误
        json.dumps({"v": 1, "points": [[idx * 20, 200.0] for idx in range(700)]}),  # 点数超上限
    ],
)
def test_corrupt_f0_cache_is_miss_and_result_is_correct(client, sweep, poison):
    baseline = post_pronounce(client, sweep, TEXT).json()
    key = cache_key(TEXT, VOICE, RATE, "mock", "wav")
    f0_file = get_cache().f0_dir / f"{key}.json"
    assert f0_file.is_file()

    f0_file.write_text(poison, encoding="utf-8")
    assert get_cache().get_f0(key) is None, "坏缓存必须被校验拦下"

    recovered = post_pronounce(client, sweep, TEXT).json()
    assert recovered["provider_meta"]["cache"]["reference_f0"] == STATE_MISS, "坏缓存必须视为未命中"
    # 重新生成的结果必须与基线一致 -> 坏缓存没有污染分数
    assert recovered["intonation"]["dtw_distance"] == baseline["intonation"]["dtw_distance"]
    assert recovered["intonation"]["user_f0"] == baseline["intonation"]["user_f0"]
    assert recovered["scores"] == baseline["scores"]
    # 而且已经被修好（下一次是 hit）
    assert get_cache().get_f0(key) is not None
    assert post_pronounce(client, sweep, TEXT).json()["provider_meta"]["cache"]["reference_f0"] == STATE_HIT


def test_validate_f0_points_rules():
    ok = [[0, 180.0], [20, None], [40, 182.0]]
    assert validate_f0_points(ok) is not None
    assert validate_f0_points({"points": ok}) is not None
    assert validate_f0_points([[0, 180.0]]) is None
    assert validate_f0_points([[0, None], [20, None]]) is None
    assert validate_f0_points([[20, 180.0], [20, 180.0]]) is None
    assert validate_f0_points([[0, 180.0], [20, 0]]) is None
    assert validate_f0_points([[0, 180.0], [20, float("inf")]]) is None
    assert validate_f0_points("nope") is None


def test_missing_audio_file_rebuilds_audio_and_keeps_f0(client, monkeypatch, sweep):
    provider = _patch_tts(monkeypatch, CountingTTS())
    post_pronounce(client, sweep, TEXT)
    assert provider.calls == 1

    key = cache_key(TEXT, VOICE, RATE, "mock", "wav")
    (get_cache().audio_dir / f"{key}.wav").unlink()
    body = post_pronounce(client, sweep, TEXT).json()
    assert body["provider_meta"]["cache"] == {"reference_audio": STATE_MISS, "reference_f0": STATE_HIT}
    assert provider.calls == 2, "音频被删掉后应重新合成"
    assert client.get(body["intonation"]["reference_audio_url"].replace("/voice", "", 1)).status_code == 200


def test_missing_f0_file_only_rebuilds_f0_without_tts(client, monkeypatch, sweep):
    provider = _patch_tts(monkeypatch, CountingTTS())
    baseline = post_pronounce(client, sweep, TEXT).json()
    assert provider.calls == 1

    key = cache_key(TEXT, VOICE, RATE, "mock", "wav")
    (get_cache().f0_dir / f"{key}.json").unlink()
    body = post_pronounce(client, sweep, TEXT).json()
    assert body["provider_meta"]["cache"] == {"reference_audio": STATE_HIT, "reference_f0": STATE_MISS}
    assert provider.calls == 1, "只缺 F0 时绝不能重新调用 TTS"
    assert body["intonation"]["dtw_distance"] == baseline["intonation"]["dtw_distance"]


# --------------------------------------------------------------------------------------
# 4. LRU 淘汰
# --------------------------------------------------------------------------------------
def test_lru_eviction_and_regeneration(client, monkeypatch):
    monkeypatch.setenv("CACHE_MAX_ENTRIES", "2")
    reset_settings_cache()
    reset_providers()

    items = [_item(TEXT), _item(TEXT2), _item(TEXT3)]
    first = client.post("/v1/warmup", json={"items": items, "concurrency": 1}).json()
    assert first["generated"] == 3
    stats = get_cache().stats()
    assert stats["audio_entries"] + stats["f0_entries"] <= 2, stats

    # 最近写入的那条仍在缓存里
    survives = client.post("/v1/warmup", json={"items": [_item(TEXT3)], "concurrency": 1}).json()
    assert survives["cached"] == 1 and survives["generated"] == 0, survives

    # 被淘汰的条目必须重新生成（而不是报错或给假数据）
    evicted = client.post("/v1/warmup", json={"items": [_item(TEXT), _item(TEXT2)], "concurrency": 1}).json()
    assert evicted["generated"] == 2, evicted
    assert _self_consistent(evicted)


def test_lru_bytes_limit(client, monkeypatch):
    monkeypatch.setenv("CACHE_MAX_BYTES", "1")  # 1 字节：写一个就超
    reset_settings_cache()
    reset_providers()
    body = client.post("/v1/warmup", json={"items": [_item(TEXT)]}).json()
    assert body["generated"] == 1
    assert get_cache().stats()["bytes"] <= 1


# --------------------------------------------------------------------------------------
# 5. 并发：同一 key 只生成一次
# --------------------------------------------------------------------------------------
def test_single_flight_generates_once_under_concurrency(monkeypatch):
    provider = _patch_tts(monkeypatch, CountingTTS(delay=0.25))
    cache = get_cache()
    errors: list[BaseException] = []
    barrier = threading.Barrier(8)

    def worker() -> None:
        try:
            barrier.wait(timeout=5)
            warm_one(TEXT, VOICE, RATE, cache=cache, providers=provider.provider_set)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not errors, errors
    assert provider.calls == 1, f"并发同一 key 只允许生成一次，实际 {provider.calls} 次"
    assert cache.stats()["audio_entries"] == 1


def test_run_warmup_dedupes_before_concurrency():
    cache = get_cache()
    cache.clear()
    from app.warmup import WarmupItemSpec

    specs = [WarmupItemSpec(TEXT, VOICE, RATE)] * 5
    body = run_warmup(specs, 4, cache=cache)
    assert body["requested"] == 5 and body["skipped_duplicates"] == 4 and body["generated"] == 1
    assert _self_consistent(body)


# --------------------------------------------------------------------------------------
# 6. CLI
# --------------------------------------------------------------------------------------
def test_warmup_cli_in_process(tmp_path):
    import subprocess

    corpus = tmp_path / "corpus.txt"
    corpus.write_text(f"# 注释行会被忽略\n{TEXT}\n{TEXT2}\n", encoding="utf-8")
    root = Path(__file__).resolve().parent.parent
    result = subprocess.run(
        [sys.executable, "scripts/warmup.py", "--text-file", str(corpus), "--concurrency", "2", "--json"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert result.returncode == 0, result.stderr
    assert "requested          : 2" in result.stdout
    assert "generated          : 2" in result.stdout
    assert "cache              : audio_entries=2" in result.stdout
    payload = json.loads(result.stdout[result.stdout.index("{") :])
    assert payload["requested"] == payload["generated"] + payload["cached"] + len(payload["failed"]) + payload["skipped_duplicates"]

    # 第二次跑：全部命中
    again = subprocess.run(
        [sys.executable, "scripts/warmup.py", "--text-file", str(corpus)],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert again.returncode == 0, again.stderr
    assert "generated          : 0" in again.stdout
    assert "cached             : 2" in again.stdout
