"""中文讲述 → 分级英文故事改写（task-47）。

故事模式：孩子用中文讲一件事（语音或文字），这里**改写**（不是直译）成适合其阅读级别的英文短故事。
硬约束由服务端校验（不能只靠模型自觉）：
- 句数 ≤ max_sentences；平均词数 ≤ 8/10/12/14（A1/A2/B1/B2）；最长句 ≤ 平均上限 + 4
- 单一叙事时态（过去 / 现在）
- 词汇尽量取自 `web/src/data/sentences.json` 的 A1/A2 句库；`unknown_words` > 2 → 重写一次
- 可选 `weak_phonemes`：尽量把发音弱的音塞进故事，未达成写进 warnings

LLM 调用注意（OCR 事故经验）：`deepseek-flash` 是推理模型 → **关闭思考**、max_tokens 给足（2000），
并处理 `finish_reason=length`（重试一次、更大 max_tokens）；JSON 解析失败重试一次，再失败 502。
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from .config import Settings, get_settings
from .errors import BadRequest, ProviderError, ProviderUnavailable
from .llm import LLMClient, LLMOutcome
from .phonemes import CANONICAL_PHONEMES, canonicalize_phoneme
from .text import word_phonemes

logger = logging.getLogger("voice.story")

LEVELS: tuple[str, ...] = ("A1", "A2", "B1", "B2")
# 平均词数上限（最长句 = 该值 + 4）
LEVEL_MAX_AVG_WORDS: dict[str, int] = {"A1": 8, "A2": 10, "B1": 12, "B2": 14}
MAX_EXTRA_WORDS = 4
MAX_UNKNOWN_WORDS = 2
MAX_SENTENCES = 6
MAX_TEXT_ZH_CHARS = 2000

STORY_MAX_TOKENS = 2000
STORY_TRUNCATION_MAX_TOKENS = 4000
STORY_TIMEOUT_S = 60.0

_WORD_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")

# 内置 A1 级常用词（句子库很小，只靠它会把 many/then/sorry 也判成超纲）。
# 这些词本来就是 A1 基础词，作为词表补充；真正的生僻词（xylophone/zeppelin…）仍会被标 unknown。
COMMON_WORDS: frozenset[str] = frozenset("""
a an the and or but so because if when while after before then now today yesterday tomorrow
i you he she it we they me him her us them my your his its our their mine yours
this that these those here there where what who which why how
is am are was were be been being have has had do does did done can could will would shall should may might must
not no yes ok okay very too also just only even still again always never often sometimes usually
go goes went going come comes came coming get gets got getting make makes made making
say says said tell tells told ask asks asked answer know knows knew think thinks thought
see sees saw seen look looks looked watch watches watched
want wants wanted need needs needed like likes liked love loves loved
play plays played read reads run runs ran walk walks walked
give gives gave take takes took put puts find finds found
eat eats ate drink drinks drank sleep sleeps slept wake wakes woke
sit sits sat stand stands stood open opens opened close closes closed
start starts started stop stops stopped help helps helped try tries tried
build builds built live lives lived feel feels felt become becomes became
fall falls fell drop drops dropped knock knocks knocked bump bumps bumped push pushes pushed
break breaks broke fix fixes fixed carry carries carried hold holds held
big small tall short long little huge tiny good bad happy sad angry scared tired excited
hot cold warm cool new old young fast slow easy hard nice kind funny pretty beautiful
one two three four five six seven eight nine ten many much more most some any all every each
few lots lot again together again back down up in on at to from with without for about by of
over under near far inside outside around through between behind next last first second
man woman boy girl child kid friend family mother father mom dad sister brother baby
day night morning afternoon evening week month year time hour minute
school home park house room door window table chair bed toy book story picture game
block blocks tower towers ball cat dog bird fish tree flower water milk bread
face hand head eye ear nose mouth hair foot feet leg arm
because before after while until since
sorry please thanks thank hello hi bye goodbye welcome
name names word words sentence story stories
idea ideas thing things place places way ways
floor floors wall walls ceiling garden yard street road shop store car bus bike bicycle train plane
sky sun moon star rain snow wind cloud tree trees flower flowers grass leaves
noise sound sounds loud quiet soft hard light dark bright clean dirty messy
hungry thirsty cry cries cried laugh laughs laughed smile smiles smiled shout shouts shouted
nothing something anything everything everyone someone anyone nobody everybody somebody
suddenly finally slowly quickly really almost together alone again
tower towers block blocks brick bricks box boxes toy toys doll dolls ball balls
angry sad happy scared tired excited proud surprised worried
broken break fix drop fall fell knock bump push pull throw catch
minute minutes second seconds first then next later before after while
sorry please thanks thank ok okay hello hi goodbye welcome
because so but and or if when what where who why how
""".split())
_VOCAB_CACHE: dict[str, tuple[float, set[str], dict[str, list[str]]]] = {}

# 常见"薄弱音"简称 -> canonical-v1 音素
PHONEME_ALIASES: dict[str, tuple[str, ...]] = {
    "th": ("θ", "ð"),
    "s": ("s",),
    "z": ("z",),
    "r": ("r",),
    "l": ("l",),
    "v": ("v",),
    "w": ("w",),
    "f": ("f",),
    "h": ("h",),
    "sh": ("ʃ",),
    "ch": ("tʃ",),
    "j": ("dʒ",),
    "zh": ("ʒ",),
    "ng": ("ŋ",),
    "m": ("m",),
    "n": ("n",),
    "p": ("p",),
    "b": ("b",),
    "t": ("t",),
    "d": ("d",),
    "k": ("k",),
    "g": ("ɡ",),
    "ei": ("eɪ",),
    "ai": ("aɪ",),
    "oi": ("ɔɪ",),
    "ou": ("əʊ",),
    "au": ("aʊ",),
    "ear": ("ɪə",),
    "air": ("eə",),
}

# 单一时态检测（粗略但足够触发"重写"，避免混合时态）
_PAST_IRREGULAR = {
    "was", "were", "had", "did", "could", "would", "went", "said", "saw", "came", "got", "made",
    "took", "gave", "found", "thought", "told", "felt", "became", "began", "brought", "bought",
    "caught", "taught", "ran", "sat", "stood", "knew", "grew", "flew", "drew", "threw", "built",
    "broke", "chose", "drove", "ate", "fell", "fought", "heard", "held", "kept", "left", "lost",
    "met", "paid", "put", "read", "rose", "sent", "sang", "slept", "spoke", "spent", "swam", "won",
    "wore", "wrote",
}
_PRESENT_IRREGULAR = {
    "is", "are", "am", "has", "have", "do", "does", "can", "will", "goes", "likes", "wants",
    "says", "sees", "comes", "gets", "makes", "takes", "gives", "finds", "thinks", "tells",
    "feels", "knows", "grows", "plays", "reads",
}
_PRESENT_EXCEPTIONS = {"is", "was", "this", "his", "its", "us", "yes", "always", "sometimes", "plus", "does"}


def reset_story_cache() -> None:
    _VOCAB_CACHE.clear()


# --------------------------------------------------------------------------------------
# 词汇表（读 web/src/data/sentences.json 的 A1/A2 句库；只读）
# --------------------------------------------------------------------------------------
def _default_vocab_path() -> Path:
    # voice/app/story.py -> english-coach/
    root = Path(__file__).resolve().parents[2]
    return root / "web" / "src" / "data" / "sentences.json"


def _vocab_path() -> Path:
    override = os.environ.get("STORY_VOCAB_PATH")
    return Path(override) if override else _default_vocab_path()


def load_vocab() -> tuple[set[str], dict[str, list[str]]]:
    """-> (A1/A2 词集, 音素 -> 例词)。文件缺失时返回空词集（不阻塞故事生成）。"""
    path = _vocab_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return set(), {}
    cached = _VOCAB_CACHE.get(str(path))
    if cached and cached[0] == mtime:
        return cached[1], cached[2]

    vocab: set[str] = set()
    phoneme_examples: dict[str, list[str]] = {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        entries = payload.get("sentences") if isinstance(payload, dict) else payload
        for entry in entries or []:
            if str(entry.get("level", "")).upper() not in ("A1", "A2"):
                continue
            text = str(entry.get("text", ""))
            for word in _WORD_RE.findall(text):
                vocab.add(word.lower())
            for phoneme in entry.get("focus_phonemes") or []:
                phoneme_examples.setdefault(str(phoneme), []).append(text)
    except Exception as exc:  # 词表只是参考，读不到不影响功能
        logger.warning("story vocab load failed (%s): %s", type(exc).__name__, exc)
        return set(), {}

    _VOCAB_CACHE[str(path)] = (mtime, vocab, phoneme_examples)
    return vocab, phoneme_examples


def _known_word(word: str, vocab: set[str]) -> bool:
    known = vocab | COMMON_WORDS
    lowered = word.lower()
    if lowered in known:
        return True
    # 允许常见屈折变化（复数/过去式/进行时）
    variants = {lowered.rstrip("s")}
    if lowered.endswith("es"):
        variants.add(lowered[:-2])
    if lowered.endswith("ed"):
        variants.add(lowered[:-2])
        variants.add(lowered[:-1])
    if lowered.endswith("ing"):
        variants.add(lowered[:-3])
        variants.add(lowered[:-3] + "e")
    return any(v in known for v in variants if v)


# --------------------------------------------------------------------------------------
# 可读性 / 约束校验
# --------------------------------------------------------------------------------------
def sentence_words(sentence: str) -> list[str]:
    return _WORD_RE.findall(sentence)


def _tense(tokens: list[str]) -> str | None:
    past = present = 0
    for token in tokens:
        lowered = token.lower()
        if lowered in _PAST_IRREGULAR or (lowered.endswith("ed") and len(lowered) > 3):
            past += 1
        elif lowered in _PRESENT_IRREGULAR:
            present += 1
        elif (
            lowered.endswith("s")
            and not lowered.endswith("ss")
            and len(lowered) > 2
            and lowered not in _PRESENT_EXCEPTIONS
        ):
            present += 1
    if past and present:
        return "mixed"
    if past:
        return "past"
    if present:
        return "present"
    return None


def evaluate_readability(
    sentences: list[str],
    *,
    level: str,
    max_sentences: int,
    vocab: set[str],
    avoid_words: list[str] | None = None,
) -> dict:
    counts = [len(sentence_words(sentence)) for sentence in sentences]
    sentence_count = len(sentences)
    total_words = sum(counts)
    avg_words = total_words / sentence_count if sentence_count else 0.0
    max_words = max(counts) if counts else 0
    limit = LEVEL_MAX_AVG_WORDS.get(level, 8)

    tokens = [word for sentence in sentences for word in sentence_words(sentence)]
    unknown: list[str] = []
    for sentence in sentences:
        words = sentence_words(sentence)
        for index, token in enumerate(words):
            lowered = token.lower()
            if len(lowered) <= 1:
                continue
            # 人名/地名等专有名词不算"超纲词"（如 Xiaoming、Froggy）；
            # 大写的未知词按专有名词处理（模型要求英文正文除专名外不首字母大写）
            if token[0].isupper() and not _known_word(lowered, vocab):
                continue
            if not _known_word(lowered, vocab) and lowered not in unknown:
                unknown.append(lowered)

    violations: list[str] = []
    if sentence_count == 0:
        violations.append("empty")
    if sentence_count > max_sentences:
        violations.append("too_many_sentences")
    if avg_words > limit:
        violations.append("avg_words_too_high")
    if max_words > limit + MAX_EXTRA_WORDS:
        violations.append("sentence_too_long")
    if _tense(tokens) == "mixed":
        violations.append("mixed_tense")
    if len(unknown) > MAX_UNKNOWN_WORDS:
        violations.append("unknown_words")
    declined = {word.lower() for word in avoid_words or []}
    if declined and any(token.lower() in declined for token in tokens):
        violations.append("avoid_words")

    return {
        "sentence_count": sentence_count,
        "avg_words": round(avg_words, 1),
        "max_words": max_words,
        "unknown_words": unknown[:10],
        "ok": not violations,
        "violations": violations,
    }


def _weak_phoneme_targets(weak_phonemes: list[str]) -> dict[str, tuple[str, ...]]:
    targets: dict[str, tuple[str, ...]] = {}
    for item in weak_phonemes or []:
        key = str(item).strip().lower()
        if not key:
            continue
        if key in PHONEME_ALIASES:
            targets[key] = PHONEME_ALIASES[key]
        else:
            canon = canonicalize_phoneme(key)
            if canon in CANONICAL_PHONEMES:
                targets[key] = (canon,)
    return targets


def _word_has_phonemes(word: str, targets: tuple[str, ...]) -> bool:
    phones = {canonicalize_phoneme(phone) for phone in word_phonemes(word)}
    return bool(phones.intersection(targets))


def achieved_weak_phonemes(sentences: list[str], weak_phonemes: list[str]) -> tuple[list[str], list[str]]:
    """-> (已达成, 未达成)。"""
    targets = _weak_phoneme_targets(weak_phonemes)
    if not targets:
        return [], []
    words = [word for sentence in sentences for word in sentence_words(sentence)]
    achieved, missing = [], []
    for label, phonemes in targets.items():
        if any(_word_has_phonemes(word, phonemes) for word in words):
            achieved.append(label)
        else:
            missing.append(label)
    return achieved, missing


# --------------------------------------------------------------------------------------
# 提示词
# --------------------------------------------------------------------------------------
def _phoneme_hints(weak_phonemes: list[str], phoneme_examples: dict[str, list[str]]) -> str:
    targets = _weak_phoneme_targets(weak_phonemes)
    lines: list[str] = []
    for label, phonemes in targets.items():
        examples: list[str] = []
        for phoneme in phonemes:
            for text in phoneme_examples.get(phoneme, [])[:3]:
                examples.append(text.rstrip(".!?"))
        hint = f"- /{label}/"
        if examples:
            hint += "（例：" + "; ".join(examples[:3]) + "）"
        lines.append(hint)
    return "\n".join(lines)


def build_prompts(
    text_zh: str,
    *,
    level: str,
    max_sentences: int,
    vocab: set[str],
    phoneme_examples: dict[str, list[str]],
    weak_phonemes: list[str],
    avoid_words: list[str],
    feedback: list[str] | None = None,
) -> tuple[str, str]:
    limit = LEVEL_MAX_AVG_WORDS.get(level, 8)
    system = (
        "You are an English children's story writer for a young Chinese learner. "
        "Rewrite the Chinese story into simple English — REWRITE it, do NOT translate word by word. "
        "Keep the same event and feelings, but simplify the structure. "
        "Output ONLY a JSON object: {\"title_en\": string, \"sentences\": [string, ...]}. "
        "No markdown, no comments, no Chinese characters in the English output."
    )
    word_list = ", ".join(sorted(vocab)[:120]) if vocab else "simple everyday words"
    parts = [
        f"Level: {level}. Target: at most {max_sentences} sentences.",
        f"Average sentence length must be <= {limit} words; every sentence must be <= {limit + MAX_EXTRA_WORDS} words.",
        "Use ONLY ONE tense (past tense if the story already happened; present tense for routines). Do not mix tenses.",
        f"Prefer simple words from this list: {word_list}.",
    ]
    if weak_phonemes:
        hints = _phoneme_hints(weak_phonemes, phoneme_examples)
        if hints:
            parts.append(
                "The child is practising these sounds — try to include words with them "
                f"(at least one word each, if natural):\n{hints}"
            )
    if avoid_words:
        parts.append("Do not use these words: " + ", ".join(avoid_words[:20]) + ".")
    if feedback:
        reasons = {
            "too_many_sentences": "too many sentences",
            "avg_words_too_high": "sentences too long on average",
            "sentence_too_long": "one or more sentences too long",
            "mixed_tense": "mixed tenses",
            "unknown_words": "too many hard/unknown words",
            "avoid_words": "used words to avoid",
        }
        described = "; ".join(reasons.get(item, item) for item in feedback)
        parts.append(f"The previous attempt was rejected because: {described}. Fix it and rewrite.")
    parts.append("Chinese story to rewrite:\n" + text_zh)
    parts.append('Output JSON only: {"title_en": "...", "sentences": ["...", "..."]}')
    return system, "\n\n".join(parts)


# --------------------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------------------
def _extract_sentences(data: dict | None) -> list[str] | None:
    if not isinstance(data, dict):
        return None
    raw = data.get("sentences")
    if not isinstance(raw, list):
        return None
    sentences = [str(item).strip() for item in raw if str(item).strip()]
    return sentences or None


def _call_llm(
    client: LLMClient,
    system: str,
    user: str,
    *,
    max_tokens: int,
) -> LLMOutcome:
    return client.chat_json(
        system,
        user,
        timeout_s=STORY_TIMEOUT_S,
        max_tokens=max_tokens,
        temperature=0.4,
        disable_thinking=True,
    )


def rewrite_story(
    text_zh: str,
    *,
    level: str = "A1",
    max_sentences: int = MAX_SENTENCES,
    weak_phonemes: list[str] | None = None,
    avoid_words: list[str] | None = None,
    settings: Settings | None = None,
) -> dict:
    """中文讲述 -> 分级英文故事。返回契约 JSON（失败抛 ProviderError/ProviderUnavailable）。"""
    settings = settings or get_settings()
    level = (level or "A1").upper()
    if level not in LEVELS:
        raise BadRequest(f"level must be one of {LEVELS}, got {level!r}")
    text_zh = (text_zh or "").strip()
    if not text_zh:
        raise BadRequest("text_zh is required")
    if len(text_zh) > MAX_TEXT_ZH_CHARS:
        raise BadRequest(f"text_zh too long: {len(text_zh)} > {MAX_TEXT_ZH_CHARS} chars")
    if not 1 <= int(max_sentences) <= MAX_SENTENCES:
        raise BadRequest(f"max_sentences must be 1..{MAX_SENTENCES}")
    weak_phonemes = [str(item).strip() for item in (weak_phonemes or []) if str(item).strip()][:5]
    avoid_words = [str(item).strip().lower() for item in (avoid_words or []) if str(item).strip()][:20]
    for word in avoid_words:
        if not re.fullmatch(r"[a-z][a-z'-]{0,31}", word):
            raise BadRequest(f"invalid avoid_words entry: {word!r}")

    client = LLMClient(settings)
    if not client.available:
        raise ProviderUnavailable(
            "故事改写需要 LLM：请配置 .env 的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（并重建镜像）",
            provider="story",
            code="provider_unavailable",
        )

    vocab, phoneme_examples = load_vocab()
    feedback: list[str] | None = None
    last_eval: dict | None = None
    last_data: dict | None = None
    last_sentences: list[str] = []
    last_provider = client.provider_name

    for attempt in range(2):
        system, user = build_prompts(
            text_zh,
            level=level,
            max_sentences=int(max_sentences),
            vocab=vocab,
            phoneme_examples=phoneme_examples,
            weak_phonemes=weak_phonemes,
            avoid_words=avoid_words,
            feedback=feedback,
        )
        outcome = _call_llm(client, system, user, max_tokens=STORY_MAX_TOKENS)
        if outcome.truncated:
            logger.warning(
                "story rewrite truncated (completion=%s thinking_disabled=%s) — retrying with bigger max_tokens",
                outcome.completion_tokens,
                outcome.thinking_disabled,
            )
            outcome = _call_llm(client, system, user, max_tokens=STORY_TRUNCATION_MAX_TOKENS)
            if outcome.truncated:
                raise ProviderError(
                    f"LLM 输出被 max_tokens 截断（重试后仍截断，completion={outcome.completion_tokens}）",
                    provider="story",
                )
        if outcome.provider == "template" or (outcome.error and outcome.error != "invalid_json"):
            raise ProviderError(f"LLM 调用失败：{outcome.error or 'unknown error'}", provider="story")
        if not outcome.ok:
            # JSON 解析失败：重试一次，再失败 → 502
            logger.warning("story rewrite invalid JSON (attempt %d)", attempt + 1)
            if attempt == 0:
                continue
            raise ProviderError("LLM 两次都没有返回合法 JSON（故事改写失败），请重试", provider="story")

        last_provider = outcome.provider
        last_data = outcome.data
        sentences = _extract_sentences(outcome.data)
        if sentences is None:
            logger.warning("story rewrite JSON missing sentences (attempt %d)", attempt + 1)
            if attempt == 0:
                continue
            raise ProviderError("LLM 返回的 JSON 缺少 sentences 数组（故事改写失败）", provider="story")
        last_sentences = sentences

        evaluated = evaluate_readability(
            sentences,
            level=level,
            max_sentences=int(max_sentences),
            vocab=vocab,
            avoid_words=avoid_words,
        )
        last_eval = evaluated
        if evaluated["ok"]:
            break
        feedback = evaluated["violations"]
        logger.info("story rewrite rejected (attempt %d): %s", attempt + 1, feedback)

    if last_data is None or last_eval is None:
        raise ProviderError("故事改写失败（LLM 未产出可用结果）", provider="story")

    warnings: list[str] = []
    if not last_eval["ok"]:
        warnings.append("too_hard")
    achieved, missing = achieved_weak_phonemes(last_sentences, weak_phonemes)
    if missing:
        warnings.append("weak_phonemes_missing")
    title = str(last_data.get("title_en") or "").strip() or "My Story"

    result = {
        "title_en": title,
        "sentences": last_sentences,
        "text_en": "\n".join(last_sentences),
        "level": level,
        "readability": {
            "sentence_count": last_eval["sentence_count"],
            "avg_words": last_eval["avg_words"],
            "max_words": last_eval["max_words"],
            "unknown_words": last_eval["unknown_words"],
            "ok": last_eval["ok"],
        },
        "warnings": warnings,
        "provider": last_provider,
    }
    if weak_phonemes:
        result["provider_meta"] = {"weak_phonemes_achieved": achieved, "weak_phonemes_missing": missing}
    return result


# ======================================================================================
# 复述评估（task-51）：孩子读完故事后用自己的话讲 2–3 句，评估"关键信息覆盖度"（不评发音）
# ======================================================================================
RETELL_MAX_TOKENS = 1200
RETELL_TRUNCATION_MAX_TOKENS = 2400
RETELL_TIMEOUT_S = 60.0
MAX_STORY_SENTENCES_INPUT = 20
MAX_STORY_SENTENCE_CHARS = 200
MAX_TRANSCRIPT_CHARS = 1000
RETELL_LOW_COVERAGE = 0.3

# "绝不出现否定词"的检查表（避免误伤"不错/很棒"等肯定表达，这里只列真正否定的短语）
_NEGATIVE_ZH = (
    "不好", "不对", "不行", "不会", "没有", "没讲", "没说", "错了", "错误", "失败",
    "很差", "太差", "不够", "缺少", "漏掉", "忘记", "做不到", "糟糕", "太乱", "扣分",
)
_ENCOURAGEMENT_MARKERS = ("开口", "很棒", "很好", "不错", "厉害", "喜欢", "再来")

RETELL_SYSTEM_PROMPT = (
    "You are a kind English teacher for a young Chinese learner (age 6-9).\n"
    "You will get: the story the child read, and the child's spoken retelling (transcribed).\n"
    "Evaluate MEANING coverage — NOT exact words. The child may use different forms "
    "(build/built), different word order, or omit articles. Accept any expression that keeps the meaning.\n"
    "Be generous: 1-2 sentences is a good retelling.\n"
    "Output ONLY a JSON object:\n"
    '{"coverage": number 0..1,\n'
    ' "covered_points": [short Chinese phrases the child DID say],\n'
    ' "missing_points": [short Chinese phrases the child did NOT say],\n'
    ' "feedback_zh": "1 sentence of specific praise mentioning what the child actually said, '
    'then at most 1 gentle suggestion, all in simplified Chinese",\n'
    ' "feedback_en": "the same encouragement in simple English"}\n'
    "FEEDBACK RULES (strict):\n"
    "- Start from what the child DID say (covered_points). Never use negative words "
    "(no 差/错/失败/不行/不好/没有/漏掉).\n"
    "- At most ONE suggestion, phrased as '还可以说说…' / 'next time you can also say …'.\n"
    "- If coverage < 0.3, be extra encouraging (e.g. '你开口讲了！我们再来一次'), never like a score deduction.\n"
    "No markdown, no comments, JSON only."
)


def _clamp01(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if number != number:  # NaN
        return 0.0
    return max(0.0, min(1.0, number))


def _clean_points(raw, limit: int = 6) -> list[str]:
    if not isinstance(raw, list):
        return []
    points: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        point = item.strip()
        if point and point not in points:
            points.append(point[:60])
        if len(points) >= limit:
            break
    return points


def _has_negative_words(text: str) -> bool:
    return any(word in text for word in _NEGATIVE_ZH)


def _is_cjk(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in text)


def _mentions_any_point(feedback: str, points: list[str]) -> bool:
    """检查肯定句是否提到孩子讲到的点。

    只在"点本身是中文"时做文本匹配——LLM 的 covered_points 常是英文关键词
    （tower / Ming），而 feedback_zh 是中文，英文关键词不会字面出现在中文句子里，
    强行匹配会误判成"没表扬"。英文点时信任模型（提示词已要求具体肯定）。
    """
    cjk_points = [point for point in points if _is_cjk(point)]
    if not cjk_points:
        return True  # 全是英文关键词：无法在中文句子里字面匹配，信任模型
    return any(point in feedback for point in cjk_points)


def _retell_fallback_feedback(covered: list[str], missing: list[str], coverage: float) -> tuple[str, str]:
    covered_zh = "、".join(covered[:2])
    if coverage < RETELL_LOW_COVERAGE:
        zh = "你开口讲了！" + (f"你提到了{covered_zh}，" if covered_zh else "") + "我们再来一次，这次可以多说一点。"
        en = "You spoke up! " + (f"You told me about {covered[:1][0]}. " if covered else "") + "Let's try again together."
        return zh, en
    zh = f"你讲了{covered_zh}，很棒！" if covered_zh else "你讲得很棒！"
    if missing:
        zh += f"下次还可以说说{missing[0]}。"
    en = "Great job! " + (f"You told me about {covered[:1][0]}. " if covered else "")
    if missing:
        en += f"Next time you can also say something about {missing[0]}."
    return zh.strip(), en.strip()


def _validate_retell_data(data: dict | None) -> dict | None:
    if not isinstance(data, dict):
        return None
    if "coverage" not in data:
        return None
    covered = _clean_points(data.get("covered_points"))
    missing = _clean_points(data.get("missing_points"))
    feedback_zh = data.get("feedback_zh")
    feedback_en = data.get("feedback_en")
    if not isinstance(feedback_zh, str) or not feedback_zh.strip():
        return None
    if not isinstance(feedback_en, str) or not feedback_en.strip():
        return None
    return {
        "coverage": _clamp01(data.get("coverage")),
        "covered_points": covered,
        "missing_points": missing,
        "feedback_zh": feedback_zh.strip(),
        "feedback_en": feedback_en.strip(),
    }


def _retell_feedback_issues(payload: dict) -> list[str]:
    issues: list[str] = []
    feedback_zh = payload["feedback_zh"]
    if _has_negative_words(feedback_zh):
        issues.append("negative_words")
    if payload["covered_points"] and not _mentions_any_point(feedback_zh, payload["covered_points"]):
        issues.append("missing_praise")
    if payload["coverage"] < RETELL_LOW_COVERAGE and not any(
        marker in feedback_zh for marker in _ENCOURAGEMENT_MARKERS
    ):
        issues.append("not_encouraging")
    return issues


def retell_story(
    story_sentences: list[str],
    transcript: str,
    *,
    level: str = "A2",
    settings: Settings | None = None,
) -> dict:
    """评估孩子对故事的复述覆盖度（语义匹配，不评发音分）。"""
    settings = settings or get_settings()
    level = (level or "A2").upper()
    if level not in LEVELS:
        raise BadRequest(f"level must be one of {LEVELS}, got {level!r}")

    if not isinstance(story_sentences, list) or not 1 <= len(story_sentences) <= MAX_STORY_SENTENCES_INPUT:
        raise BadRequest(f"story_sentences must contain 1..{MAX_STORY_SENTENCES_INPUT} items")
    cleaned_story: list[str] = []
    for item in story_sentences:
        if not isinstance(item, str) or not item.strip():
            raise BadRequest("each story_sentences item must be a non-empty string")
        if len(item) > MAX_STORY_SENTENCE_CHARS:
            raise BadRequest(f"story sentence too long: {len(item)} > {MAX_STORY_SENTENCE_CHARS} chars")
        cleaned_story.append(item.strip())

    transcript = (transcript or "").strip()
    if not transcript:
        raise BadRequest("transcript is required")
    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        raise BadRequest(f"transcript too long: {len(transcript)} > {MAX_TRANSCRIPT_CHARS} chars")

    client = LLMClient(settings)
    if not client.available:
        raise ProviderUnavailable(
            "复述评估需要 LLM：请配置 .env 的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（并重建镜像）",
            provider="story",
            code="provider_unavailable",
        )

    prompt_user = (
        f"Level: {level}\n\n"
        "Story sentences the child read:\n"
        + "\n".join(f"- {sentence}" for sentence in cleaned_story)
        + "\n\nChild's retelling (transcript, may contain speech-recognition errors):\n"
        + transcript
        + "\n\nJudge semantic coverage and write the encouraging feedback. JSON only."
    )

    last_payload: dict | None = None
    last_issues: list[str] = []
    last_provider = client.provider_name

    for attempt in range(2):
        user_prompt = prompt_user
        if attempt:
            fixes = {
                "negative_words": "remove ALL negative words from feedback_zh",
                "missing_praise": "mention at least one covered point explicitly in feedback_zh",
                "not_encouraging": "be extra encouraging (e.g. 你开口讲了！我们再来一次)",
            }
            notes = "; ".join(fixes.get(issue, issue) for issue in last_issues) or "follow the required JSON shape"
            user_prompt += f"\n\nPrevious attempt was rejected: {notes}. Fix it."

        outcome = _call_llm(client, RETELL_SYSTEM_PROMPT, user_prompt, max_tokens=RETELL_MAX_TOKENS)
        if outcome.truncated:
            logger.warning("story retell truncated — retrying with bigger max_tokens")
            outcome = _call_llm(client, RETELL_SYSTEM_PROMPT, user_prompt, max_tokens=RETELL_TRUNCATION_MAX_TOKENS)
            if outcome.truncated:
                raise ProviderError("LLM 输出被 max_tokens 截断（重试后仍截断）", provider="story")
        if outcome.provider == "template" or (outcome.error and outcome.error != "invalid_json"):
            raise ProviderError(f"LLM 调用失败：{outcome.error or 'unknown error'}", provider="story")
        if not outcome.ok:
            logger.warning("story retell invalid JSON (attempt %d)", attempt + 1)
            if attempt == 0:
                continue
            raise ProviderError("LLM 两次都没有返回合法 JSON（复述评估失败），请重试", provider="story")

        payload = _validate_retell_data(outcome.data)
        if payload is None:
            logger.warning("story retell JSON shape invalid (attempt %d)", attempt + 1)
            if attempt == 0:
                continue
            raise ProviderError("LLM 返回的 JSON 结构不合法（复述评估失败）", provider="story")

        last_payload = payload
        last_provider = outcome.provider
        last_issues = _retell_feedback_issues(payload)
        if not last_issues:
            break

    if last_payload is None:
        raise ProviderError("复述评估失败（LLM 未产出可用结果）", provider="story")

    warnings: list[str] = []
    feedback_zh = last_payload["feedback_zh"]
    feedback_en = last_payload["feedback_en"]
    if last_issues:
        # 最后一次仍违反"鼓励优先"→ 用确定性正向模板兜底（绝不返回否定词）
        feedback_zh, feedback_en = _retell_fallback_feedback(
            last_payload["covered_points"], last_payload["missing_points"], last_payload["coverage"]
        )
        warnings.append("feedback_template")
        if _has_negative_words(feedback_zh):  # 理论上不可能，防御
            raise ProviderError("反馈模板异常", provider="story")

    return {
        "coverage": round(last_payload["coverage"], 2),
        "covered_points": last_payload["covered_points"],
        "missing_points": last_payload["missing_points"],
        "feedback_zh": feedback_zh,
        "feedback_en": feedback_en,
        "warnings": warnings,
        "provider": last_provider,
    }
