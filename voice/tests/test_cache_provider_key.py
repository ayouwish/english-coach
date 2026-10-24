"""task-12 回归：缓存 key 必须包含 TTS provider 身份（契约 v1.2 §12.2）。

这些用例要能**复现原缺陷**：v1.1 的 key 只有 (text, voice, rate)，
而 azure/edge-tts/default 三个音色默认值相同，于是 mock 模式预热出的合成音 + 合成 F0
会被 azure 模式命中 —— 用户听到蜂鸣当"母语者示范"，真实语音还被拿去和合成扫频做 DTW。
"""

from __future__ import annotations

import hashlib
import json
import threading
import time

import pytest

from app.cache import (
    KEY_SEP,
    KEY_VERSION,
    cache_key,
    get_cache,
    legacy_v11_cache_key,
    validate_f0_points,
)
from app.audio_io import decode_audio
from app.config import get_settings
from app.intonation import extract_f0
from app.providers.base import Capabilities, TTSResult
from app.providers.registry import ProviderSet, build_providers
from app.store import AudioStore
from app.synth import sweep_wav, tone_wav
from app.warmup import tts_provider_name, warm_one
from tests.conftest import post_pronounce

TEXT = "I think the weather is really nice today."
VOICE = "en-US-JennyNeural"
RATE = "normal"

PROVIDER_A = "mock_a"   # 模拟 mock：上扬扫频
PROVIDER_B = "azure_b"  # 模拟 azure：定频（形状不同 -> 参考 F0/DTW 必须不同）


class NamedTTS:
    """名字与波形都可区分的假 TTS provider。"""

    capabilities = Capabilities()

    def __init__(self, name: str, kind: str = "sweep"):
        self.name = name
        self.kind = kind
        self.calls = 0
        self.lock = threading.Lock()

    def synthesize(self, text: str, voice=None, rate="normal", fmt="mp3", ssml=None) -> TTSResult:
        with self.lock:
            self.calls += 1
        audio = sweep_wav(150.0, 300.0, 1.5) if self.kind == "sweep" else tone_wav(200.0, 1.5)
        return TTSResult(audio=audio, content_type="audio/wav", provider=self.name, duration_ms=1500, format="wav")


class BrokenNamedTTS(NamedTTS):
    def synthesize(self, *args, **kwargs):
        with self.lock:
            self.calls += 1
        raise RuntimeError(f"{self.name} is down")


def _provider_set(tts) -> ProviderSet:
    base = build_providers()
    return ProviderSet(
        asr=base.asr,
        pa=base.pa,
        tts=tts,
        asr_chain=base.asr_chain,
        pa_chain=base.pa_chain,
        tts_chain=[tts],
        mode=base.mode,
    )


def _patch(monkeypatch, tts):
    provider_set = _provider_set(tts)
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    monkeypatch.setattr("app.warmup.get_providers", lambda: provider_set)
    return provider_set


# --------------------------------------------------------------------------------------
# 1. key 公式：provider 身份 + 版本前缀
# --------------------------------------------------------------------------------------
def test_key_differs_per_provider_and_matches_contract_formula():
    """契约 v1.3 §12.2：
    sha1("v3" + SEP + tts_provider + SEP + fmt + SEP + text + SEP + voice + SEP + rate)
    """
    settings = get_settings()
    voice = settings.default_tts_voice  # 三个 provider 的默认音色本来就是同一个字符串
    keys = {name: cache_key("Hello.", voice, "normal", name, "wav") for name in ("mock", "local", "azure")}
    assert len(set(keys.values())) == 3, keys  # 历史缺陷：这三个值曾经完全相同

    expected = hashlib.sha1(
        (
            KEY_VERSION + KEY_SEP + "azure" + KEY_SEP + "wav" + KEY_SEP + "Hello."
            + KEY_SEP + voice + KEY_SEP + "normal"
        ).encode("utf-8")
    ).hexdigest()
    assert keys["azure"] == expected
    assert KEY_VERSION == "v3", "v3 之后 fmt 参与 key；旧版本缓存必须整体失效"


def test_key_differs_per_format():
    """mp3 与 wav 是不同产物（容器/编码/码率都不同）→ key 必须不同。"""
    mp3 = cache_key(TEXT, VOICE, RATE, "azure", "mp3")
    wav = cache_key(TEXT, VOICE, RATE, "azure", "wav")
    assert mp3 != wav
    assert mp3 == cache_key(TEXT, VOICE, RATE, "azure", "mp3")  # 稳定
    assert mp3 != cache_key(TEXT, VOICE, RATE, "mock", "mp3")


def test_key_is_stable_and_provider_name_is_optional_safe():
    assert cache_key(TEXT, VOICE, RATE, "mock", "wav") == cache_key(TEXT, VOICE, RATE, "mock", "wav")
    assert cache_key(TEXT, VOICE, RATE, "mock", "wav") != cache_key(TEXT, VOICE, RATE, None, "wav")
    assert cache_key(TEXT, VOICE, RATE, "mock", "wav") != cache_key(TEXT, VOICE, RATE, "Mock", "wav")  # 大小写不同即不同 key


def test_tts_provider_name_matches_health_semantics(monkeypatch):
    for name in ("mock", "azure", "local"):
        provider_set = _provider_set(NamedTTS(name))
        assert tts_provider_name(provider_set) == name


# --------------------------------------------------------------------------------------
# 2. 切换 provider 必须 MISS（端到端）
# --------------------------------------------------------------------------------------
def test_pronounce_provider_switch_turns_hit_into_miss(client, monkeypatch, sweep):
    provider_a = NamedTTS(PROVIDER_A, kind="sweep")
    _patch(monkeypatch, provider_a)

    first = post_pronounce(client, sweep, TEXT).json()
    assert first["provider_meta"]["cache"] == {"reference_audio": "miss", "reference_f0": "miss"}
    second = post_pronounce(client, sweep, TEXT).json()
    assert second["provider_meta"]["cache"] == {"reference_audio": "hit", "reference_f0": "hit"}
    url_a = second["intonation"]["reference_audio_url"]
    ref_f0_a = second["intonation"]["reference_f0"]

    # 切到 provider B：**必须 MISS**，不能命中 A 的音频与 F0
    provider_b = NamedTTS(PROVIDER_B, kind="tone")
    _patch(monkeypatch, provider_b)
    switched = post_pronounce(client, sweep, TEXT).json()
    assert switched["provider_meta"]["cache"] == {"reference_audio": "miss", "reference_f0": "miss"}, switched[
        "provider_meta"
    ]
    url_b = switched["intonation"]["reference_audio_url"]
    assert url_b != url_a, "不同 provider 的 reference_audio_url 不能相同"
    assert switched["intonation"]["reference_f0"] != ref_f0_a, "语调参考曲线不能复用另一个 provider 的"
    assert switched["intonation"]["dtw_distance"] != second["intonation"]["dtw_distance"]

    # B 再打一次 -> hit（B 自己的缓存）
    again = post_pronounce(client, sweep, TEXT).json()
    assert again["provider_meta"]["cache"] == {"reference_audio": "hit", "reference_f0": "hit"}
    assert again["intonation"]["reference_f0"] == switched["intonation"]["reference_f0"]

    # A 的缓存仍在，切回 A 依然命中（两个 provider 各有一份）
    _patch(monkeypatch, NamedTTS(PROVIDER_A, kind="sweep"))
    back = post_pronounce(client, sweep, TEXT).json()
    assert back["provider_meta"]["cache"] == {"reference_audio": "hit", "reference_f0": "hit"}
    assert back["intonation"]["reference_f0"] == ref_f0_a


def test_warmup_provider_switch_is_miss(client, monkeypatch):
    _patch(monkeypatch, NamedTTS(PROVIDER_A, kind="sweep"))
    body_a = client.post("/v1/warmup", json={"items": [{"text": TEXT, "voice": None, "rate": RATE}]}).json()
    assert body_a["generated"] == 1 and body_a["cached"] == 0
    again_a = client.post("/v1/warmup", json={"items": [{"text": TEXT, "voice": None, "rate": RATE}]}).json()
    assert again_a["cached"] == 1 and again_a["generated"] == 0

    _patch(monkeypatch, NamedTTS(PROVIDER_B, kind="tone"))
    body_b = client.post("/v1/warmup", json={"items": [{"text": TEXT, "voice": None, "rate": RATE}]}).json()
    assert body_b["generated"] == 1, f"切换 provider 后必须重新生成（原缺陷会命中 A 的缓存）: {body_b}"
    assert body_b["cached"] == 0
    assert body_b["requested"] == body_b["generated"] + body_b["cached"] + len(body_b["failed"]) + body_b["skipped_duplicates"]

    # 两个 provider 的缓存并存
    cache = get_cache()
    assert cache.get_audio(cache_key(TEXT, get_settings().default_tts_voice, RATE, PROVIDER_A, "wav")) is not None
    assert cache.get_audio(cache_key(TEXT, get_settings().default_tts_voice, RATE, PROVIDER_B, "wav")) is not None


def test_cached_entry_belongs_to_key_provider(client, monkeypatch, sweep):
    """落盘文件的内容必须是 key 里那个 provider 产出的（不能算 A 的 key 存 B 的音频）。"""
    provider_a = NamedTTS(PROVIDER_A, kind="sweep")
    _patch(monkeypatch, provider_a)
    post_pronounce(client, sweep, TEXT)

    key_a = cache_key(TEXT, get_settings().default_tts_voice, RATE, PROVIDER_A, "wav")
    cached_bytes, _ext = get_cache().get_audio(key_a)
    assert cached_bytes == sweep_wav(150.0, 300.0, 1.5)  # A 的波形
    assert provider_a.calls == 1


# --------------------------------------------------------------------------------------
# 3. 版本前缀：v1.1 旧缓存永远不命中
# --------------------------------------------------------------------------------------
def test_v11_legacy_cache_entry_is_never_hit(client, monkeypatch, sweep):
    settings = get_settings()
    cache = get_cache()
    legacy_key = legacy_v11_cache_key(TEXT, settings.default_tts_voice, RATE)

    # 构造一个"完全合法"的 v1.1 旧条目（合法音频 + 合法 F0），看它会不会被用上
    legacy_audio = tone_wav(440.0, 1.5)
    clip = decode_audio(legacy_audio)
    points = extract_f0(clip.samples, clip.sample_rate).to_pairs()
    assert validate_f0_points(points) is not None
    cache.audio_dir.mkdir(parents=True, exist_ok=True)
    cache.f0_dir.mkdir(parents=True, exist_ok=True)
    (cache.audio_dir / f"{legacy_key}.wav").write_bytes(legacy_audio)
    (cache.f0_dir / f"{legacy_key}.json").write_text(
        json.dumps({"v": 1, "step_ms": 20, "points": points}), encoding="utf-8"
    )

    provider = NamedTTS(PROVIDER_A, kind="sweep")
    _patch(monkeypatch, provider)
    body = post_pronounce(client, sweep, TEXT).json()

    assert body["provider_meta"]["cache"] == {"reference_audio": "miss", "reference_f0": "miss"}, "v1.1 旧 key 不能被命中"
    assert body["intonation"]["reference_audio_url"] != f"/voice/v1/audio/ref_{legacy_key[:12]}.wav"
    assert provider.calls == 1, "旧条目不算命中，必须重新生成"
    # 旧文件保持不动（不会误删，也不会被读）
    assert (cache.audio_dir / f"{legacy_key}.wav").is_file()
    # 新 key 的条目已建立
    new_key = cache_key(TEXT, settings.default_tts_voice, RATE, PROVIDER_A, "wav")
    assert cache.get_audio(new_key) is not None


# --------------------------------------------------------------------------------------
# 4. fallback 产出的音频不落缓存（保证 key 里的 provider == 实际生产者）
# --------------------------------------------------------------------------------------
def test_fallback_audio_is_not_cached_under_any_provider_key(client, monkeypatch, sweep):
    primary = BrokenNamedTTS("azure", kind="tone")
    fallback = NamedTTS("mock", kind="sweep")
    base = build_providers()
    provider_set = ProviderSet(
        asr=base.asr,
        pa=base.pa,
        tts=primary,
        asr_chain=base.asr_chain,
        pa_chain=base.pa_chain,
        tts_chain=[primary, fallback],  # azure 挂 -> mock 兜底
        mode=base.mode,
    )
    monkeypatch.setattr("app.api.get_providers", lambda: provider_set)
    monkeypatch.setattr("app.warmup.get_providers", lambda: provider_set)

    body = post_pronounce(client, sweep, TEXT).json()
    assert "provider_fallback" in body["warnings"]
    settings = get_settings()
    cache = get_cache()
    assert cache.get_audio(cache_key(TEXT, settings.default_tts_voice, RATE, "azure", "wav")) is None
    assert cache.get_audio(cache_key(TEXT, settings.default_tts_voice, RATE, "mock", "wav")) is None
    assert cache.get_f0(cache_key(TEXT, settings.default_tts_voice, RATE, "azure", "wav")) is None
    assert fallback.calls == 1


# --------------------------------------------------------------------------------------
# 5. 单飞也必须是 provider 维度的
# --------------------------------------------------------------------------------------
def test_single_flight_is_provider_scoped(monkeypatch):
    cache = get_cache()
    cache.clear()
    provider_a = NamedTTS(PROVIDER_A, kind="sweep")
    provider_b = NamedTTS(PROVIDER_B, kind="tone")
    set_a = _provider_set(provider_a)
    set_b = _provider_set(provider_b)

    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def worker(provider_set):
        try:
            barrier.wait(timeout=5)
            warm_one(TEXT, VOICE, RATE, cache=cache, providers=provider_set)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(ps,)) for ps in (set_a, set_b)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not errors, errors
    assert provider_a.calls == 1 and provider_b.calls == 1, "不同 provider 不能共用同一个单飞任务"
    assert cache.get_audio(cache_key(TEXT, VOICE, RATE, PROVIDER_A, "wav")) is not None
    assert cache.get_audio(cache_key(TEXT, VOICE, RATE, PROVIDER_B, "wav")) is not None


# --------------------------------------------------------------------------------------
# 6. 同类问题排查：legacy store 是按内容寻址，与 provider 无关但天然安全
# --------------------------------------------------------------------------------------
def test_legacy_store_is_content_addressed_not_provider_dependent(tmp_path):
    store = AudioStore(tmp_path)
    same_a = store.save(b"AAA", "wav")
    same_b = store.save(b"AAA", "wav")
    other = store.save(b"BBB", "wav")
    assert same_a == same_b, "同样的字节 -> 同样的 id（幂等）"
    assert same_a != other
    assert same_a.startswith("ref_") and same_a.endswith(".wav") and len(same_a) == len("ref_") + 12 + 4
    # 不同 provider 产出的字节不同 -> id 必然不同；不存在"provider 混用"的隐患
    assert store.save(sweep_wav(150.0, 300.0, 1.5), "wav") != store.save(tone_wav(200.0, 1.5), "wav")


def test_external_id_derives_from_provider_scoped_key(client, monkeypatch, sweep):
    settings = get_settings()
    _patch(monkeypatch, NamedTTS(PROVIDER_A, kind="sweep"))
    body = post_pronounce(client, sweep, TEXT).json()
    key = cache_key(TEXT, settings.default_tts_voice, RATE, PROVIDER_A, "wav")
    assert body["intonation"]["reference_audio_url"] == f"/voice/v1/audio/ref_{key[:12]}.wav"
    assert client.get(body["intonation"]["reference_audio_url"].replace("/voice", "", 1)).status_code == 200


def test_no_other_provider_scoped_artifact_is_cached():
    """排查结论：除参考音/参考 F0 外，没有别的"provider 相关产物"被按 (text,voice,rate) 缓存。

    - legacy store：按音频**字节**寻址（上面用例已证），与 provider 无关但天然安全；
    - faster-whisper 模型缓存：按 (model, device, compute_type) 寻址，与 TTS provider 无关；
    - SingleFlight：key 就是 cache_key（已含 provider）。
    """
    from app.providers import local as local_module

    assert "TTS" not in repr(local_module._MODEL_CACHE)  # 模型缓存不掺 TTS provider
    settings = get_settings()
    # 同一个 (text,voice,rate) 在两个 provider 下产生两组互不相干的 key 与文件
    keys = {cache_key(TEXT, VOICE, RATE, name, "wav") for name in ("mock", "local", "azure")}
    assert len(keys) == 3


@pytest.mark.parametrize("provider", ["mock", "local", "azure"])
def test_key_never_collides_across_known_provider_names(provider):
    others = {"mock", "local", "azure"} - {provider}
    mine = cache_key(TEXT, VOICE, RATE, provider, "wav")
    for other in others:
        assert mine != cache_key(TEXT, VOICE, RATE, other, "wav")
    # 也不同于不带 provider / 带版本前缀缺失的形态
    assert mine not in {legacy_v11_cache_key(TEXT, VOICE, RATE), cache_key(TEXT, VOICE, RATE, None, "wav")}


def test_cache_stats_count_both_provider_entries(client, monkeypatch, sweep):
    _patch(monkeypatch, NamedTTS(PROVIDER_A, kind="sweep"))
    post_pronounce(client, sweep, TEXT)
    _patch(monkeypatch, NamedTTS(PROVIDER_B, kind="tone"))
    post_pronounce(client, sweep, TEXT)
    stats = get_cache().stats()
    assert stats["audio_entries"] == 2 and stats["f0_entries"] == 2, stats
    assert stats["bytes"] > 0


def test_slow_switch_still_fast_for_same_provider(client, monkeypatch, sweep):
    """同 provider 重复请求仍然命中缓存（修复不能把正常路径也打死）。"""
    provider = NamedTTS(PROVIDER_A, kind="sweep")
    original = provider.synthesize

    def slow(*args, **kwargs):
        time.sleep(0.4)
        return original(*args, **kwargs)

    provider.synthesize = slow  # type: ignore[assignment]
    _patch(monkeypatch, provider)
    started = time.perf_counter()
    first = post_pronounce(client, sweep, TEXT).json()
    first_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    second = post_pronounce(client, sweep, TEXT).json()
    second_ms = (time.perf_counter() - started) * 1000
    assert first["provider_meta"]["cache"] == {"reference_audio": "miss", "reference_f0": "miss"}
    assert second["provider_meta"]["cache"] == {"reference_audio": "hit", "reference_f0": "hit"}
    assert provider.calls == 1
    assert second_ms < first_ms / 2, f"first={first_ms:.0f}ms second={second_ms:.0f}ms"
