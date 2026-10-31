"""请求体模型（响应以契约字段手工构造，避免 response_model 误改字段名）。"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class _Loose(BaseModel):
    model_config = ConfigDict(extra="allow")


class TTSRequest(_Loose):
    text: str = ""
    voice: str | None = None
    rate: str = "normal"
    format: str = "mp3"
    ssml: str | None = None


class StoryRewriteRequest(_Loose):
    """中文讲述 -> 分级英文故事（task-47）。"""

    text_zh: str = ""
    level: str = "A1"  # A1 | A2 | B1 | B2
    max_sentences: int = 6  # 1..6
    weak_phonemes: list[str] = []
    avoid_words: list[str] = []


class StoryRetellRequest(_Loose):
    """孩子复述故事 -> 关键信息覆盖度评估（task-51）。"""

    story_sentences: list[str] = []
    transcript: str = ""
    level: str = "A2"


class ImageIllustrateRequest(_Loose):
    """故事 -> 儿童绘本插画（task-52）；task-61 支持角色卡。"""

    story_text: str = ""
    title_en: str | None = None
    style: str = "watercolor"
    character_desc: str | None = None
    character_style: str | None = None


class FeedbackScores(_Loose):
    pron: float | None = None
    accuracy: float | None = None
    fluency: float | None = None
    completeness: float | None = None
    prosody: float | None = None


class FeedbackIssue(_Loose):
    type: str | None = None
    word: str | None = None
    phoneme: str | None = None
    actual: str | None = None
    score: float | None = None
    hint_key: str | None = None
    severity: str | None = None


class Learner(_Loose):
    age_band: str | None = None
    level: str | None = None
    native_language: str | None = None
    child_safe: bool | None = None


class FeedbackRequest(_Loose):
    reference_text: str = ""
    scores: FeedbackScores | None = None
    issues: list[FeedbackIssue] = Field(default_factory=list)
    intonation: dict[str, Any] | None = None
    learner: Learner | None = None
    words: list[dict[str, Any]] = Field(default_factory=list)


class DialogueScenario(_Loose):
    id: str = ""
    title: str = ""
    title_zh: str = ""
    setting_zh: str = ""
    role_prompt: str = ""
    opening_line: str = ""
    level: str = "A2"
    min_age: int = 6


class DialogueHistoryItem(_Loose):
    role: str = "user"
    text: str = ""


class DialogueRequest(_Loose):
    scenario: DialogueScenario = Field(default_factory=DialogueScenario)
    learner: Learner = Field(default_factory=Learner)
    history: list[DialogueHistoryItem] = Field(default_factory=list)
    correction_level: str = "gentle"
    turn_index: int = 0


class WarmupItemRequest(_Loose):
    text: str = ""
    voice: str | None = None
    rate: str = "normal"


class WarmupRequest(_Loose):
    """契约 §12.3：items 1–500 条，concurrency 1–8（默认 2）。"""

    items: list[WarmupItemRequest] = Field(default_factory=list)
    concurrency: int = 2
