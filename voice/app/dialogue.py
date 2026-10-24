"""对话训练单轮推进：LLM 优先，失败/无 key 时固定话术降级（provider="template"）。"""

from __future__ import annotations

import json
import re
from typing import Any

CORRECTION_TYPES = ("grammar", "vocabulary", "politeness", "pronunciation", "none")
CORRECTION_LEVELS = ("gentle", "standard", "none")
FLAGS = ("ok", "unsafe_filtered", "off_topic")
DONE_TURN_INDEX = 6

# 固定话术降级：按 scenario.id 给一套「店员/老师/朋友」式推进（离线也能练）
FALLBACK_SCENARIOS: dict[str, dict[str, Any]] = {
    "ordering_coffee": {
        "replies": ["Sure! Hot or iced?", "Great choice. Anything to eat?", "Coming right up! That's 3 dollars."],
        "replies_zh": ["好的！热的还是冰的？", "很好的选择。要来点吃的吗？", "马上就好！一共三美元。"],
        "suggested": [["Hot, please.", "Iced, please.", "Hot, please. Thank you."], ["No, thanks.", "Yes, a cookie please.", "Just the coffee, thanks."], ["Here you are.", "Thank you!", "Here you are. Thanks!"]],
        "target_words": ["hot", "iced", "please"],
    },
    "greeting": {
        "replies": ["Hi! How are you today?", "That's great! What did you do today?", "Nice! See you next time!"],
        "replies_zh": ["你好！你今天怎么样？", "太好了！你今天做了什么？", "真棒！下次见！"],
        "suggested": [["I'm fine, thank you.", "I'm happy!", "I'm fine. And you?"], ["I played with my friend.", "I read a book.", "I went to school."], ["See you!", "Bye bye!", "See you next time!"]],
        "target_words": ["fine", "happy", "today"],
    },
    "school_day": {
        "replies": ["Nice! What class do you like best?", "Math is fun! What did you learn today?", "Great job! Let's talk again tomorrow."],
        "replies_zh": ["真不错！你最喜欢哪节课？", "数学很有趣！你今天学了什么？", "做得好！我们明天再聊。"],
        "suggested": [["I like English.", "I like math.", "I like art class."], ["I learned numbers.", "I learned new words.", "We read a story."], ["See you tomorrow!", "Bye!", "Thank you, bye!"]],
        "target_words": ["class", "learn", "like"],
    },
    "__default__": {
        "replies": ["Nice! Tell me more.", "That sounds good! What happened next?", "Great talking with you! See you next time."],
        "replies_zh": ["不错！再多说一点。", "听起来很好！后来呢？", "和你聊天很开心！下次见。"],
        "suggested": [["Yes, I like it.", "It's fun.", "I don't know."], ["I think so too.", "Really? Tell me more.", "That's cool!"], ["See you!", "Thank you!", "Bye bye!"]],
        "target_words": ["nice", "good", "fun"],
    },
}

SAFE_REPLY = "Let's talk about something fun! What do you like to do?"
UNSAFE_WORDS = ("kill", "gun", "blood", "stupid", "hate you", "die")

_CORRECTION_RULES: list[tuple[str, str, str, str, str]] = [
    (r"\bi\s+want\b", "politeness", "I'd like ..., please.", "点单或请求时用 I'd like 比 I want 更礼貌。", "low"),
    (r"\b(i|you|we|they)\s+is\b", "grammar", "I am / you are ...", "be 动词要和主语搭配：I am、you are。", "medium"),
    (r"\b(he|she|it)\s+(go|like|want|play|have)\b", "grammar", "he/she/it + 动词加 -s", "第三人称单数后面的动词要加 -s。", "medium"),
    (r"\bmore\s+better\b", "grammar", "better", "better 本身已经是比较级，不用再加 more。", "low"),
    (r"\bi\s+no\s+\w+", "grammar", "I don't ...", "否定句要用 don't / doesn't，不是 no。", "medium"),
    (r"\bvery\s+much\s+like\b", "vocabulary", "like ... very much", "语序上通常说 like it very much。", "low"),
]

DIALOGUE_SYSTEM_PROMPT = """You are an English conversation partner for a Chinese family.
Follow the scenario role instructions exactly. Keep every reply under 15 words and ask one question at a time.
Return ONLY a JSON object with keys:
reply (English), reply_zh (Simplified Chinese translation), correction, suggested_replies, target_words, flag, done.
correction = {"has_error": bool, "type": "grammar"|"vocabulary"|"politeness"|"pronunciation"|"none",
              "original": str|null, "better": str|null, "explain_zh": str|null, "severity": "high"|"medium"|"low"|null}
- At most one correction; if the learner's sentence is fine set has_error=false and the other fields null.
suggested_replies: 2-3 short replies the learner can actually say at their level.
flag: "ok" | "unsafe_filtered" | "off_topic". done: true only when the scenario should wrap up."""


def _last_user_text(history: list[dict]) -> str:
    for item in reversed(history or []):
        if str(item.get("role")) == "user":
            return str(item.get("text") or "")
    return ""


def detect_correction(text: str, correction_level: str) -> dict:
    if correction_level == "none" or not text.strip():
        return {"has_error": False, "type": "none", "original": None, "better": None, "explain_zh": None, "severity": None}
    for pattern, ctype, better, explain, severity in _CORRECTION_RULES:
        if re.search(pattern, text, flags=re.IGNORECASE):
            return {
                "has_error": True,
                "type": ctype,
                "original": text.strip(),
                "better": better,
                "explain_zh": explain,
                "severity": severity,
            }
    return {"has_error": False, "type": "none", "original": None, "better": None, "explain_zh": None, "severity": None}


def _is_unsafe(*texts: str) -> bool:
    joined = " ".join(t.lower() for t in texts if t)
    return any(word in joined for word in UNSAFE_WORDS)


def template_dialogue(payload: dict) -> dict:
    scenario = payload.get("scenario") or {}
    history = payload.get("history") or []
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
        "reply": reply,
        "reply_zh": reply_zh,
        "correction": detect_correction(user_text, correction_level),
        "suggested_replies": suggested[:3],
        "target_words": target_words,
        "flag": flag,
        "done": turn_index >= DONE_TURN_INDEX,
    }


def sanitize_dialogue(data: dict, payload: dict) -> dict:
    scenario = payload.get("scenario") or {}
    history = payload.get("history") or []
    turn_index = int(payload.get("turn_index") or 0)
    correction_level = str(payload.get("correction_level") or "gentle")
    if correction_level not in CORRECTION_LEVELS:
        correction_level = "gentle"

    reply = str(data.get("reply") or "").strip()
    reply_zh = str(data.get("reply_zh") or "").strip()
    flag = str(data.get("flag") or "ok")
    if flag not in FLAGS:
        flag = "ok"

    user_text = _last_user_text(history)
    if _is_unsafe(reply, user_text):
        reply, reply_zh, flag = SAFE_REPLY, "我们聊点开心的事吧！你喜欢做什么？", "unsafe_filtered"

    correction = data.get("correction") if isinstance(data.get("correction"), dict) else None
    if correction_level == "none" or not correction or not correction.get("has_error"):
        correction = {"has_error": False, "type": "none", "original": None, "better": None, "explain_zh": None, "severity": None}
    else:
        ctype = str(correction.get("type") or "grammar")
        if ctype not in CORRECTION_TYPES or ctype == "none":
            ctype = "grammar"
        severity = str(correction.get("severity") or "low")
        if severity not in ("high", "medium", "low"):
            severity = "low"
        correction = {
            "has_error": True,
            "type": ctype,
            "original": correction.get("original"),
            "better": correction.get("better"),
            "explain_zh": correction.get("explain_zh"),
            "severity": severity,
        }

    suggested = [str(s) for s in (data.get("suggested_replies") or []) if str(s).strip()][:3]
    if len(suggested) < 2:
        suggested = (suggested + FALLBACK_SCENARIOS["__default__"]["suggested"][0])[:2]
    targets = [str(t) for t in (data.get("target_words") or [])][:5]

    done = bool(data.get("done")) or turn_index >= DONE_TURN_INDEX
    # 儿童安全：场景要求 child_safe 时不允许任何不安全内容
    learner = payload.get("learner") or {}
    if learner.get("child_safe") and _is_unsafe(reply):
        reply, reply_zh, flag = SAFE_REPLY, "我们聊点开心的事情吧！", "unsafe_filtered"

    return {
        "reply": reply,
        "reply_zh": reply_zh,
        "correction": correction,
        "suggested_replies": suggested,
        "target_words": targets or list(FALLBACK_SCENARIOS["__default__"]["target_words"]),
        "flag": flag,
        "done": done,
    }


def build_dialogue_user_prompt(payload: dict) -> str:
    scenario = payload.get("scenario") or {}
    learner = payload.get("learner") or {}
    lines = [
        f"SCENARIO: {scenario.get('title')} / {scenario.get('title_zh')}",
        f"SETTING_ZH: {scenario.get('setting_zh')}",
        f"ROLE_PROMPT: {scenario.get('role_prompt')}",
        f"OPENING_LINE: {scenario.get('opening_line')}",
        f"LEVEL: {scenario.get('level')}  MIN_AGE: {scenario.get('min_age')}",
        f"LEARNER: age_band={learner.get('age_band')} level={learner.get('level')} native={learner.get('native_language')} child_safe={learner.get('child_safe')}",
        f"CORRECTION_LEVEL: {payload.get('correction_level')}",
        f"TURN_INDEX: {payload.get('turn_index')}",
        "HISTORY:",
    ]
    for item in payload.get("history") or []:
        lines.append(f"  {item.get('role')}: {item.get('text')}")
    lines.append("Reply with the JSON object only.")
    return "\n".join(lines)


def dialogue_json(payload: dict, outcome_data: dict) -> dict:
    return sanitize_dialogue(outcome_data, payload)


__all__ = [
    "template_dialogue",
    "dialogue_json",
    "sanitize_dialogue",
    "detect_correction",
    "build_dialogue_user_prompt",
    "DIALOGUE_SYSTEM_PROMPT",
    "CORRECTION_TYPES",
    "CORRECTION_LEVELS",
    "FLAGS",
    "json",
]
