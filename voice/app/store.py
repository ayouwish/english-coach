"""示范音频（TTS 产物）的落盘与只读访问。

契约 §7：``audio_id`` 由 voice 生成，形如 ``ref_<sha1前12位>.<ext>``；只读、可缓存 7 天。
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .errors import AudioNotFound, BadRequest

AUDIO_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,80}\.(wav|mp3|ogg|m4a|opus|webm)$")

CONTENT_TYPES = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".opus": "audio/ogg",
    ".webm": "audio/webm",
}

CACHE_CONTROL = "public, max-age=604800"


class AudioStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def make_audio_id(data: bytes, ext: str = "wav", prefix: str = "ref") -> str:
        digest = hashlib.sha1(data).hexdigest()[:12]
        return f"{prefix}_{digest}.{ext.lstrip('.')}"

    def save(self, data: bytes, ext: str = "wav", prefix: str = "ref") -> str:
        audio_id = self.make_audio_id(data, ext=ext, prefix=prefix)
        path = self.root / audio_id
        if not path.exists():
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        return audio_id

    def validate_id(self, audio_id: str) -> str:
        if not AUDIO_ID_RE.match(audio_id or ""):
            raise BadRequest(f"invalid audio id: {audio_id!r}")
        return audio_id

    def path_for(self, audio_id: str, must_exist: bool = True) -> Path:
        safe = self.validate_id(audio_id)
        root = self.root.resolve()
        path = (root / safe).resolve()
        if root not in path.parents and path.parent != root:
            raise BadRequest("invalid audio id")
        if must_exist and not path.is_file():
            raise AudioNotFound(f"audio not found: {safe}")
        return path

    def read(self, audio_id: str) -> tuple[bytes, str]:
        path = self.path_for(audio_id)
        return path.read_bytes(), CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")

    @staticmethod
    def url_for(audio_id: str) -> str:
        return f"/voice/v1/audio/{audio_id}"
