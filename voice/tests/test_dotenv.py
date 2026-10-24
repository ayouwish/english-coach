"""`.env` 解析与加载的回归测试。

背景（这是真实踩到的坑，不是假想）：
`voice/.env.example` 里每一行都带行内注释，例如
`PROVIDER_MODE=mock            # mock | local | cloud | hybrid`。
如果解析时把 `# ...` 当成值的一部分：
  · `PROVIDER_MODE` 变成非法枚举 → 服务永远走不到云模式（静默降级）；
  · `AZURE_SPEECH_KEY` 带上中文注释 → Azure 认证失败。
两者都不报错，只表现为"配好了却不生效"。这些用例把这个行为钉死。
"""

from __future__ import annotations

import os

import pytest

from app.config import _load_dotenv, _parse_env_line


class TestParseLine:
    def test_plain_pair(self):
        assert _parse_env_line("FOO=bar") == ("FOO", "bar")

    def test_spaces_around_equals(self):
        assert _parse_env_line("FOO = bar") == ("FOO", "bar")
        assert _parse_env_line("  FOO   =   bar  ") == ("FOO", "bar")

    def test_inline_comment_stripped(self):
        # 这正是 .env.example 的写法，也是最容易出错的地方
        assert _parse_env_line("PROVIDER_MODE=mock            # mock | local | cloud | hybrid") == (
            "PROVIDER_MODE",
            "mock",
        )
        assert _parse_env_line("CACHE_MAX_BYTES=524288000     # 500MB") == ("CACHE_MAX_BYTES", "524288000")

    def test_inline_comment_with_chinese_and_key(self):
        key, value = _parse_env_line("AZURE_SPEECH_KEY=abc123XYZ   # 密钥；必填（云模式）。切勿提交到 git")
        assert key == "AZURE_SPEECH_KEY"
        assert value == "abc123XYZ"
        assert "#" not in value

    def test_hash_inside_value_is_preserved(self):
        # 没有前置空白的 # 属于值本身（例如含 # 的密钥），不能截断
        assert _parse_env_line("PASSWORD=ab#cd") == ("PASSWORD", "ab#cd")

    def test_quoted_values(self):
        assert _parse_env_line('FOO="bar baz"') == ("FOO", "bar baz")
        assert _parse_env_line("FOO='bar baz'") == ("FOO", "bar baz")
        # 引号内的 # 不是注释
        assert _parse_env_line('FOO="bar # baz"') == ("FOO", "bar # baz")

    def test_export_prefix(self):
        assert _parse_env_line("export FOO=bar") == ("FOO", "bar")

    def test_whole_line_comments_and_blanks_ignored(self):
        assert _parse_env_line("# ---- 通用 ----") is None
        assert _parse_env_line("   # comment") is None
        assert _parse_env_line("") is None
        assert _parse_env_line("   ") is None
        assert _parse_env_line("NO_EQUALS_HERE") is None

    def test_empty_value_is_kept(self):
        assert _parse_env_line("FOO=") == ("FOO", "")


class TestLoadDotenv:
    def _write(self, tmp_path, text: str):
        p = tmp_path / ".env"
        p.write_text(text, encoding="utf-8")
        return p

    def test_loads_and_strips_comments(self, tmp_path, monkeypatch):
        path = self._write(
            tmp_path,
            "# 注释行\n"
            "SELFTEST_MODE=hybrid            # mock | local | cloud | hybrid\n"
            "SELFTEST_KEY=secret123   # 密钥；必填\n",
        )
        monkeypatch.delenv("SELFTEST_MODE", raising=False)
        monkeypatch.delenv("SELFTEST_KEY", raising=False)
        monkeypatch.setenv("ENV_FILE", str(path))
        _load_dotenv()
        assert os.environ["SELFTEST_MODE"] == "hybrid"
        assert os.environ["SELFTEST_KEY"] == "secret123"

    def test_real_env_wins_over_file(self, tmp_path, monkeypatch):
        path = self._write(tmp_path, "SELFTEST_EXISTING=from_file\n")
        monkeypatch.setenv("SELFTEST_EXISTING", "from_real_env")
        monkeypatch.setenv("ENV_FILE", str(path))
        _load_dotenv()
        assert os.environ["SELFTEST_EXISTING"] == "from_real_env"

    def test_missing_file_is_silent(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ENV_FILE", str(tmp_path / "nope.env"))
        assert _load_dotenv() is None

    def test_parsed_mode_is_a_valid_enum(self, tmp_path, monkeypatch):
        """回归：带行内注释的 PROVIDER_MODE 必须仍然是合法枚举。"""
        from app.config import MODES

        path = self._write(tmp_path, "SELFTEST_PROVIDER=hybrid            # mock | local | cloud | hybrid\n")
        monkeypatch.delenv("SELFTEST_PROVIDER", raising=False)
        monkeypatch.setenv("ENV_FILE", str(path))
        _load_dotenv()
        assert os.environ["SELFTEST_PROVIDER"] in MODES


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
