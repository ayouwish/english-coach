"""pytest 公共 fixture：强制 mock 模式 + 临时数据目录，保证测试离线可复现。"""

from __future__ import annotations

import os
import shutil
import tempfile

import pytest

_TMP_ROOT = tempfile.mkdtemp(prefix="voice-tests-")

# 测试必须完全离线且与开发者本机无关：把 ENV_FILE 指到一个不存在的路径，
# 这样 app.config 的 _load_dotenv() 不会去读真实的 voice/.env
# （否则本机配好的 PROVIDER_MODE=hybrid / AZURE_SPEECH_KEY 会被加载进测试环境）。
os.environ["ENV_FILE"] = os.path.join(_TMP_ROOT, "no-such.env")
os.environ["PROVIDER_MODE"] = "mock"
os.environ["DATA_DIR"] = os.path.join(_TMP_ROOT, "data")
os.environ["MODEL_CACHE_DIR"] = os.path.join(_TMP_ROOT, "models")
os.environ.pop("AZURE_SPEECH_KEY", None)
os.environ.pop("LLM_API_KEY", None)
os.environ.pop("LLM_BASE_URL", None)
os.environ.pop("OLLAMA_BASE_URL", None)
os.environ.pop("VOICE_ASR_PROVIDER", None)
os.environ.pop("VOICE_PA_PROVIDER", None)
os.environ.pop("VOICE_TTS_PROVIDER", None)
os.environ.pop("VOICE_LLM_PROVIDER", None)

from fastapi.testclient import TestClient  # noqa: E402

from app.cache import get_cache, reset_cache  # noqa: E402
from app.config import reset_settings_cache  # noqa: E402
from app.main import app as fastapi_app  # noqa: E402
from app.providers.registry import reset_providers  # noqa: E402
from app.synth import sweep_wav, synthesize_speech_wav, tone_wav  # noqa: E402


def pytest_sessionfinish(session, exitstatus):  # noqa: ANN001
    shutil.rmtree(_TMP_ROOT, ignore_errors=True)


@pytest.fixture(scope="session")
def client():
    reset_settings_cache()
    reset_providers()
    reset_cache()
    with TestClient(fastapi_app) as test_client:
        yield test_client


def _clear_image_cache() -> None:
    """清掉文生图缓存（task-52：图片缓存不在 WarmupCache 里，单独清）。"""
    import shutil

    from app.config import get_settings

    images_dir = get_settings().data_dir / "cache" / "images"
    if images_dir.is_dir():
        shutil.rmtree(images_dir, ignore_errors=True)


@pytest.fixture(autouse=True)
def _clean_caches():
    """每个用例开始前清掉进程内单例与磁盘缓存，避免用例之间互相命中（顺序无关）。"""
    reset_settings_cache()
    reset_providers()
    reset_cache()
    get_cache().clear()
    _clear_image_cache()
    yield
    reset_settings_cache()
    reset_providers()
    reset_cache()
    _clear_image_cache()


@pytest.fixture
def tone() -> bytes:
    return tone_wav(180.0, 1.0)


@pytest.fixture
def sweep() -> bytes:
    return sweep_wav(150.0, 250.0, 1.2)


@pytest.fixture
def speech() -> bytes:
    return synthesize_speech_wav("I think the weather is really nice today.", voice="en-US-JennyNeural")


def audio_files(payload: bytes):
    return {"audio": ("clip.wav", payload, "audio/wav")}


def post_pronounce(client, audio: bytes, reference_text: str = "I think the weather is really nice today.", **data):
    form = {"reference_text": reference_text}
    form.update({k: (str(v).lower() if isinstance(v, bool) else v) for k, v in data.items()})
    return client.post("/v1/pronounce", files=audio_files(audio), data=form)
