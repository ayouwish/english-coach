"""Provider 调用的超时与兜底执行。

契约 §8「降级优先于报错」：provider 抛错/超时都必须尽量产出结果 + warnings，
只有在完全无法产出（例如音频根本解不开）时才报错。
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

from .errors import ProviderError, ProviderTimeout, VoiceError

logger = logging.getLogger("voice.execution")

_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="voice-provider")

# 契约 §9 的 provider 侧超时（秒）
TIMEOUTS = {
    "asr": 25.0,
    "pronounce": 50.0,
    "tts": 15.0,
    "feedback": 30.0,
    "dialogue": 30.0,
}


def call_with_timeout(fn, timeout_s: float, provider: str = ""):
    future = _EXECUTOR.submit(fn)
    try:
        return future.result(timeout=timeout_s)
    except FutureTimeout as exc:
        future.cancel()
        raise ProviderTimeout(f"provider {provider or '?'} timed out after {timeout_s:.0f}s", provider=provider) from exc
    except VoiceError:
        raise
    except Exception as exc:  # provider 内部任何异常都归一化为 provider_error
        raise ProviderError(f"provider {provider or '?'} failed: {type(exc).__name__}: {exc}", provider=provider) from exc


def run_chain(chain, fn_factory, timeout_s: float, kind: str = "provider"):
    """依次尝试调用链，返回 (result, provider_name, used_fallback, errors)。

    全部失败时返回 ``(None, None, True, errors)``，由调用方决定最终降级策略。
    """
    errors: list[str] = []
    names = [getattr(p, "name", "?") for p in chain]
    for index, provider in enumerate(chain):
        name = getattr(provider, "name", "?")
        try:
            result = call_with_timeout(lambda p=provider: fn_factory(p), timeout_s, provider=name)
            return result, name, index > 0, errors
        except VoiceError as exc:
            message = f"{name}:{exc.code}:{exc.message}"
            errors.append(message)
            logger.warning("provider %s failed for %s: %s", name, kind, message)
        except Exception as exc:  # 保险：provider 不该抛出的异常也不能把请求打成 500
            message = f"{name}:unexpected:{type(exc).__name__}:{exc}"
            errors.append(message)
            logger.warning("provider %s crashed for %s: %s", name, kind, message)
    return None, (names[0] if names else None), True, errors
