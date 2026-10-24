"""对话训练单轮推进：LLM 优先，失败/无 key 时模板降级（provider="template" + degraded_llm=true）。

质量要点（task-17）：
- **年龄适配**：child 用 A1 词、≤12 词、一次一个简单问题；teen/adult 按 CEFR 匹配。
- **连续性**：必须具体回应学习者上一句，禁止 "Tell me more / That sounds good" 这类万能句。
- **不重复**：history 里问过的问题列进 prompt 的 ALREADY_ASKED。
- **纠错分级**：gentle（最多 1 处、只纠影响理解的）/ standard（有错纠 1 处）/ none（恒不纠）。
  宁可 has_error=false，也不许为了显得智能而挑刺。
- **健壮性**：history 只带最近 8 条；JSON 失败重试一次；sanitize 兜底。
- **诚实**：返回 `degraded_llm` 明确告诉前端"这条不是大模型生成的"。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger("voice.dialogue")

CORRECTION_TYPES = ("grammar", "vocabulary", "politeness", "pronunciation", "none")
CORRECTION_LEVELS = ("gentle", "standard", "none")
FLAGS = ("ok", "unsafe_filtered", "off_topic")
DONE_TURN_INDEX = 6  # 契约 §6：turn_index >= 6 时 done=true（prompt 里让模型从 5 开始自然收尾）
MAX_HISTORY = 8
MAX_REPLY_CHARS = 300
MAX_SUGGESTION_WORDS = 6
MIN_SUGGESTIONS = 2
MAX_SUGGESTIONS = 3

# 固定话术降级：按 scenario.id 给一套「店员/老师/朋友」式推进（离线也能练）
FALLBACK_SCENARIOS: dict[str, dict[str, Any]] = {
    "ordering_coffee": {
        "replies": ["Sure! Hot or iced?", "Great choice. Anything to eat?", "Coming right up! That's 3 dollars."],
        "replies_zh": ["好的！热的还是冰的？", "很好的选择。要来点吃的吗？", "马上就好！一共三美元。"],
        "suggested": [
            ["Hot, please.", "Iced, please.", "Hot, please. Thank you."],
            ["No, thanks.", "Yes, a cookie please.", "Just the coffee, thanks."],
            ["Here you are.", "Thank you!", "Here you are. Thanks!"],
        ],
        "target_words": ["hot", "iced", "please"],
    },
    "greeting": {
        "replies": ["Hi! How are you today?", "That's great! What did you do today?", "Nice! See you next time!"],
        "replies_zh": ["你好！你今天怎么样？", "太好了！你今天做了什么？", "真棒！下次见！"],
        "suggested": [
            ["I'm fine, thank you.", "I'm happy!", "I'm fine. And you?"],
            ["I played with my friend.", "I read a book.", "I went to school."],
            ["See you!", "Bye bye!", "See you next time!"],
        ],
        "target_words": ["fine", "happy", "today"],
    },
    "school_day": {
        "replies": [
            "Nice! What class do you like best?",
            "Math is fun! What did you learn today?",
            "Great job! Let's talk again tomorrow.",
        ],
        "replies_zh": ["真不错！你最喜欢哪节课？", "数学很有趣！你今天学了什么？", "做得好！我们明天再聊。"],
        "suggested": [
            ["I like English.", "I like math.", "I like art class."],
            ["I learned numbers.", "I learned new words.", "We read a story."],
            ["See you tomorrow!", "Bye!", "Thank you, bye!"],
        ],
        "target_words": ["class", "learn", "like"],
    },
    "__default__": {
        "replies": ["Nice! Tell me more.", "That sounds good! What happened next?", "Great talking with you! See you next time."],
        "replies_zh": ["不错！再多说一点。", "听起来很好！后来呢？", "和你聊天很开心！下次见。"],
        "suggested": [
            ["Yes, I like it.", "It's fun.", "I don't know."],
            ["I think so too.", "Really? Tell me more.", "That's cool!"],
            ["See you!", "Thank you!", "Bye bye!"],
        ],
        "target_words": ["nice", "good", "fun"],
    },
}

SAFE_REPLY = "Let's talk about something fun! What do you like to do?"
UNSAFE_WORDS = ("kill", "gun", "blood", "stupid", "hate you", "die")

_NO_CORRECTION = {
    "has_error": False,
    "type": "none",
    "original": None,
    "better": None,
    "explain_zh": None,
    "severity": None,
}

# (正则, 类型, 更好的说法, 中文解释, 严重度, 最低触发等级)
# gentle 只纠"影响理解/高频基础错"，standard 才纠更细的语序与用词问题。
_CORRECTION_RULES: list[tuple[str, str, str, str, str, str]] = [
    (r"\bi\s+want\b", "politeness", "I'd like ..., please.", "点单或请求时用 I'd like 比 I want 更礼貌。", "low", "gentle"),
    (r"\b(i|you|we|they)\s+is\b", "grammar", "I am / you are ...", "be 动词要和主语搭配：I am、you are。", "medium", "gentle"),
    (r"\b(he|she|it)\s+(go|like|want|play|have)\b", "grammar", "he/she/it + 动词加 -s", "第三人称单数后面的动词要加 -s。", "medium", "gentle"),
    (r"\bmore\s+better\b", "grammar", "better", "better 本身已经是比较级，不用再加 more。", "low", "standard"),
    (r"\bi\s+no\s+\w+", "grammar", "I don't ...", "否定句要用 don't / doesn't，不是 no。", "medium", "standard"),
    (r"\bvery\s+much\s+like\b", "vocabulary", "like ... very much", "语序上通常说 like it very much。", "low", "standard"),
]

DIALOGUE_SYSTEM_PROMPT = """You are a patient English speaking partner and role-play actor for a Chinese family.
You are NOT an examiner: never grade, never lecture, never ask the learner to repeat your own line.
First follow SCENARIO / ROLE_PROMPT, then apply the AGE_BAND block given in the user message.

[AGE_BAND=child] (6-9 years old)
- Use ONLY A1 words and very short sentences. Every reply MUST be <= 12 words.
- Ask exactly ONE simple question per turn; never stack two questions.
- No idioms, no slang, no double clauses. Warm and playful tone.
[AGE_BAND=teen|adult]
- Match the CEFR level (A1/A2: simple present and past, one clause; B1: one subordinate clause; B2+: natural range).
- Keep every reply <= 20 words and still ask exactly ONE question per turn.

CONTINUITY (most important):
- Always react to the learner's LAST sentence with something specific - reuse a word or detail they said.
- When a specific reply is possible, generic fillers are FORBIDDEN as the whole reply:
  "Tell me more", "That sounds good", "Nice!", "OK", "I see", "Really?".
- Never repeat a question listed under ALREADY_ASKED. Ask something new or move the scenario forward.

CORRECTION_LEVEL (exactly one of these behaviours):
- gentle: correct AT MOST ONE thing, and only if it blocks understanding or is a basic mistake
  (be verb, third-person -s, politeness). Keep it light, one short tip.
- standard: correct the single most important mistake when there is one.
- none: never correct; correction.has_error MUST be false.
- NEVER invent a mistake to look smart. If the sentence is acceptable, set has_error=false.
  A correction must actually change something: better MUST differ from original.

CHILD SAFETY: when child_safe=true, avoid violence, romance, politics, horror and adult topics.
If the learner says something inappropriate, gently redirect and set flag="unsafe_filtered".

OUTPUT: return ONLY a JSON object (no prose, no markdown fence) with exactly these keys:
{"reply": "<English; obey the age rules>",
 "reply_zh": "<natural spoken Simplified Chinese, never machine-literal>",
 "correction": {"has_error": false, "type": "none", "original": null, "better": null, "explain_zh": null, "severity": null},
 "suggested_replies": ["<next line the learner can say, <= 6 words>", "<another>"],
 "target_words": ["<1-3 useful words that appear in YOUR reply>"],
 "flag": "ok",
 "done": false}
Rules for the fields:
- correction.type: "grammar" | "vocabulary" | "politeness" | "pronunciation" | "none".
  When has_error=true fill original/better/explain_zh/severity ("high"|"medium"|"low"); otherwise all null.
- suggested_replies: 2-3 items, each <= 6 words, all different, each a natural NEXT line the learner can
  say immediately (not a repetition of your reply, not a translation exercise).
- target_words: 1-3 words taken from your reply.
- flag: "ok" | "unsafe_filtered" | "off_topic".
- done: true when the scenario should wrap up (from turn_index >= 5, wrap up naturally).

EXAMPLE A (turn 2, child, gentle; learner said "I like the red one"):
{"reply": "The red one is nice! Do you want it hot or cold?",
 "reply_zh": "红色的很好看！你要热的还是凉的？",
 "correction": {"has_error": false, "type": "none", "original": null, "better": null, "explain_zh": null, "severity": null},
 "suggested_replies": ["Hot, please.", "Cold, please.", "The red one, please."],
 "target_words": ["red", "hot", "cold"],
 "flag": "ok",
 "done": false}

EXAMPLE B (turn 2, adult, gentle; learner said "I want a coffee"):
{"reply": "Sure, one coffee. Would you like it to go or stay?",
 "reply_zh": "好的，一杯咖啡。您要带走还是在这儿喝？",
 "correction": {"has_error": true, "type": "politeness", "original": "I want a coffee", "better": "I'd like a coffee, please", "explain_zh": "点单时说 I'd like ... please 更自然礼貌。", "severity": "low"},
 "suggested_replies": ["To go, please.", "I'll stay, thanks.", "With milk, please."],
 "target_words": ["coffee", "go", "stay"],
 "flag": "ok",
 "done": false}"""

# 第一次返回不是合法 JSON / 缺 reply 时，用这段更严格的话再请求一次
STRICT_JSON_REMINDER = (
    "\n\nIMPORTANT: your previous answer was not valid JSON. "
    "Reply with ONE JSON object only - no markdown fence, no explanation, no extra text before or after. "
    'It must contain the key "reply".'
)


# --------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------
def trim_history(history: list[dict] | None, limit: int = MAX_HISTORY) -> list[dict]:
    """只保留最近 limit 条（控制 token，长对话不变贵不变慢）。"""
    items = [item for item in (history or []) if isinstance(item, dict)]
    return items[-limit:] if limit > 0 else []


def _last_user_text(history: list[dict]) -> str:
    for item in reversed(history or []):
        if str(item.get("role")) == "user":
            return str(item.get("text") or "")
    return ""


def _asked_questions(payload: dict, limit: int = 6) -> list[str]:
    """history 里已经问过的问题（含开场白），让模型不要重复。"""
    scenario = payload.get("scenario") or {}
    questions: list[str] = []
    opening = str(scenario.get("opening_line") or "").strip()
    if opening:
        questions.append(opening)
    for item in payload.get("history") or []:
        if not isinstance(item, dict) or str(item.get("role")) != "assistant":
            continue
        text = str(item.get("text") or "").strip()
        if text.endswith("?") and text not in questions:
            questions.append(text)
    return questions[-limit:]


def _is_unsafe(*texts: str) -> bool:
    joined = " ".join(t.lower() for t in texts if t)
    return any(word in joined for word in UNSAFE_WORDS)


def _word_count(text: str) -> int:
    return len([w for w in re.split(r"\s+", text.strip()) if w])


def detect_correction(text: str, correction_level: str) -> dict:
    """模板路径的纠错分级：gentle 只纠基础错，standard 连语序/用词一起纠，none 永不纠。"""
    if correction_level == "none" or not text.strip():
        return dict(_NO_CORRECTION)
    for pattern, ctype, better, explain, severity, min_level in _CORRECTION_RULES:
        if correction_level == "gentle" and min_level != "gentle":
            continue
        if re.search(pattern, text, flags=re.IGNORECASE):
            return {
                "has_error": True,
                "type": ctype,
                "original": text.strip(),
                "better": better,
                "explain_zh": explain,
                "severity": severity,
            }
    return dict(_NO_CORRECTION)


# --------------------------------------------------------------------------------------
# 模板降级
# --------------------------------------------------------------------------------------
def template_dialogue(payload: dict) -> dict:
    """无 LLM 时的固定话术（provider="template" 且 degraded_llm=true，绝不伪装成大模型）。"""
    scenario = payload.get("scenario") or {}
    history = trim_history(payload.get("history"))
    turn_index = int(payload.get("turn_index") or 0)
    correction_level = str(payload.get("correction_level") or "gentle")
    if correction_level not in CORRECTION_LEVELS:
        correction_level = "gentle"

    catalog = FALLBACK_SCENARIOS.get(str(scenario.get("id") or ""), FALLBACK_SCENARIOS["__default__"])
    step = min(max(turn_index, 0), len(catalog["replies"]) - 1)
    reply = catalog["replies"][step]
    reply_zh = catalog["replies_zh"][step]
    suggested = list(catalog["suggested"][step])
    target_words = list(catalog["target_words"])

    user_text = _last_user_text(history)
    flag = "ok"
    if _is_unsafe(reply, user_text):
        reply = SAFE_REPLY
        reply_zh = "我们聊点开心的事吧！你喜欢做什么？"
        flag = "unsafe_filtered"
        suggested = ["I like drawing.", "I like football.", "I like reading."]

    return {
        "provider": "template",
        "degraded_llm": True,
        "reply": reply,
        "reply_zh": reply_zh,
        "correction": detect_correction(user_text, correction_level),
        "suggested_replies": _normalize_suggestions(suggested),
        "target_words": target_words[:3],
        "flag": flag,
        "done": turn_index >= DONE_TURN_INDEX,
    }


def _normalize_suggestions(raw) -> list[str]:
    """suggested_replies：非空、≤6 词、去重（忽略大小写与结尾标点），2–3 条。"""
    out: list[str] = []
    seen: set[str] = set()
    for item in raw or []:
        text = str(item or "").strip().rstrip(".!?")
        if not text or _word_count(text) > MAX_SUGGESTION_WORDS:
            continue
        key = text.lower()
        if key in seen or _is_unsafe(text):
            continue
        seen.add(key)
        out.append(text if text.endswith((".", "!", "?")) else text + ".")
        if len(out) >= MAX_SUGGESTIONS:
            break
    if len(out) < MIN_SUGGESTIONS:
        for extra in FALLBACK_SCENARIOS["__default__"]["suggested"][0] + FALLBACK_SCENARIOS["ordering_coffee"]["suggested"][0]:
            text = str(extra).strip()
            key = text.lower()
            if not text or key in seen or _word_count(text) > MAX_SUGGESTION_WORDS:
                continue
            seen.add(key)
            out.append(text)
            if len(out) >= MIN_SUGGESTIONS:
                break
    return out[:MAX_SUGGESTIONS]


def _truncate_reply(reply: str) -> str:
    if len(reply) <= MAX_REPLY_CHARS:
        return reply
    logger.warning("dialogue reply 过长（%d 字符），已截断到 %d", len(reply), MAX_REPLY_CHARS)
    cut = reply[:MAX_REPLY_CHARS]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip() + "…"


def _normalize_correction(correction, correction_level: str) -> dict:
    """纠错兜底：分级、枚举、不编造（better 与 original 相同 => 视为无错）。"""
    if correction_level == "none" or not isinstance(correction, dict) or not correction.get("has_error"):
        return dict(_NO_CORRECTION)

    original = str(correction.get("original") or "").strip()
    better = str(correction.get("better") or "").strip()
    if not better or (original and better.lower() == original.lower()):
        # "纠正"没改变任何东西 => 视为没发现错误（宁可 has_error=false，也不挑刺）
        return dict(_NO_CORRECTION)

    ctype = str(correction.get("type") or "grammar")
    if ctype not in CORRECTION_TYPES or ctype == "none":
        ctype = "grammar"
    severity = str(correction.get("severity") or "low")
    if severity not in ("high", "medium", "low"):
        severity = "low"
    return {
        "has_error": True,
        "type": ctype,
        "original": original or None,
        "better": better,
        "explain_zh": str(correction.get("explain_zh") or "").strip() or None,
        "severity": severity,
    }


def sanitize_dialogue(data: dict, payload: dict) -> dict:
    """把 LLM 输出收敛成契约形状：数量/枚举/长度/安全全都兜底。"""
    history = trim_history(payload.get("history"))
    turn_index = int(payload.get("turn_index") or 0)
    correction_level = str(payload.get("correction_level") or "gentle")
    if correction_level not in CORRECTION_LEVELS:
        correction_level = "gentle"
    learner = payload.get("learner") or {}

    reply = _truncate_reply(str(data.get("reply") or "").strip())
    reply_zh = str(data.get("reply_zh") or "").strip()  # 缺失 -> 空串（不是 null）
    flag = str(data.get("flag") or "ok")
    if flag not in FLAGS:
        flag = "ok"

    # 安全：学习者说了不适宜内容，或模型自己产出了不安全内容 -> 温和转回
    user_text = _last_user_text(history)
    if _is_unsafe(reply, user_text):
        reply, reply_zh, flag = SAFE_REPLY, "我们聊点开心的事吧！你喜欢做什么？", "unsafe_filtered"
    elif learner.get("child_safe") and _is_unsafe(reply):
        reply, reply_zh, flag = SAFE_REPLY, "我们聊点开心的事情吧！", "unsafe_filtered"

    correction = _normalize_correction(data.get("correction"), correction_level)

    targets = [str(t).strip() for t in (data.get("target_words") or []) if str(t).strip()][:3]
    if not targets:
        targets = list(FALLBACK_SCENARIOS["__default__"]["target_words"])[:3]

    return {
        "reply": reply,
        "reply_zh": reply_zh,
        "correction": correction,
        "suggested_replies": _normalize_suggestions(data.get("suggested_replies")),
        "target_words": targets,
        "flag": flag,
        "done": bool(data.get("done")) or turn_index >= DONE_TURN_INDEX,
    }


# --------------------------------------------------------------------------------------
# user prompt
# --------------------------------------------------------------------------------------
def build_dialogue_user_prompt(payload: dict) -> str:
    scenario = payload.get("scenario") or {}
    learner = payload.get("learner") or {}
    history = trim_history(payload.get("history"))
    turn_index = int(payload.get("turn_index") or 0)
    asked = _asked_questions(payload)

    lines = [
        f"SCENARIO: {scenario.get('title')} / {scenario.get('title_zh')}",
        f"SETTING_ZH: {scenario.get('setting_zh')}",
        f"ROLE_PROMPT: {scenario.get('role_prompt')}",
        f"OPENING_LINE: {scenario.get('opening_line')}",
        f"SCENARIO_LEVEL: {scenario.get('level')}  MIN_AGE: {scenario.get('min_age')}",
        f"AGE_BAND: {learner.get('age_band') or 'adult'}   <-- apply this block from the system prompt",
        f"LEARNER_LEVEL: {learner.get('level')}  NATIVE: {learner.get('native_language')}  CHILD_SAFE: {learner.get('child_safe')}",
        f"CORRECTION_LEVEL: {payload.get('correction_level')}",
        f"TURN_INDEX: {turn_index}" + ("   (>= 5: wrap up naturally)" if turn_index >= 5 else ""),
        "ALREADY_ASKED (never repeat these questions):",
    ]
    lines.extend([f'  - "{question}"' for question in asked] or ["  - (none yet)"])
    lines.append(f"LAST_{len(history)}_TURNS:")
    lines.extend(f"  {item.get('role')}: {item.get('text')}" for item in history)
    lines.append("Reply with the JSON object only.")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------
# LLM 调用（含重试）与降级
# --------------------------------------------------------------------------------------
def _looks_usable(data) -> bool:
    return isinstance(data, dict) and bool(str(data.get("reply") or "").strip())


def complete_dialogue(llm, payload: dict, timeout_s: float = 30.0) -> dict:
    """LLM 优先：JSON 失败/缺 reply 时用更严格的话重试一次，仍失败才降级模板。

    返回体里始终带 `provider` 与 `degraded_llm`：
    - 大模型成功：provider = LLM 名称，degraded_llm = False
    - 降级模板：provider = "template"，degraded_llm = True（不伪装成大模型）
    """
    user_prompt = build_dialogue_user_prompt(payload)
    attempts = (
        (DIALOGUE_SYSTEM_PROMPT, user_prompt),
        (DIALOGUE_SYSTEM_PROMPT + STRICT_JSON_REMINDER, user_prompt + STRICT_JSON_REMINDER),
    )
    if getattr(llm, "available", False):
        for index, (system_prompt, prompt) in enumerate(attempts):
            outcome = llm.chat_json(system_prompt, prompt, timeout_s=timeout_s)
            if outcome.ok and _looks_usable(outcome.data):
                cleaned = sanitize_dialogue(outcome.data, payload)
                if cleaned.get("reply"):
                    logger.info("dialogue served by %s (attempt %d)", outcome.provider, index + 1)
                    return {"provider": outcome.provider, "degraded_llm": False, **cleaned}
            logger.warning(
                "dialogue LLM attempt %d unusable (error=%s)", index + 1, getattr(outcome, "error", None)
            )

    fallback = template_dialogue(payload)
    fallback["degraded_llm"] = True
    return fallback


def dialogue_json(payload: dict, outcome_data: dict) -> dict:
    return sanitize_dialogue(outcome_data, payload)


__all__ = [
    "template_dialogue",
    "dialogue_json",
    "sanitize_dialogue",
    "detect_correction",
    "build_dialogue_user_prompt",
    "complete_dialogue",
    "trim_history",
    "DIALOGUE_SYSTEM_PROMPT",
    "STRICT_JSON_REMINDER",
    "CORRECTION_TYPES",
    "CORRECTION_LEVELS",
    "FLAGS",
    "MAX_HISTORY",
    "DONE_TURN_INDEX",
    "json",
]
