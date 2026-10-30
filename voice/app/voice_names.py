"""Azure 语音名工具：locale 推导 + SSML 注入防护（task-46）。

中文鼓励语需要用中文音色（如 `zh-CN-XiaoxiaoNeural`）。Azure 的 SSML 要求 `xml:lang` 与
`<voice name=...>` 的 locale 一致，否则会念成英文腔或直接 400。这里从语音名推导 locale：
`zh-CN-XiaoxiaoNeural` -> `zh-CN`、`en-US-JennyNeural` -> `en-US`；
解析失败时回退到默认音色的 locale，再失败回退 `en-US`。
"""

from __future__ import annotations

import re

# 只允许 Azure 语音名的安全字符集：字母/数字/点/下划线/连字符。
# 禁止引号、尖括号、& 等 → 防 SSML 注入（voice 会被拼进 XML 属性）。
_VOICE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

# locale 前缀：2–3 字母语言 + 2–4 字母地区/文字（zh-CN / en-US / yue-CN / zh-Hans…）
_LOCALE_RE = re.compile(r"^([A-Za-z]{2,3})-([A-Za-z]{2,4})(?:-|$)")

DEFAULT_LOCALE = "en-US"


def is_valid_voice_name(voice: str | None) -> bool:
    """是否是安全的 Azure 语音名（防注入）。"""
    return bool(voice) and bool(_VOICE_NAME_RE.fullmatch(str(voice).strip()))


def normalize_voice_name(voice: str | None) -> str | None:
    """返回规范化后的语音名；非法（含引号/尖括号/空格等）返回 None。"""
    if not voice:
        return None
    candidate = str(voice).strip()
    return candidate if is_valid_voice_name(candidate) else None


def _locale_from_voice(voice: str | None) -> str | None:
    if not voice:
        return None
    match = _LOCALE_RE.match(str(voice).strip())
    if not match:
        return None
    language, region = match.group(1), match.group(2)
    # 常规 locale 地区大写（zh-CN/en-US）；4 字母的可能是文字（Hans/Hant），保持原样
    region = region.upper() if len(region) == 2 else region
    return f"{language.lower()}-{region}"


def voice_locale(voice: str | None, fallback_voice: str | None = None, default: str = DEFAULT_LOCALE) -> str:
    """从语音名推导 SSML `xml:lang`；失败回退 fallback_voice 的 locale，再失败用 default。"""
    for candidate in (voice, fallback_voice):
        locale = _locale_from_voice(candidate)
        if locale:
            return locale
    return default
