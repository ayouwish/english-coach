#!/usr/bin/env python
"""ASR A/B 试验（task-112）：DeepSeek vs 现有 provider（英文 Azure / 中文 智谱）的真实对比。

- 用 **Azure TTS** 合成 20 条英文 + 20 条中文已知文本 WAV（清晰合成语音；不代表儿童真实口音/噪声）
- 每条分别调用 DeepSeek ASR / 英文 Azure ASR / 中文 智谱 GLM-ASR（有 key 才调，无 key 明确跳过，不伪造）
- 计算 CER（中文按字、英文按词；编辑距离/参考长度）、延迟、按官方单价估算成本
- 输出 `docs/asr-ab-report.md`（表格 + 汇总 + 结论/风险）

用法：
    python scripts/asr_ab.py                    # 20 英 + 20 中（需 Azure TTS/ASR + DeepSeek key）
    python scripts/asr_ab.py --limit 2          # 快速验证（各 2 条）
    python scripts/asr_ab.py --out /tmp/asr-ab.md --skip-native   # 只测 DeepSeek
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.audio_io import decode_audio  # noqa: E402
from app.config import get_settings  # noqa: E402

ENGLISH_TEXTS = [
    "I like going to my school today.",
    "My teacher reads a story to us every morning.",
    "The cat is sleeping under the chair.",
    "I would like a glass of water, please.",
    "We played football in the park yesterday.",
    "She is wearing a blue jacket and white shoes.",
    "Can you help me carry this box upstairs?",
    "My favourite food is noodles with vegetables.",
    "The train leaves at half past eight.",
    "Please open the window, it is very hot today.",
    "I have two brothers and one little sister.",
    "He bought a new bicycle last weekend.",
    "Do you want to come to the library with me?",
    "The weather is sunny and warm this afternoon.",
    "I am learning English songs at school.",
    "There are many beautiful flowers in the garden.",
    "Would you like some tea or coffee?",
    "My mother cooks dinner at six o'clock.",
    "The children are drawing pictures of animals.",
    "I forgot my homework at home this morning.",
]
CHINESE_TEXTS = [
    "今天我和小明一起去公园玩。",
    "我每天早上七点起床去上学。",
    "妈妈做的面条非常好吃。",
    "昨天晚上我看了一本有趣的故事书。",
    "请问最近的地铁站怎么走？",
    "我想要一杯温水和一块蛋糕。",
    "小猫在椅子下面睡觉。",
    "老师给我们讲了一个关于月亮的故事。",
    "周末我和爸爸一起去爬山。",
    "我喜欢在图书馆里安静地看书。",
    "火车八点半出发，我们要早点到。",
    "今天天气很热，请把窗户打开。",
    "他昨天买了一辆新的自行车。",
    "我的妹妹今年五岁，她很喜欢画画。",
    "我们班有三十个同学。",
    "你能帮我拿一下这个箱子吗？",
    "晚饭后我们通常出去散步。",
    "我正在学习写汉字。",
    "花园里有很多漂亮的花。",
    "明天我想去书店买一本词典。",
]

# 单价（可按需用环境变量覆盖；仅用于估算，不代表账单）
PRICE_CNY_PER_HOUR = {"deepseek": 0.78, "azure": 7.2, "zhipu": 3.6}


def _normalize(text: str, language: str) -> list[str]:
    import re

    lowered = (text or "").lower().strip()
    if language == "zh":
        cleaned = re.sub(r"[\s，。！？、,.!?;；:：\"'“”‘’（）()\-]", "", lowered)
        return list(cleaned)
    cleaned = re.sub(r"[^a-z0-9'\s]", " ", lowered)
    return [word for word in cleaned.split() if word]


def _edit_distance(ref: list[str], hyp: list[str]) -> int:
    if not ref:
        return len(hyp)
    previous = list(range(len(hyp) + 1))
    for i, ref_item in enumerate(ref, start=1):
        current = [i]
        for j, hyp_item in enumerate(hyp, start=1):
            current.append(
                min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (0 if ref_item == hyp_item else 1))
            )
        previous = current
    return previous[-1]


def cer(reference: str, hypothesis: str, language: str) -> float:
    ref = _normalize(reference, language)
    hyp = _normalize(hypothesis, language)
    if not ref:
        return 0.0 if not hyp else 1.0
    return min(1.0, _edit_distance(ref, hyp) / len(ref))


def _synthesize(text: str, language: str, attempts: int = 3) -> bytes:
    from app.providers.azure import AzureTTS

    tts = AzureTTS()
    voice = "en-US-JennyNeural" if language == "en" else "zh-CN-XiaoxiaoNeural"
    last: Exception | None = None
    for _ in range(attempts):
        try:
            return tts.synthesize(text, voice=voice, rate="normal", fmt="wav").audio
        except Exception as exc:  # Azure TTS 偶发超时 → 重试
            last = exc
            time.sleep(1.5)
    raise last  # type: ignore[misc]


def _recognize_deepseek(data: bytes) -> tuple[str, float]:
    from app.providers.deepseek_asr import DeepSeekASR

    clip = decode_audio(data, 16000, 300.0)
    started = time.perf_counter()
    result = DeepSeekASR().recognize(clip, language="auto")
    return result.text, (time.perf_counter() - started) * 1000.0


def _recognize_azure(data: bytes, language: str) -> tuple[str, float]:
    from app.providers.azure import AzureASR

    clip = decode_audio(data, 16000, 300.0)
    started = time.perf_counter()
    result = AzureASR().recognize(clip, language=language)
    return result.text, (time.perf_counter() - started) * 1000.0


def _recognize_zhipu(data: bytes) -> tuple[str, float]:
    from app.providers.zhipu_asr import ZhipuASR

    clip = decode_audio(data, 16000, 300.0)
    started = time.perf_counter()
    result = ZhipuASR().recognize(clip, language="zh-CN")
    return result.text, (time.perf_counter() - started) * 1000.0


def _fmt(value: float, digits: int = 3) -> str:
    return f"{value:.{digits}f}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ASR A/B 试验（DeepSeek vs Azure/智谱）")
    parser.add_argument("--limit", type=int, default=20, help="每种语言条数（默认 20）")
    parser.add_argument("--out", default=str(ROOT.parent / "docs" / "asr-ab-report.md"))
    parser.add_argument("--skip-native", action="store_true", help="只测 DeepSeek，不调 Azure/智谱")
    parser.add_argument("--json", default=None, help="可选：把原始结果写 JSON")
    args = parser.parse_args(argv)

    settings = get_settings()
    deepseek_key = settings.deepseek_asr_api_key or settings.llm_api_key
    azure_ready = bool(settings.azure_speech_key)
    zhipu_ready = bool(settings.zhipu_asr_api_key or settings.image_api_key)
    limit = max(1, min(args.limit, len(ENGLISH_TEXTS), len(CHINESE_TEXTS)))

    print(f"DeepSeek key: {'有' if deepseek_key else '无'} | Azure: {'有' if azure_ready else '无'} | 智谱: {'有' if zhipu_ready else '无'}")
    if not deepseek_key:
        print("未找到 DEEPSEEK_ASR_API_KEY / LLM_API_KEY —— 跳过真实调用（不伪造 A/B 结果）")
        return 2
    if not azure_ready:
        print("未找到 Azure key —— 无法用 Azure TTS 生成测试音频，跳过（不伪造）")
        return 2

    results: list[dict] = []
    failures: list[str] = []
    for language, texts in (("en", ENGLISH_TEXTS[:limit]), ("zh", CHINESE_TEXTS[:limit])):
        for index, reference in enumerate(texts, start=1):
            item: dict = {"language": language, "index": index, "reference": reference}
            try:
                audio = _synthesize(reference, language)
                item["audio_seconds"] = round(decode_audio(audio, 16000, 300.0).duration_s, 2)
            except Exception as exc:
                failures.append(f"{language}#{index} TTS: {type(exc).__name__}: {exc}")
                continue
            try:
                text, latency = _recognize_deepseek(audio)
                item["deepseek"] = {"text": text, "cer": round(cer(reference, text, language), 3), "ms": round(latency, 1)}
            except Exception as exc:
                item["deepseek"] = {"error": f"{type(exc).__name__}: {exc}"}
                failures.append(f"{language}#{index} deepseek: {type(exc).__name__}: {exc}")

            if not args.skip_native:
                if language == "en" and azure_ready:
                    try:
                        text, latency = _recognize_azure(audio, "en")
                        item["native"] = {
                            "provider": "azure",
                            "text": text,
                            "cer": round(cer(reference, text, language), 3),
                            "ms": round(latency, 1),
                        }
                    except Exception as exc:
                        item["native"] = {"provider": "azure", "error": f"{type(exc).__name__}: {exc}"}
                elif language == "zh" and zhipu_ready:
                    try:
                        text, latency = _recognize_zhipu(audio)
                        item["native"] = {
                            "provider": "zhipu",
                            "text": text,
                            "cer": round(cer(reference, text, language), 3),
                            "ms": round(latency, 1),
                        }
                    except Exception as exc:
                        item["native"] = {"provider": "zhipu", "error": f"{type(exc).__name__}: {exc}"}
                else:
                    item["native"] = {"provider": None, "skipped": "缺少对应 provider key"}
            results.append(item)

    # 汇总
    summary: dict[str, dict] = {}
    for language in ("en", "zh"):
        rows = [row for row in results if row["language"] == language]
        for provider in ("deepseek", "native"):
            values = [row[provider]["cer"] for row in rows if provider in row and "cer" in row[provider]]
            latencies = [row[provider]["ms"] for row in rows if provider in row and "ms" in row[provider]]
            seconds = [row.get("audio_seconds", 0.0) for row in rows if provider in row and "cer" in row[provider]]
            if not values:
                continue
            native_name = "azure" if language == "en" else "zhipu"
            name = "deepseek" if provider == "deepseek" else native_name
            total_seconds = sum(seconds)
            summary[f"{language}:{name}"] = {
                "language": language,
                "provider": name,
                "n": len(values),
                "cer_mean": statistics.fmean(values),
                "cer_median": statistics.median(values),
                "latency_mean_ms": statistics.fmean(latencies),
                "cost_cny": total_seconds / 3600.0 * PRICE_CNY_PER_HOUR.get(name, 0.0),
                "seconds": total_seconds,
            }

    lines: list[str] = []
    lines.append("# ASR A/B 试验报告：DeepSeek vs Azure / 智谱 GLM-ASR（task-112）")
    lines.append("")
    lines.append(f"- 生成时间：{datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    lines.append(f"- 样本：英文 {limit} 条 / 中文 {limit} 条（**Azure TTS 合成清晰语音**，已知参考文本）")
    lines.append("- CER：中文按字（编辑距离/参考字数），英文按词（编辑距离/参考词数）；标点与空格已归一化")
    lines.append("- 成本：DeepSeek ¥0.78/小时、Azure ¥7.2/小时、智谱 ¥3.6/小时（=¥0.06/分钟），仅估算")
    lines.append("- **局限**：合成语音 ≠ 儿童真实语音；未覆盖口音、噪声、语速、数字/标点、中英混说、长音频切段等场景")
    lines.append("")
    if not zhipu_ready:
        lines.append("> 注意：本机无智谱 key，中文对照列（智谱）**未执行**（不伪造结果）。")
        lines.append("")
    lines.append("## 汇总")
    lines.append("")
    lines.append("| 语言 | Provider | 条数 | CER 均值 | CER 中位数 | 平均延迟(ms) | 估算成本(元) |")
    lines.append("|---|---|---|---|---|---|---|")
    for key in ("en:deepseek", "en:azure", "zh:deepseek", "zh:zhipu"):
        row = summary.get(key)
        if not row:
            continue
        lines.append(
            f"| {row['language']} | {row['provider']} | {row['n']} | {_fmt(row['cer_mean'])} | "
            f"{_fmt(row['cer_median'])} | {row['latency_mean_ms']:.0f} | {row['cost_cny']:.4f} |"
        )
    lines.append("")
    lines.append("## 逐条结果")
    lines.append("")
    lines.append("| # | 语言 | 参考文本 | DeepSeek（CER/ms） | 识别结果 | 对照 provider（CER/ms） |")
    lines.append("|---|---|---|---|---|---|")
    for row in results:
        deepseeek = row.get("deepseek", {})
        native = row.get("native", {})
        deep_summary = (
            f"{_fmt(deepseeek['cer'])} / {deepseeek['ms']:.0f}ms" if "cer" in deepseeek else f"错误: {deepseeek.get('error', '?')[:40]}"
        )
        native_summary = (
            f"{native.get('provider')}: {_fmt(native['cer'])} / {native['ms']:.0f}ms"
            if "cer" in native
            else f"{native.get('provider') or '跳过'}: {native.get('error') or native.get('skipped', '')}"
        )
        lines.append(
            f"| {row['index']} | {row['language']} | {row['reference'][:42]} | {deep_summary} | "
            f"{(deepseeek.get('text') or '')[:50]} | {native_summary} |"
        )
    lines.append("")
    lines.append("## 结论 / 风险")
    lines.append("")
    if summary:
        en_ds = summary.get("en:deepseek")
        en_az = summary.get("en:azure")
        zh_ds = summary.get("zh:deepseek")
        zh_zp = summary.get("zh:zhipu")
        if en_ds and en_az:
            lines.append(
                f"- 英文：DeepSeek CER 均值 {_fmt(en_ds['cer_mean'])} vs Azure {_fmt(en_az['cer_mean'])}；"
                f"延迟 {en_ds['latency_mean_ms']:.0f}ms vs {en_az['latency_mean_ms']:.0f}ms。"
            )
        if zh_ds and zh_zp:
            lines.append(
                f"- 中文：DeepSeek CER 均值 {_fmt(zh_ds['cer_mean'])} vs 智谱 {_fmt(zh_zp['cer_mean'])}；"
                f"延迟 {zh_ds['latency_mean_ms']:.0f}ms vs {zh_zp['latency_mean_ms']:.0f}ms。"
            )
        elif zh_ds:
            lines.append(f"- 中文：仅 DeepSeek 有数据（智谱无 key，未对比）。DeepSeek CER 均值 {_fmt(zh_ds['cer_mean'])}。")
    lines.append("- DeepSeek 返回无时间戳/置信度 → 不能用于词级反馈/GOP 诊断；仅适合整句转写。")
    lines.append("- 上线前需用**真实儿童录音**（含口音/噪声/中英混说）复测；本次合成语音结果只能作为初步参考。")
    if failures:
        lines.append("")
        lines.append("### 调用失败记录")
        for failure in failures:
            lines.append(f"- {failure}")
    lines.append("")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"报告已写入 {out_path}")
    if args.json:
        Path(args.json).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    for key, row in summary.items():
        print(
            f"  {key}: n={row['n']} CER={row['cer_mean']:.3f} latency={row['latency_mean_ms']:.0f}ms "
            f"cost=¥{row['cost_cny']:.4f}"
        )
    if failures:
        print(f"  失败 {len(failures)} 条（详见报告）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
