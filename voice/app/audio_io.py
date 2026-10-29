"""音频解码与编码：统一走 PyAV（主机没有系统 ffmpeg），内部标准为 16kHz 单声道 PCM16。"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass

import av
import numpy as np

from .errors import AudioTooLong, UnsupportedAudio

TARGET_SR = 16000


class AudioClip:
    """解码后的 16k mono float32 波形。"""

    __slots__ = ("samples", "sample_rate")

    def __init__(self, samples: np.ndarray, sample_rate: int = TARGET_SR):
        self.samples = np.ascontiguousarray(samples, dtype=np.float32).reshape(-1)
        self.sample_rate = int(sample_rate)

    @property
    def duration_s(self) -> float:
        if self.sample_rate <= 0:
            return 0.0
        return float(self.samples.size) / float(self.sample_rate)

    @property
    def duration_ms(self) -> int:
        return int(round(self.duration_s * 1000.0))

    @property
    def is_silent(self) -> bool:
        if self.samples.size == 0:
            return True
        return bool(np.max(np.abs(self.samples)) < 1e-4)

    def rms_frames(self, frame_ms: int = 20) -> np.ndarray:
        """按 frame_ms 切窗的 RMS 包络。"""
        hop = max(1, int(self.sample_rate * frame_ms / 1000))
        n = self.samples.size
        if n == 0:
            return np.zeros(0, dtype=np.float64)
        count = max(1, int(np.ceil(n / hop)))
        out = np.zeros(count, dtype=np.float64)
        for idx in range(count):
            chunk = self.samples[idx * hop : (idx + 1) * hop]
            if chunk.size:
                out[idx] = float(np.sqrt(np.mean(np.square(chunk, dtype=np.float64))))
        return out

    def to_wav_bytes(self) -> bytes:
        return pcm16_wav_bytes(self.samples, self.sample_rate)

    def resampled(self, target_sr: int) -> "AudioClip":
        if target_sr == self.sample_rate or self.samples.size == 0:
            return self
        ratio = target_sr / float(self.sample_rate)
        count = int(round(self.samples.size * ratio))
        if count <= 0:
            return AudioClip(np.zeros(0, dtype=np.float32), target_sr)
        src_idx = np.linspace(0.0, self.samples.size - 1, num=count)
        return AudioClip(np.interp(src_idx, np.arange(self.samples.size), self.samples), target_sr)


def pcm16_wav_bytes(samples: np.ndarray, sample_rate: int = TARGET_SR) -> bytes:
    """用标准库写 PCM16 WAV（不依赖 soundfile/scipy）。"""
    arr = np.clip(np.asarray(samples, dtype=np.float32).reshape(-1), -1.0, 1.0)
    pcm = (arr * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def _parse_wav_pcm16_mono(audio: bytes) -> tuple[int, np.ndarray] | None:
    """解析 16-bit 单声道 PCM WAV -> (sample_rate, int16 samples)；不是这种格式返回 None。"""
    import wave

    try:
        with wave.open(io.BytesIO(audio), "rb") as wf:
            if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
                return None
            sample_rate = int(wf.getframerate())
            raw = wf.readframes(wf.getnframes())
    except Exception:
        return None
    if sample_rate <= 0 or len(raw) < 2:
        return None
    return sample_rate, np.frombuffer(raw, dtype="<i2")


def trim_wav_silence(
    audio: bytes,
    threshold_db: float = -50.0,
    keep_ms: int = 50,
) -> tuple[bytes, bool]:
    """裁掉 WAV(PCM16 mono) 首尾的静音/低电平噪声。-> (新字节, 是否裁剪)

    背景（task-39）：Azure 对短词（如 "think"）返回的 WAV 总长 1.82s，真正语音只有 0.19s，
    尾部 ~1.3s 是 ≈-64dB 的低电平噪声 → 听感"词一闪就没了，然后一段空白/底噪"。
    这里按 **frame RMS >= -50dBFS** 判定语音帧，前后各留 `keep_ms` 余量（默认 50ms，
    避免削掉真实的轻声收尾/起始气声）；整段都低于阈值（异常）或裁不出更短的音频时**原样返回**。
    """
    parsed = _parse_wav_pcm16_mono(audio)
    if parsed is None:
        return audio, False
    sample_rate, samples = parsed
    if samples.size == 0:
        return audio, False

    frame = max(1, int(round(sample_rate * 0.01)))  # 10ms 一帧
    usable = (samples.size // frame) * frame
    if usable == 0:
        return audio, False
    blocks = samples[:usable].astype(np.float64).reshape(-1, frame) / 32768.0
    rms = np.sqrt((blocks**2).mean(axis=1))
    threshold = 10.0 ** (float(threshold_db) / 20.0)
    active = np.flatnonzero(rms >= threshold)
    if active.size == 0:
        return audio, False  # 整段低于阈值：不裁（异常输入，保持原样）

    keep = int(round(sample_rate * max(0, keep_ms) / 1000.0))
    start = max(0, int(active[0]) * frame - keep)
    end = min(samples.size, (int(active[-1]) + 1) * frame + keep)
    if start == 0 and end >= samples.size:
        return audio, False
    trimmed = samples[start:end]
    if trimmed.size < sample_rate * 0.01:  # 裁完不足 10ms → 不动（防裁坏极短音频）
        return audio, False
    return pcm16_wav_bytes(trimmed.astype(np.float32) / 32768.0, sample_rate), True


def wav_speech_span_ms(audio: bytes, threshold_db: float = -50.0) -> tuple[int, int, int] | None:
    """统计 WAV 的语音段：-> (start_ms, end_ms, speech_ms)；非 PCM16 mono 返回 None。"""
    parsed = _parse_wav_pcm16_mono(audio)
    if parsed is None:
        return None
    sample_rate, samples = parsed
    if samples.size == 0:
        return None
    frame = max(1, int(round(sample_rate * 0.01)))
    usable = (samples.size // frame) * frame
    if usable == 0:
        return None
    blocks = samples[:usable].astype(np.float64).reshape(-1, frame) / 32768.0
    rms = np.sqrt((blocks**2).mean(axis=1))
    active = np.flatnonzero(rms >= 10.0 ** (float(threshold_db) / 20.0))
    if active.size == 0:
        return None
    start_ms = int(round(int(active[0]) * frame / sample_rate * 1000))
    end_ms = int(round((int(active[-1]) + 1) * frame / sample_rate * 1000))
    return start_ms, end_ms, max(0, end_ms - start_ms)


def decode_audio(data: bytes, target_sr: int = TARGET_SR, max_seconds: float | None = None) -> AudioClip:
    """把任意上传音频（webm/opus、wav、mp4、ogg...）解码成 16k mono float32。

    只用 PyAV（wheel 自带 FFmpeg），不调用系统 ffmpeg。
    """
    if not data:
        raise UnsupportedAudio("empty audio payload")
    chunks: list[np.ndarray] = []
    try:
        with av.open(io.BytesIO(data)) as container:
            streams = [s for s in container.streams if s.type == "audio"]
            if not streams:
                raise UnsupportedAudio("no audio stream found in payload")
            stream = streams[0]
            resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=target_sr)
            for frame in container.decode(stream):
                for out in resampler.resample(frame) or []:
                    chunks.append(_frame_to_float(out))
            for out in resampler.resample(None) or []:
                chunks.append(_frame_to_float(out))
    except UnsupportedAudio:
        raise
    except Exception as exc:  # PyAV raises many error types
        raise UnsupportedAudio(f"cannot decode audio: {type(exc).__name__}: {exc}") from exc

    if not chunks:
        raise UnsupportedAudio("audio contains no decodable samples")
    samples = np.concatenate(chunks).astype(np.float32, copy=False)
    if samples.size == 0:
        raise UnsupportedAudio("audio contains no decodable samples")
    samples = np.clip(samples, -1.0, 1.0)
    clip = AudioClip(samples, target_sr)
    if max_seconds is not None and clip.duration_s > max_seconds:
        raise AudioTooLong(f"audio too long: {clip.duration_s:.1f}s > {max_seconds:.0f}s")
    return clip


def _frame_to_float(frame) -> np.ndarray:
    arr = frame.to_ndarray()
    arr = np.asarray(arr).reshape(-1)
    if arr.dtype != np.float32:
        arr = arr.astype(np.float32) / 32768.0
    return arr


@dataclass
class AudioProbe:
    """只看容器/编码信息（不解出样本给调用方），用于断言"返回字节与请求格式相符"。"""

    container: str
    codec: str
    sample_rate: int
    channels: int
    duration_ms: int


def probe_audio(data: bytes) -> AudioProbe:
    """用 PyAV 读出真实容器/编码/采样率/时长。

    这是 task-15 的防回归探针：Azure TTS 的 `SpeechConfig` 没有
    `speech_synthesis_output_format` 属性，历史上错误地给它赋值 → 静默退回 16kHz PCM，
    而 `content_type` 仍标 mp3。只有解码真实字节才能发现这类"标称与实物不符"。
    """
    if not data:
        raise UnsupportedAudio("empty audio payload")
    try:
        with av.open(io.BytesIO(data)) as container:
            streams = [stream for stream in container.streams if stream.type == "audio"]
            if not streams:
                raise UnsupportedAudio("no audio stream found in payload")
            stream = streams[0]
            codec = stream.codec_context.name or ""
            try:
                sample_rate = int(stream.codec_context.sample_rate or 0)
            except Exception:
                sample_rate = 0
            channels = int(getattr(stream.codec_context, "channels", 1) or 1)
            container_name = container.format.name or ""
            samples = 0
            for frame in container.decode(stream):
                samples += int(frame.samples)
    except UnsupportedAudio:
        raise
    except Exception as exc:
        raise UnsupportedAudio(f"cannot probe audio: {type(exc).__name__}: {exc}") from exc

    duration_ms = int(round(samples / sample_rate * 1000)) if sample_rate else 0
    return AudioProbe(
        container=container_name,
        codec=codec,
        sample_rate=sample_rate,
        channels=channels,
        duration_ms=duration_ms,
    )
