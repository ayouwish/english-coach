"""Runtime configuration (env-var driven).

设计约束（见 docs/api-contract.md 与 task-1）：
- 环境里**没有任何** API key，所以 ``PROVIDER_MODE`` 默认 ``mock``，全链路离线可跑。
- azure / faster-whisper / edge-tts 只在真正被选中的 provider 内部**惰性导入**。
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

VOICE_DIR = Path(__file__).resolve().parent.parent

logger = logging.getLogger(__name__)


def _parse_env_line(line: str) -> tuple[str, str] | None:
    """解析一行 .env：支持 `KEY=value`、`KEY = value`、引号，以及**行内注释**。

    行内注释必须剥掉。`.env.example` 里写的是
    `PROVIDER_MODE=mock            # mock | local | cloud | hybrid`，
    如果把 `# ...` 当成值的一部分：
      · `PROVIDER_MODE` 会变成非法枚举 → 服务永远走不到云模式；
      · `AZURE_SPEECH_KEY` 会带上中文注释 → 认证必然失败。
    这类错误**不报错**，只会让人以为"配好了却不生效"，所以必须在这里剥干净。
    """
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[len("export ") :].lstrip()
    if "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    if not key:
        return None
    value = value.strip()
    if value[:1] in ("'", '"'):
        # 引号形式：取配对引号内的内容，引号之后的东西（通常是行内注释）一律忽略。
        # 必须先处理引号再处理注释，否则 `FOO="bar # baz"` 会被 # 截断。
        quote = value[0]
        end = value.find(quote, 1)
        value = value[1:end] if end != -1 else value[1:]
    else:
        # 只有**空白之后**的 # 才算行内注释，避免截断含 # 的合法值（如密码里的 #）
        for i, ch in enumerate(value):
            if ch == "#" and i > 0 and value[i - 1] in " \t":
                value = value[:i].rstrip()
                break
    return key, value


def _load_dotenv() -> Path | None:
    """加载 `voice/.env`（可用 `ENV_FILE` 指定其它路径）。

    规则：
    - **`ENV_FILE` 是权威设定**：显式指定了就只用它，不再回退到 `voice/.env`。
      这样测试可以用 `ENV_FILE=<不存在的路径>` 彻底隔离，不会被开发者本机的真实 `.env` 污染；
    - **已存在的真实环境变量优先**，文件不覆盖它（compose / systemd / shell 注入的赢）；
    - 文件不存在就静默跳过（生产环境通常用真实环境变量）。
    """
    explicit = os.environ.get("ENV_FILE")
    candidates = (
        [Path(explicit).expanduser()] if explicit else [VOICE_DIR / ".env"]
    )

    for path in candidates:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:  # pragma: no cover - 权限问题不应让服务起不来
            logger.warning("无法读取 %s，跳过", path)
            continue
        loaded = skipped = 0
        for line in text.splitlines():
            parsed = _parse_env_line(line)
            if parsed is None:
                continue
            key, value = parsed
            if key in os.environ:
                skipped += 1
                continue
            os.environ[key] = value
            loaded += 1
        logger.info("已从 %s 加载 %d 个环境变量（%d 个因已存在而跳过）", path, loaded, skipped)
        return path
    return None


_load_dotenv()

MODES = ("mock", "local", "cloud", "hybrid")
PROVIDER_NAMES = ("mock", "local", "azure", "xfyun")


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name)
    if raw is None:
        return default
    return raw.lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".voice-write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except Exception:
        return False


def _resolve_data_dir() -> Path:
    raw = _env("DATA_DIR") or _env("VOICE_DATA_DIR")
    if raw:
        return Path(raw).expanduser().resolve()
    return (VOICE_DIR / "data").resolve()


def _resolve_model_cache_dir() -> Path:
    raw = _env("MODEL_CACHE_DIR")
    if raw:
        candidate = Path(raw).expanduser()
        if _writable(candidate):
            return candidate.resolve()
    default = Path("/models")
    if _writable(default):
        return default
    fallback = VOICE_DIR / ".model-cache"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback.resolve()


def _llm_provider_name(base_url: str | None, api_key: str | None, configured: str | None) -> str:
    """Return the reported LLM provider name (also used in the ``provider`` response field)."""
    if configured and configured not in ("auto", "template"):
        return configured
    low = (base_url or "").lower()
    if "deepseek" in low:
        return "deepseek"
    if "ollama" in low or ":11434" in low:
        return "ollama"
    if "openai" in low:
        return "openai"
    if api_key:
        return "openai_compatible"
    return "template"


def _llm_configured(base_url: str | None, api_key: str | None) -> bool:
    """LLM is usable when a key exists, or when a local OpenAI-compatible server is named."""
    if api_key:
        return True
    low = (base_url or "").lower()
    return any(tok in low for tok in ("localhost", "127.0.0.1", "ollama", ":11434", "host.docker.internal"))


def _resolve_providers(mode: str) -> tuple[str, str, str, str]:
    """-> (asr, pa, tts, llm) provider names for the given mode (before env overrides)."""
    azure_ready = bool(_env("AZURE_SPEECH_KEY"))
    if mode == "mock":
        return "mock", "mock", "mock", "template"
    if mode == "local":
        return "local", "local", "local", "template"
    if mode == "cloud":
        return "azure", "azure", "azure", "template"
    # hybrid: 云为主 + 本地兜底（无 key 时自动退到本地/离线实现）
    if azure_ready:
        return "azure", "azure", "azure", "template"
    return "local", "local", "mock", "template"


@dataclass(frozen=True)
class Settings:
    version: str = "0.1.0"
    mode: str = "mock"
    host: str = "0.0.0.0"
    port: int = 8100

    asr_provider: str = "mock"
    pa_provider: str = "mock"
    tts_provider: str = "mock"
    llm_provider: str = "template"

    azure_speech_key: str | None = None
    azure_speech_region: str | None = None
    azure_speech_endpoint: str | None = None
    azure_tts_voice: str = "en-US-JennyNeural"

    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str = "deepseek-chat"
    llm_timeout_s: float = 30.0
    llm_enabled: bool = False

    whisper_model: str = "tiny"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    edge_tts_voice: str = "en-US-JennyNeural"

    default_tts_voice: str = "en-US-JennyNeural"
    max_tts_chars: int = 2000
    max_upload_bytes: int = 25 * 1024 * 1024
    max_audio_seconds: float = 120.0

    data_dir: Path = field(default_factory=_resolve_data_dir)
    model_cache_dir: Path = field(default_factory=_resolve_model_cache_dir)

    # 参考音 / 参考 F0 缓存（契约 v1.1 §12）
    cache_enabled: bool = True
    cache_max_bytes: int = 500 * 1024 * 1024
    cache_max_entries: int = 2000
    warmup_max_items: int = 500
    warmup_default_concurrency: int = 2

    gpu: bool = False

    @property
    def audio_dir(self) -> Path:
        path = self.data_dir / "audio"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def cache_dir(self) -> Path:
        path = self.data_dir / "cache"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def capabilities(self) -> dict:
        pa = self.pa_provider
        return {
            "phoneme_level": pa in ("azure", "mock", "xfyun"),
            "prosody": pa in ("azure", "mock"),
            "intonation_curve": True,
            "nbest_phonemes": pa in ("azure", "mock"),
            "ssml": self.tts_provider == "azure",
            "gpu": self.gpu,
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    mode = (_env("PROVIDER_MODE", "mock") or "mock").lower()
    if mode not in MODES:
        mode = "mock"
    asr, pa, tts, llm = _resolve_providers(mode)

    asr = (_env("VOICE_ASR_PROVIDER") or asr).lower()
    pa = (_env("VOICE_PA_PROVIDER") or pa).lower()
    tts = (_env("VOICE_TTS_PROVIDER") or tts).lower()

    base_url = _env("LLM_BASE_URL") or _env("OLLAMA_BASE_URL")
    if base_url and not base_url.rstrip("/").endswith(("/v1", "/api")) and ":11434" in base_url:
        base_url = base_url.rstrip("/") + "/v1"
    api_key = _env("LLM_API_KEY")
    llm_enabled = _llm_configured(base_url, api_key)
    llm_configured = _env("VOICE_LLM_PROVIDER")
    llm_name = _llm_provider_name(base_url, api_key, llm_configured)
    # 没有可用端点（无 key 且非本地 ollama）-> provider 字段必须如实报 "template"
    llm = llm_name if llm_enabled else "template"

    model = _env("LLM_MODEL") or _env("OLLAMA_MODEL") or "deepseek-chat"

    return Settings(
        version=_env("VOICE_VERSION", "0.1.0") or "0.1.0",
        mode=mode,
        host=_env("VOICE_HOST", "0.0.0.0") or "0.0.0.0",
        port=_env_int("VOICE_PORT", 8100),
        asr_provider=asr,
        pa_provider=pa,
        tts_provider=tts,
        llm_provider=llm if llm_enabled else llm_name_for_report if llm_enabled else "template",
        azure_speech_key=_env("AZURE_SPEECH_KEY"),
        azure_speech_region=_env("AZURE_SPEECH_REGION"),
        azure_speech_endpoint=_env("AZURE_SPEECH_ENDPOINT"),
        azure_tts_voice=_env("AZURE_TTS_VOICE", "en-US-JennyNeural") or "en-US-JennyNeural",
        llm_base_url=base_url,
        llm_api_key=api_key,
        llm_model=model,
        llm_timeout_s=_env_float("LLM_TIMEOUT_S", 30.0),
        llm_enabled=llm_enabled,
        whisper_model=_env("WHISPER_MODEL", "tiny") or "tiny",
        whisper_device=_env("WHISPER_DEVICE", "cpu") or "cpu",
        whisper_compute_type=_env("WHISPER_COMPUTE_TYPE", "int8") or "int8",
        edge_tts_voice=_env("EDGE_TTS_VOICE", "en-US-JennyNeural") or "en-US-JennyNeural",
        default_tts_voice=_env("DEFAULT_TTS_VOICE", "en-US-JennyNeural") or "en-US-JennyNeural",
        max_tts_chars=_env_int("MAX_TTS_CHARS", 2000),
        max_upload_bytes=_env_int("MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
        max_audio_seconds=_env_float("VOICE_MAX_AUDIO_SECONDS", 120.0),
        data_dir=_resolve_data_dir(),
        model_cache_dir=_resolve_model_cache_dir(),
        cache_enabled=_env_bool("CACHE_ENABLED", True),
        cache_max_bytes=_env_int("CACHE_MAX_BYTES", 500 * 1024 * 1024),
        cache_max_entries=_env_int("CACHE_MAX_ENTRIES", 2000),
        warmup_max_items=_env_int("WARMUP_MAX_ITEMS", 500),
        warmup_default_concurrency=_env_int("WARMUP_CONCURRENCY", 2),
        gpu=_env_bool("VOICE_GPU", False),
    )


def reset_settings_cache() -> None:
    get_settings.cache_clear()
