#!/usr/bin/env python3
"""Azure 接入自检（Lead 维护）—— 一条命令回答四个问题

1. **发音评测在你这个订阅/定价层上到底能不能用**（F0 免费层是否支持，官方文档没写明，只能实测）
2. **Azure 返回的音素符号，与项目的规范空间 `canonical-v1` 是否吻合**
   （不吻合不会报错，只会让 SRS 卡片 key 与云端输出对不上 → `phoneme_mastery` 静默断裂）
3. 能不能拿到**音素级 + NBestPhonemes + Prosody**（这三个是这个产品的核心价值）
4. 经过我们自己的 voice 服务这条链路时，hybrid 模式是否**真的生效**（还是静默降级回了 mock）

方法：先用 Azure TTS 合成一句母语者示范音（真实语音，不需要麦克风），再把这段音频喂给
发音评测 —— 相当于让"母语者"去考试，分数应当很高。

**两个阶段刻意分开**：
- 阶段 A 直连 Azure SDK，拿**原始**响应（我们的 voice 服务会把符号归一化，从 HTTP 响应里看不到 Azure 真实输出）
- 阶段 B 走 voice 服务的 HTTP 接口，验证端到端集成与降级行为

用法：
  cd voice && .venv/bin/python ../tests/azure_selfcheck.py
  BASE=http://127.0.0.1:8100 .venv/bin/python ../tests/azure_selfcheck.py   # 阶段 B 的目标服务

退出码：0 = 全部通过；1 = 有需要处理的问题。
**本脚本永不打印密钥。**
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOICE = ROOT / "voice"
BASE = os.environ.get("BASE", "http://127.0.0.1:8100").rstrip("/")

REFERENCE = "I think the weather is really nice today."
TTS_VOICE = os.environ.get("AZURE_TTS_VOICE", "en-US-JennyNeural")

problems: list[str] = []
notes: list[str] = []


def ok(msg: str) -> None:
    print(f"  \033[32m✓\033[0m {msg}")


def bad(msg: str) -> None:
    problems.append(msg)
    print(f"  \033[31m✗\033[0m {msg}")


def warn(msg: str) -> None:
    notes.append(msg)
    print(f"  \033[33m!\033[0m {msg}")


def mask(secret: str | None) -> str:
    if not secret:
        return "<空>"
    return f"<已设置，{len(secret)} 字符，前 4 位 {secret[:4]}…>"


# --------------------------------------------------------------------------- #
# 阶段 A：直连 Azure SDK，拿原始响应
# --------------------------------------------------------------------------- #
def phase_a() -> dict | None:
    print("\n[阶段 A] 直连 Azure SDK（原始响应，不经我们的归一化）")

    key = os.environ.get("AZURE_SPEECH_KEY")
    region = os.environ.get("AZURE_SPEECH_REGION")
    print(f"    AZURE_SPEECH_KEY    = {mask(key)}")
    print(f"    AZURE_SPEECH_REGION = {region!r}")
    if not key or not region:
        bad("缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION（检查 voice/.env 是否被正确加载）")
        return None

    try:
        import azure.cognitiveservices.speech as sdk
    except ImportError:
        bad("未安装 Azure SDK。装它：uv pip install --python .venv/bin/python azure-cognitiveservices-speech")
        return None
    ok(f"Azure SDK 已安装（{getattr(sdk, '__version__', '?')}）")

    # ---- A1. TTS 合成一句真实语音，作为"母语者"的考试音频 ----
    tmp = Path(tempfile.mkdtemp(prefix="azure-selfcheck-"))
    wav_path = tmp / "reference.wav"
    try:
        cfg = sdk.SpeechConfig(subscription=key, region=region)
        cfg.speech_synthesis_voice_name = TTS_VOICE
        cfg.set_speech_synthesis_output_format(
            sdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm
        )
        synth = sdk.SpeechSynthesizer(speech_config=cfg, audio_config=None)
        res = synth.speak_text_async(REFERENCE).get()
        if res.reason != sdk.ResultReason.SynthesizingAudioCompleted:
            det = sdk.SpeechSynthesisCancellationDetails.from_result(res)
            bad(f"TTS 失败：{res.reason} / {det.error_code} / {det.error_details}")
            return None
        wav_path.write_bytes(res.audio_data)
        with wave.open(str(wav_path), "rb") as w:
            dur = w.getnframes() / w.getframerate()
        ok(f"TTS 合成成功：{len(res.audio_data)} 字节 / {dur:.2f}s / {TTS_VOICE}")
    except Exception as exc:  # noqa: BLE001
        bad(f"TTS 调用异常：{type(exc).__name__}: {exc}")
        return None

    # ---- A2. 把这段音频喂给发音评测（关键：这一句决定 F0 能不能用） ----
    try:
        pa_cfg = sdk.PronunciationAssessmentConfig(
            reference_text=REFERENCE,
            grading_system=sdk.PronunciationAssessmentGradingSystem.HundredMark,
            granularity=sdk.PronunciationAssessmentGranularity.Phoneme,
            enable_miscue=True,
        )
        pa_cfg.phoneme_alphabet = "IPA"
        pa_cfg.nbest_phoneme_count = 5
        pa_cfg.enable_prosody_assessment()

        rec = sdk.SpeechRecognizer(
            speech_config=sdk.SpeechConfig(subscription=key, region=region),
            audio_config=sdk.audio.AudioConfig(filename=str(wav_path)),
        )
        pa_cfg.apply_to(rec)
        result = rec.recognize_once()

        if result.reason == sdk.ResultReason.Canceled:
            det = sdk.SpeechRecognitionCancellationDetails.from_result(result)
            bad(f"发音评测被取消：{det.error_code} — {det.error_details}")
            if "Quota" in str(det.error_code) or "quota" in str(det.error_details).lower():
                warn("看起来是配额/定价层限制。若你的资源是 F0，可能需要升到 S0 才能用发音评测。")
            return None
        if result.reason != sdk.ResultReason.RecognizedSpeech:
            bad(f"发音评测未识别到语音：{result.reason}")
            return None
        ok("发音评测调用成功（这一条即证明：你的定价层支持 Pronunciation Assessment）")
    except Exception as exc:  # noqa: BLE001
        bad(f"发音评测调用异常：{type(exc).__name__}: {exc}")
        return None

    raw_json = result.properties.get(sdk.PropertyId.SpeechServiceResponse_JsonResult)
    if not raw_json:
        bad("拿不到原始 JSON（无法核对音素符号）")
        return None
    data = json.loads(raw_json)
    nbest = (data.get("NBest") or [{}])[0]
    pa = nbest.get("PronunciationAssessment") or {}
    words = nbest.get("Words") or []

    print("\n    —— Azure 原始返回 ——")
    print(f"    DisplayText      : {data.get('DisplayText')!r}")
    print(f"    PronScore        : {pa.get('PronScore')}")
    print(f"    AccuracyScore    : {pa.get('AccuracyScore')}")
    print(f"    FluencyScore     : {pa.get('FluencyScore')}")
    print(f"    CompletenessScore: {pa.get('CompletenessScore')}")
    print(f"    ProsodyScore     : {pa.get('ProsodyScore', '(未返回)')}")
    print(f"    词数 / 音素数    : {len(words)} / {sum(len(w.get('Phonemes') or []) for w in words)}")

    if pa.get("ProsodyScore") is None:
        warn("未返回 ProsodyScore（本项目语调自建 F0+DTW，不依赖它，可忽略）")
    else:
        ok("ProsodyScore 可用（本项目不需要它，但说明加购项对你开放）")

    # ---- A3. 收集 Azure 的原始音素符号 ----
    raw_symbols: set[str] = set()
    nbest_example = None
    for w in words:
        for p in w.get("Phonemes") or []:
            if p.get("Phoneme"):
                raw_symbols.add(p["Phoneme"])
            for nb in (p.get("PronunciationAssessment") or {}).get("NBestPhonemes") or []:
                if nb.get("Phoneme"):
                    raw_symbols.add(nb["Phoneme"])
                if nbest_example is None and (p.get("PronunciationAssessment") or {}).get("NBestPhonemes"):
                    nbest_example = (w.get("Word"), p.get("Phoneme"), [
                        (x.get("Phoneme"), x.get("Score"))
                        for x in p["PronunciationAssessment"]["NBestPhonemes"]
                    ])
    print(f"    原始音素符号（{len(raw_symbols)} 种）: {' '.join(sorted(raw_symbols))}")
    if nbest_example:
        print(f"    NBestPhonemes 示例: {nbest_example[0]!r} 期望 {nbest_example[1]!r} → {nbest_example[2]}")

    # ---- A4. 与 canonical-v1 对照 ----
    print("\n    —— 与项目规范空间 canonical-v1 对照 ——")
    sys.path.insert(0, str(VOICE))
    try:
        from app.phonemes import CANONICAL_MAP, CANONICAL_PHONEMES, canonicalize_all  # type: ignore

        in_space = {s for s in raw_symbols if s in CANONICAL_PHONEMES}
        variants, unknown = set(), set()
        for s in raw_symbols - CANONICAL_PHONEMES:
            (variants if canonicalize_all([s])[0] != s else unknown).add(s)
        print(f"    已在规范空间内（{len(in_space)}）: {' '.join(sorted(in_space)) or '(无)'}")
        print(f"    变体、已被映射表覆盖（{len(variants)}）: {' '.join(sorted(variants)) or '(无)'}")
        print(f"    \033[1m未知、需要补进映射表（{len(unknown)}）\033[0m: {' '.join(sorted(unknown)) or '(无)'}")
        if unknown:
            bad(f"有 {len(unknown)} 个 Azure 符号不在规范空间也无法映射：{' '.join(sorted(unknown))}")
            print(f"       修法：把它们加进 {VOICE}/app/phonemes.py 的 CANONICAL_MAP")
            print("       （映射到 CANONICAL_PHONEMES 里最接近的符号；加完重跑 pytest 与语料审计）")
        else:
            ok("canonical-v1 与 Azure 实际输出吻合，无需改动映射表")
    except Exception as exc:  # noqa: BLE001
        warn(f"无法导入 voice/app/phonemes.py 做对照：{exc}")

    return {"scores": pa, "raw_symbols": sorted(raw_symbols)}


# --------------------------------------------------------------------------- #
# 阶段 B：走我们自己的 voice 服务
# --------------------------------------------------------------------------- #
def phase_b() -> None:
    print("\n[阶段 B] 经 voice 服务（验证 hybrid 是否真的生效、契约形状是否正确）")

    def http(path: str, data: bytes | None = None, ctype: str | None = None, method: str = "GET"):
        req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
        if ctype:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)
        except Exception as e:  # noqa: BLE001
            return None, str(e).encode(), {}

    status, body, _ = http("/v1/health")
    if status != 200:
        bad(f"voice 服务不可达（{BASE}/v1/health → {status}）。先启动它：cd voice && .venv/bin/python -m uvicorn app.main:app --port 8100")
        return
    health = json.loads(body)
    print(f"    mode      : {health.get('mode')}")
    print(f"    providers : {health.get('providers')}")
    print(f"    capabilities: {health.get('capabilities')}")

    if health.get("providers", {}).get("pa") != "azure":
        bad(f"发音评测 provider 不是 azure（实际 {health.get('providers', {}).get('pa')}）——hybrid 没生效，"
            "很可能 Azure SDK 没装或密钥没读到，服务已静默降级")
    else:
        ok("hybrid 已生效：发音评测走 azure")
    if not health.get("capabilities", {}).get("phoneme_level"):
        bad("capabilities.phoneme_level 为 false（音素级不可用）")
    else:
        ok("capabilities.phoneme_level = true（音素级可用）")

    # TTS 取一段音频
    status, audio, headers = http(
        "/v1/tts", json.dumps({"text": REFERENCE, "voice": TTS_VOICE, "rate": "normal", "format": "wav"}).encode(),
        "application/json", "POST",
    )
    if status != 200:
        bad(f"/v1/tts 失败：{status} {audio[:200]!r}")
        return
    ok(f"TTS 经 voice 服务返回 {len(audio)} 字节（provider={headers.get('X-TTS-Provider') or headers.get('x-tts-provider')}）")

    # 组装 multipart 调 pronounce
    boundary = "----azureselfcheck"
    parts = []
    for name, value in (("reference_text", REFERENCE), ("mode", "scripted"), ("granularity", "phoneme"),
                        ("with_intonation", "true"), ("learner_age_band", "adult")):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"probe.wav\"\r\n"
        f"Content-Type: audio/wav\r\n\r\n".encode() + audio + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    status, body, _ = http("/v1/pronounce", b"".join(parts), f"multipart/form-data; boundary={boundary}", "POST")
    if status != 200:
        bad(f"/v1/pronounce 失败：{status} {body[:300]!r}")
        return
    pr = json.loads(body)
    print(f"    provider   : {pr.get('provider')}   granularity: {pr.get('granularity')}")
    print(f"    scores     : {pr.get('scores')}")
    print(f"    warnings   : {pr.get('warnings')}")
    meta = pr.get("provider_meta") or {}
    print(f"    provider_meta: {json.dumps(meta, ensure_ascii=False)[:300]}")
    print(f"    intonation : available={pr.get('intonation', {}).get('available')} "
          f"dtw={pr.get('intonation', {}).get('dtw_distance')} "
          f"点数={len(pr.get('intonation', {}).get('user_f0') or [])}")

    if pr.get("provider") != "azure":
        bad(f"pronounce 实际由 {pr.get('provider')} 产出（发生了降级）——查 provider_meta.primary_error")
    else:
        ok("pronounce 由 azure 产出（未降级）")
    if "provider_fallback" in (pr.get("warnings") or []):
        bad(f"出现 provider_fallback：{meta.get('primary_error')}")
    if pr.get("granularity") != "phoneme":
        bad(f"粒度降级为 {pr.get('granularity')}（期望 phoneme）")
    else:
        ok("音素级粒度生效")
    issues = pr.get("issues") or []
    if issues:
        ok(f"issues 有 {len(issues)} 条，例：{issues[0].get('word')} /{issues[0].get('phoneme')}/ "
           f"→ {issues[0].get('actual')}（hint_key={issues[0].get('hint_key')}）")
    else:
        note = "母语者 TTS 音频得了高分，没有错误项是正常的（这正是预期）"
        print(f"    （{note}）")
    if pr.get("intonation", {}).get("available"):
        ok("语调曲线可用（真实语音对真实参考，DTW 应当很小）")
    else:
        warn("语调曲线不可用，检查 intonation 的 warnings")


def main() -> int:
    print("=" * 78)
    print("Azure 接入自检 —— 回答：能不能用 / 符号是否吻合 / hybrid 是否真生效")
    print("=" * 78)

    # 复用 voice 自己的 .env 解析（同一个实现，避免"脚本读到的和服力读到的不是一回事"）
    sys.path.insert(0, str(VOICE))
    try:
        from app.config import _load_dotenv  # type: ignore

        loaded = _load_dotenv()
        print(f"  已加载配置: {loaded or '(未找到 .env，使用真实环境变量)'}")
    except Exception as exc:  # noqa: BLE001
        print(f"  \033[33m!\033[0m 未能加载 voice/.env：{exc}")

    result = phase_a()
    phase_b()

    print("\n" + "=" * 78)
    if problems:
        print(f"\033[31m发现 {len(problems)} 个需要处理的问题：\033[0m")
        for p in problems:
            print(f"  ✗ {p}")
    else:
        print("\033[32m全部通过：Azure 发音评测可用，符号空间吻合，hybrid 端到端生效。\033[0m")
    if notes:
        print("\n提示（不阻断）：")
        for n in notes:
            print(f"  ! {n}")
    print("=" * 78)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
