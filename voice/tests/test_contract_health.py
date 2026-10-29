"""契约 §1：/v1/health 与 provider 惰性导入。"""

from __future__ import annotations

import sys

MODES = {"mock", "local", "cloud", "hybrid"}
CAPABILITY_KEYS = {"phoneme_level", "prosody", "intonation_curve", "nbest_phonemes", "ssml", "gpu", "ocr", "ocr_provider", "heic"}
PROVIDER_KEYS = {"asr", "pa", "tts", "llm"}


def test_health_shape_and_defaults(client):
    response = client.get("/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"status", "version", "mode", "providers", "capabilities"}
    assert body["status"] == "ok"
    assert body["version"] == "0.1.0"
    assert body["mode"] in MODES
    assert body["mode"] == "mock"  # 无任何密钥时的默认值
    assert set(body["providers"]) == PROVIDER_KEYS
    assert body["providers"]["llm"] == "template"  # 无 key -> 模板降级
    assert set(body["capabilities"]) == CAPABILITY_KEYS
    assert body["capabilities"]["intonation_curve"] is True
    assert body["capabilities"]["gpu"] is False
    assert isinstance(body["capabilities"]["phoneme_level"], bool)


def test_health_needs_no_auth(client):
    response = client.get("/v1/health", headers={})  # compose healthcheck 不带 token
    assert response.status_code == 200


def test_azure_sdk_is_lazy_imported(tmp_path):
    """azure SDK 必须惰性导入：启动服务 + 处理 mock 请求都不能把它拉起来。

    在**干净解释器**里检查（同进程里别的用例可能已经因为真实调用 import 过 SDK，
    而且本机现在也装了 azure 包，所以进程内断言会假失败）。
    """
    from tests._lazy_probe import run_probe

    result = run_probe(tmp_path)
    assert result.returncode == 0, result.stderr
    assert "LAZY_OK" in result.stdout


def test_faster_whisper_not_imported(client):
    assert "faster_whisper" not in sys.modules
    assert "edge_tts" not in sys.modules
