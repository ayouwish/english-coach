"""原始用量（task-100）：voice 只返回 provider 实际用量，**不写死单价/金额**（由 web 记账）。

- LLM 端点：`{llm_prompt_tokens, llm_completion_tokens, llm_total_tokens}`（跨多次重试求和）
- provider 不返回 usage（fake/本地）→ 返回 None，绝不编造
"""

from __future__ import annotations


def llm_usage(*outcomes) -> dict | None:
    """把多次 LLM 调用的 token 用量求和；所有调用都没有 usage → None。"""
    prompt = completion = total = 0
    seen = False
    for outcome in outcomes:
        if outcome is None:
            continue
        p = getattr(outcome, "prompt_tokens", None)
        c = getattr(outcome, "completion_tokens", None)
        t = getattr(outcome, "total_tokens", None)
        if p is None and c is None and t is None:
            continue
        seen = True
        prompt += int(p or 0)
        completion += int(c or 0)
        total += int(t or 0)
    if not seen:
        return None
    if total <= 0:
        total = prompt + completion
    return {
        "llm_prompt_tokens": prompt,
        "llm_completion_tokens": completion,
        "llm_total_tokens": total,
    }


def image_usage(size: str, model: str, images: int = 1) -> dict:
    return {"images": int(images), "size": size, "model": model}


def tts_usage(text: str | None) -> dict:
    return {"tts_chars": len(text or "")}


def asr_usage(duration_ms: int | float | None) -> dict:
    return {"asr_seconds": round(max(0.0, float(duration_ms or 0)) / 1000.0, 2)}
