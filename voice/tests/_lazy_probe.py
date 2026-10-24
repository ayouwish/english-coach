"""在**干净解释器**里验证惰性导入（不受同进程其它用例 / 本机是否装了 SDK 影响）。"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

LAZY_PROBE = """
import sys
import app.providers.azure  # 只导入我们自己的模块，不应拉起 azure SDK
from fastapi.testclient import TestClient
from app.main import app

with TestClient(app) as client:
    response = client.get('/v1/health')
    assert response.status_code == 200, response.status_code
    assert response.json()['providers']['asr'] == 'mock'

forbidden = sorted(
    name for name in sys.modules
    if name == 'azure' or name.startswith('azure.') or name in ('faster_whisper', 'edge_tts')
)
assert not forbidden, forbidden
print('LAZY_OK')
"""


def probe_env(tmp_path: Path) -> dict:
    """把开发机上的 .env（可能有真实密钥）彻底隔离掉，并强制 mock 模式。"""
    env = {
        **os.environ,
        "PROVIDER_MODE": "mock",
        "ENV_FILE": str(tmp_path / "nonexistent.env"),
        "DATA_DIR": str(tmp_path),
        "MODEL_CACHE_DIR": str(tmp_path / "models"),
    }
    for key in ("AZURE_SPEECH_KEY", "VOICE_PA_PROVIDER", "VOICE_ASR_PROVIDER", "VOICE_TTS_PROVIDER", "VOICE_LLM_PROVIDER"):
        env.pop(key, None)
    return env


def run_probe(tmp_path: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", LAZY_PROBE],
        cwd=ROOT,
        env=probe_env(tmp_path),
        capture_output=True,
        text=True,
        timeout=180,
    )
