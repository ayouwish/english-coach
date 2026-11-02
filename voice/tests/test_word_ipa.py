"""task-86：GET /v1/words/ipa（cmudict → IPA，惰性加载，不联网）。"""

from __future__ import annotations

import sys

from app.errors import BadRequest, NotFound
from app.word_ipa import MAX_WORD_CHARS, word_ipa


def _ipa_chars(text: str) -> bool:
    return any(ord(char) > 127 for char in text)


def test_cmudict_not_loaded_at_startup_or_health(client):
    """冷启动不加载 12.6 万词词典：import app.main / /v1/health 都不应 import cmudict。"""
    assert "cmudict" not in sys.modules, "启动阶段不应加载 cmudict"
    health = client.get("/v1/health")
    assert health.status_code == 200
    assert health.json()["capabilities"]["word_ipa"] is True
    assert "cmudict" not in sys.modules, "/v1/health 也不应加载词典"

    # 第一次真正查询才惰性加载
    response = client.get("/v1/words/ipa", params={"word": "think"})
    assert response.status_code == 200, response.text
    assert "cmudict" in sys.modules, "首次查询后词典应被加载"


def test_think_exact_ipa(client):
    body = client.get("/v1/words/ipa", params={"word": "think"}).json()
    assert body == {
        "word": "think",
        "ipa": "θɪŋk",
        "variants": ["θɪŋk"],
        "source": "cmudict",
        "syllables": 1,
    }


def test_hello_has_stress_mark_and_variants(client):
    body = client.get("/v1/words/ipa", params={"word": "hello"}).json()
    assert body["source"] == "cmudict"
    assert body["ipa"].startswith("hə") and "ˈ" in body["ipa"], body["ipa"]
    assert body["ipa"] == body["variants"][0]
    assert 1 <= len(body["variants"]) <= 2
    assert len(body["variants"]) == len(set(body["variants"]))
    assert body["syllables"] == 2


def test_either_multiple_variants_deduped(client):
    body = client.get("/v1/words/ipa", params={"word": "either"}).json()
    assert len(body["variants"]) == 2, body["variants"]
    assert len(set(body["variants"])) == 2
    assert {"ˈiðər", "ˈaɪðər"} == set(body["variants"])


def test_common_words_non_empty_and_ipa_chars(client):
    # 有些词纯 ASCII 音素（如 school→skul）也合法，所以只要求非空 + 无大写/数字
    for word in ("world", "rhythm", "comfortable", "school", "friend", "beautiful"):
        body = client.get("/v1/words/ipa", params={"word": word}).json()
        assert body["ipa"], word
        assert body["ipa"].islower() and " " not in body["ipa"], body["ipa"]
        assert body["syllables"] >= 1
    # 含 IPA 专有字符的词
    for word in ("world", "rhythm", "comfortable", "think"):
        body = client.get("/v1/words/ipa", params={"word": word}).json()
        assert _ipa_chars(body["ipa"]), (word, body["ipa"])


def test_case_insensitive_and_punctuation(client):
    lower = client.get("/v1/words/ipa", params={"word": "hello"}).json()
    upper = client.get("/v1/words/ipa", params={"word": "HELLO"}).json()
    assert upper["word"] == "hello" and upper["ipa"] == lower["ipa"]

    apostrophe = client.get("/v1/words/ipa", params={"word": "don't"}).json()
    assert apostrophe["word"] == "don't" and apostrophe["ipa"]

    hyphen = client.get("/v1/words/ipa", params={"word": "well-known"}).json()
    assert hyphen["word"] == "well-known" and _ipa_chars(hyphen["ipa"])
    assert hyphen["syllables"] >= 2


def test_word_not_found_returns_404(client):
    response = client.get("/v1/words/ipa", params={"word": "qqqqzzz"})
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "not_found"
    assert "词典里没有这个词" in body["error"]["message"]


def test_invalid_words_return_400(client):
    for word in ("", "   ", "123", "hello world", "你好", "t" * (MAX_WORD_CHARS + 1)):
        response = client.get("/v1/words/ipa", params={"word": word})
        assert response.status_code == 400, (word, response.text)
        assert response.json()["error"]["code"] == "bad_request"

    missing = client.get("/v1/words/ipa")
    assert missing.status_code == 400


def test_dictionary_is_full_cmudict(client):
    from app.word_ipa import _dictionary

    assert len(_dictionary()) > 120_000, "必须是全量 cmudict（不裁剪）"


def test_error_classes():
    import pytest

    with pytest.raises(BadRequest):
        word_ipa("")
    with pytest.raises(NotFound):
        word_ipa("qqqqzzz")
