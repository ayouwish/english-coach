"""LLM 层：OpenAI 兼容 HTTP 接口（DeepSeek / Ollama / vLLM 皆可）+ 失败自动降级。

没有 key、请求超时、返回不是合法 JSON —— 一律返回 ``provider="template"``，HTTP 仍 200。
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

import httpx

from .config import Settings, get_settings

logger = logging.getLogger("voice.llm")


@dataclass
class VisionOutcome:
    """多模态（图片输入）调用的结果：纯文本 + 诊断信息（截断/思考 token）。

    `finish_reason="length"` 表示输出被 max_tokens 截断——对推理模型（deepseek-flash 先输出
    reasoning_content 再输出 content）这会导致 content 为空或残缺，必须显式检测并重试。
    """

    provider: str
    text: str | None = None
    error: str | None = None
    finish_reason: str | None = None
    completion_tokens: int | None = None
    reasoning_tokens: int | None = None
    reasoning_len: int = 0
    thinking_disabled: bool = False  # 本次请求是否真的带了 thinking:disabled（400 降级后为 False）

    @property
    def ok(self) -> bool:
        return self.text is not None

    @property
    def truncated(self) -> bool:
        return self.finish_reason == "length"


@dataclass
class LLMOutcome:
    provider: str
    data: dict | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.data is not None


class LLMClient:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or get_settings()

    @property
    def available(self) -> bool:
        return bool(self.settings.llm_enabled and self.settings.llm_base_url)

    @property
    def provider_name(self) -> str:
        return self.settings.llm_provider if self.available else "template"

    @property
    def vision_available(self) -> bool:
        """多模态（图片输入）是否可用：与文本 LLM 同一套 base_url/key。"""
        return self.available

    def read_image(
        self,
        image_data_url: str,
        prompt: str,
        timeout_s: float | None = None,
        max_tokens: int = 1500,
        temperature: float = 0.0,
        disable_thinking: bool = False,
    ) -> VisionOutcome:
        """OpenAI 兼容多模态调用：content = [text, image_url(data URL)]，返回纯文本。

        用于 OCR（拍照识别书页）。`deepseek-flash` 是推理模型：会先输出 reasoning_content，
        如果 max_tokens 被思考吃光，`content` 会为空/截断。传 `disable_thinking=True` 会加
        `"thinking": {"type": "disabled"}`（实测 1010ms vs 5.9s，且 token 更少）；
        若该参数被端点拒绝（HTTP 400），自动降级为"不带该参数"重试一次，不向上抛 500。
        """
        if not self.available:
            return VisionOutcome(provider="template", error="llm_not_configured")
        base = (self.settings.llm_base_url or "").rstrip("/")
        url = f"{base}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.settings.llm_api_key:
            headers["Authorization"] = f"Bearer {self.settings.llm_api_key}"

        def _post(thinking_disabled: bool):
            payload = {
                "model": self.settings.llm_model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": image_data_url}},
                        ],
                    }
                ],
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            if thinking_disabled:
                payload["thinking"] = {"type": "disabled"}
            return httpx.post(url, headers=headers, json=payload, timeout=timeout_s or self.settings.ocr_timeout_s)

        used_disable = bool(disable_thinking)
        try:
            response = _post(used_disable)
            if used_disable and getattr(response, "status_code", 200) == 400:
                # 该端点不认识 thinking 参数 → 降级：不带参数、靠更大的 max_tokens 兜
                logger.warning(
                    "LLM vision rejected thinking=disabled (HTTP 400); retrying without it (max_tokens=%s)",
                    max_tokens,
                )
                used_disable = False
                response = _post(False)
            response.raise_for_status()
            body = response.json()
            choice = (body.get("choices") or [{}])[0] or {}
            message = choice.get("message") or {}
            content = message.get("content")
            reasoning = message.get("reasoning_content") or ""
            if isinstance(content, list):  # 少数端点返回分段 content
                content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
            usage = body.get("usage") or {}
            details = usage.get("completion_tokens_details") or {}
            finish_reason = choice.get("finish_reason")
            if content is None:
                return VisionOutcome(
                    provider=self.provider_name,
                    error="empty_content",
                    finish_reason=finish_reason,
                    completion_tokens=usage.get("completion_tokens"),
                    reasoning_tokens=details.get("reasoning_tokens"),
                    reasoning_len=len(reasoning),
                    thinking_disabled=used_disable,
                )
            return VisionOutcome(
                provider=self.provider_name,
                text=str(content),
                finish_reason=finish_reason,
                completion_tokens=usage.get("completion_tokens"),
                reasoning_tokens=details.get("reasoning_tokens"),
                reasoning_len=len(reasoning),
                thinking_disabled=used_disable,
            )
        except Exception as exc:
            logger.warning("LLM vision call failed (%s): %s", type(exc).__name__, exc)
            return VisionOutcome(provider=self.provider_name, error=f"{type(exc).__name__}: {exc}")

    def chat_json(
        self,
        system_prompt: str,
        user_prompt: str,
        timeout_s: float | None = None,
        max_tokens: int = 900,
        temperature: float = 0.3,
    ) -> LLMOutcome:
        if not self.available:
            return LLMOutcome(provider="template", error="llm_not_configured")
        base = (self.settings.llm_base_url or "").rstrip("/")
        url = f"{base}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.settings.llm_api_key:
            headers["Authorization"] = f"Bearer {self.settings.llm_api_key}"
        payload = {
            "model": self.settings.llm_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        timeout = timeout_s or self.settings.llm_timeout_s
        try:
            response = httpx.post(url, headers=headers, json=payload, timeout=timeout)
            response.raise_for_status()
            body = response.json()
            content = body["choices"][0]["message"]["content"]
            data = _loads_json(content)
            if data is None:
                return LLMOutcome(provider=self.provider_name, error="invalid_json")
            return LLMOutcome(provider=self.provider_name, data=data)
        except Exception as exc:
            logger.warning("LLM call failed (%s): %s", type(exc).__name__, exc)
            return LLMOutcome(provider="template", error=f"{type(exc).__name__}: {exc}")


_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def _loads_json(content: str) -> dict | None:
    if not content:
        return None
    text = content.strip()
    match = _FENCE_RE.search(text)
    if match:
        text = match.group(1).strip()
    try:
        data = json.loads(text)
    except Exception:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            data = json.loads(text[start : end + 1])
        except Exception:
            return None
    return data if isinstance(data, dict) else None
