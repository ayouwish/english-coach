"""ASR 语言代码规范化（task-47：故事模式需要中文语音输入）。

对外契约允许 `en` / `en-US` / `zh` / `zh-CN`（大小写不敏感），内部统一成完整 locale；
Azure 直接用 `en-US` / `zh-CN`，faster-whisper 只认 ISO 639-1（`en` / `zh`），由 provider 自己 split。
"""

from __future__ import annotations

# 规范化结果 -> 允许的输入（小写比较）
_ALLOWED: dict[str, set[str]] = {
    "en-US": {"en", "en-us", "en_us", "english"},
    "zh-CN": {"zh", "zh-cn", "zh_cn", "zh-hans", "chinese", "cmn"},
}

SUPPORTED_ASR_LANGUAGES: tuple[str, ...] = ("en", "en-US", "zh", "zh-CN")


def normalize_language(value: str | None, default: str = "en-US") -> str | None:
    """规范化语言代码；无法识别返回 None（调用方应 400）。空值返回 default。"""
    if value is None or not str(value).strip():
        return default
    key = str(value).strip().lower().replace("_", "-")
    for canonical, aliases in _ALLOWED.items():
        if key in aliases or key == canonical.lower():
            return canonical
    return None


def whisper_language(locale: str | None) -> str:
    """faster-whisper 只接受 ISO 639-1（en/zh），从 locale 取语言部分。"""
    normalized = normalize_language(locale) or "en-US"
    return normalized.split("-")[0]
