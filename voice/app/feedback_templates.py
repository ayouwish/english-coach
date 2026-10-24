"""模板反馈：LLM 不可用（或无 key）时的离线降级，provider 字段固定为 "template"。

儿童模式硬约束（契约 §5）：文案必须避开 IPA 符号，用"音"和口型描述代替；
语气必须鼓励，不得出现批评性词汇。
"""

from __future__ import annotations

import re
from typing import Any

from .hints import PHONEME_HINT, derive_hint_key, severity_from_score
from .phonemes import canonicalize_phoneme as canonical_phoneme

# hint_key -> 教学提示（中文）
HINT_TEMPLATES: dict[str, dict[str, Any]] = {
    "th_voiceless": {
        "title": "“{word}”里的 th 音（θ）",
        "why": "舌尖没有伸出来，气流从牙龈缝隙出去了，听上去更像 s。",
        "how": "舌尖轻轻伸到上下齿之间，让气流从缝里摩擦出来，声带不振动。",
        "practice_words": ["think", "thank", "three", "thick"],
        "demo_text": "think, thank, three",
    },
    "th_voiced": {
        "title": "“{word}”里的 th 音（ð）",
        "why": "这个 th 需要声带轻轻振动，读成了 z 或 d 就不对了。",
        "how": "舌尖放在上下齿之间，一边出声一边让气流摩擦，喉咙有轻微振动。",
        "practice_words": ["this", "that", "mother", "weather"],
        "demo_text": "this, that, weather",
    },
    "r_l_v": {
        "title": "“{word}”里的 r / l 音",
        "why": "舌头位置不够到位，r 和 l 听起来换了个位置。",
        "how": "读 r 时舌尖向后卷但不要碰到上颚；读 l 时舌尖顶住上齿龈再放开。",
        "practice_words": ["really", "red", "little", "light"],
        "demo_text": "really, little, red",
    },
    "v_w": {
        "title": "“{word}”里的 v / w 音",
        "why": "v 要用上齿轻碰下唇，w 要圆唇，两个音容易互换。",
        "how": "读 v 时上齿轻碰下唇并出声；读 w 时嘴唇先收圆再放开。",
        "practice_words": ["very", "voice", "water", "well"],
        "demo_text": "very, water, well",
    },
    "short_i_long_i": {
        "title": "“{word}”里的长短 i 音",
        "why": "短音要放松又快，长音要拉长，读混了会变成另一个词。",
        "how": "短音像轻轻地“一”，嘴和下巴都放松；长音要拉长并带一点滑动。",
        "practice_words": ["sit", "seat", "ship", "sheep"],
        "demo_text": "sit, seat, ship, sheep",
    },
    "ae_e": {
        "title": "“{word}”里的 a / e 音",
        "why": "a 的口型要更大、下巴更往下，e 的口型更扁。",
        "how": "读 a 时嘴巴张大、下巴放低；读 e 时嘴角向两边微微拉开。",
        "practice_words": ["cat", "bed", "apple", "pen"],
        "demo_text": "cat, bed, apple",
    },
    "s_sh": {
        "title": "“{word}”里的 s / sh 音",
        "why": "sh 要把嘴唇稍微收圆、舌面抬高，s 则是舌尖靠近齿龈。",
        "how": "读 sh 时嘴唇略圆、舌尖后移；读 s 时舌尖靠近上齿龈，气流细而尖。",
        "practice_words": ["see", "she", "sea", "shoe"],
        "demo_text": "see, she, shoe",
    },
    "n_ng": {
        "title": "“{word}”里的 n / ng 音",
        "why": "词尾的 ng 舌根要抬起，读成 n 就丢了鼻音位置。",
        "how": "读 ng 时舌根抬起贴住软腭，让声音从鼻腔出来。",
        "practice_words": ["thin", "thing", "sun", "sung"],
        "demo_text": "thin, thing, sung",
    },
    "l_dark": {
        "title": "“{word}”词尾的 l",
        "why": "词尾 l 容易被吞掉，听起来像少了一个音。",
        "how": "舌尖顶住上齿龈并保持一会儿，再轻轻放开。",
        "practice_words": ["well", "school", "apple", "little"],
        "demo_text": "well, school, apple",
    },
    "schwa": {
        "title": "“{word}”里的弱读音",
        "why": "非重读音节要读得又轻又短，读得太重会让整句节奏变硬。",
        "how": "把非重读音节轻轻带过，像中文里轻轻的一声“呃”。",
        "practice_words": ["today", "banana", "about", "again"],
        "demo_text": "today, banana, again",
    },
    "final_consonant": {
        "title": "“{word}”的词尾音",
        "why": "词尾的辅音没有发出来，词就少了一截。",
        "how": "把最后一个音清楚地收住，不要提前闭嘴，也不要加多余的元音。",
        "practice_words": ["good", "hot", "nice", "book"],
        "demo_text": "good, hot, nice, book",
    },
    "consonant_cluster": {
        "title": "“{word}”里的辅音连缀",
        "why": "两个辅音连在一起时中间容易多出一个元音，或者干脆吞掉一个。",
        "how": "先把每个辅音单独慢慢读清楚，再连起来加快，中间不要加“呃”。",
        "practice_words": ["school", "street", "spring", "desk"],
        "demo_text": "school, street, spring",
    },
    "stress_wrong": {
        "title": "“{word}”的重音位置",
        "why": "重音放错地方，听上去会像另一个词。",
        "how": "把重读音节读得更响更长，其他音节轻轻带过。",
        "practice_words": ["banana", "today", "really", "English"],
        "demo_text": "banana, today, English",
    },
    "monotone": {
        "title": "整句语调太平",
        "why": "每个词都一样高，听起来像在念清单。",
        "how": "句子中间稍微起伏，句尾自然地降下来；问句要往上扬。",
        "practice_words": ["really", "nice", "today", "weather"],
        "demo_text": "It's really nice today.",
    },
    "pause_wrong": {
        "title": "句子停顿的位置",
        "why": "停顿放错地方，听的人会误会句子的意思。",
        "how": "在短语之间换气，不要在词组中间停下来。",
        "practice_words": ["today", "weather", "really", "nice"],
        "demo_text": "I think / the weather / is really nice today.",
    },
    "omission": {
        "title": "“{word}”好像没说出口",
        "why": "这个词漏掉了，句子的意思会缺一块。",
        "how": "放慢一点，把每个词都轻轻说出来，跟读时可以手指点着词走。",
        "practice_words": ["think", "weather", "really", "today"],
        "demo_text": "I think the weather is really nice today.",
    },
    "insertion": {
        "title": "多读了一个词",
        "why": "句子里多出来的词会让听的人有点困惑。",
        "how": "跟读时先看清句子，读完对照一下原文，多出来的音轻轻去掉。",
        "practice_words": ["think", "weather", "nice", "today"],
        "demo_text": "I think the weather is really nice today.",
    },
}

_DEFAULT_TEMPLATE = {
    "title": "“{word}”这个音再清楚一点",
    "why": "这个音的位置还不太稳，听起来有点模糊。",
    "how": "先慢慢读一遍，注意嘴型和舌头的位置，再正常速度读一次。",
    "practice_words": ["think", "weather", "really", "today"],
    "demo_text": "I think the weather is really nice today.",
}

# 注意：键必须包含**非 ASCII 的 IPA 字符**。像 "i"/"n"/"s" 这种与拉丁字母同形的符号不能进表，
# 否则儿童模式会把普通英文单词（think -> th长 i 音n 音k）改坏。
IPA_FRIENDLY = {
    "θ": "th 音",
    "ð": "th 音（浊）",
    "ʃ": "sh 音",
    "ʒ": "zh 音",
    "æ": "大口 a 音",
    "ʌ": "短 a 音",
    "ə": "轻轻的弱读音",
    "ɪ": "短 i 音",
    "ʊ": "短 u 音",
    "ɔ": "o 音",
    "ɜ": "er 音",
    "ŋ": "ng 音",
    "ɹ": "r 音",
    "ɑ": "a 音",
    "ɛ": "e 音",
    "ɡ": "g 音",
    "ɒ": "o 音",
    "aɪ": "ai 音",
    "eɪ": "ei 音",
    "oʊ": "ou 音",
    "əʊ": "ou 音",
    "aʊ": "ao 音",
    "ɔɪ": "oi 音",
    "dʒ": "j 音",
    "tʃ": "ch 音",
}

_IPA_RE = re.compile(r"[θðʃʒæʌəɪʊɔɜŋɹɡɑɛɒʉɐɤɵçʝɾɽʈɖɳɭɻʀχʁħʕʔˈˌː]")
_TRAILING_PAREN_RE = re.compile(r"[（(][^）)]*[）)]\s*$")


def friendly_phoneme(phoneme: str | None) -> str:
    if not phoneme:
        return "这个音"
    return IPA_FRIENDLY.get(phoneme, phoneme)


def strip_ipa(text: str) -> str:
    """儿童模式：把 IPA 符号换成口型描述，普通英文字母原样保留。"""
    if not text:
        return ""
    for symbol, name in sorted(IPA_FRIENDLY.items(), key=lambda item: -len(item[0])):
        text = text.replace(symbol, name)
    return _IPA_RE.sub("", text)


def child_title(title: str) -> str:
    """儿童模式的标题：去掉末尾括号里的 IPA，再替换残余 IPA。"""
    return strip_ipa(_TRAILING_PAREN_RE.sub("", title or "").strip())


# --------------------------------------------------------------------------------------
# "基本没听到语音" 分支（用户实况：recognized_text="."、四项全 0、每个词都 Omission）
# --------------------------------------------------------------------------------------
_WORD_RE = re.compile(r"[A-Za-z']+")

# 表扬词黑名单：这个分支里一个都不许出现（对 8 岁孩子，"没被听到"却先被夸是误导）
PRAISE_MARKERS: tuple[str, ...] = (
    "棒",
    "说出来了",
    "坚持读完",
    "读得很好",
    "读得不错",
    "很不错",
    "非常好",
    "真棒",
    "厉害",
    "特别清楚",
    "有进步",
)

# 可执行的三条排查（不许只说"再试一次"）
MIC_CHECKS_CHILD: tuple[str, ...] = (
    "离麦克风近一点，嘴巴对着它说",
    "说大声一点点，像在跟我说话一样",
    "先点一下「听示范」，跟着节奏读一遍",
)
MIC_CHECKS_ADULT: tuple[str, ...] = (
    "靠近麦克风，嘴与麦克风保持 15–20cm",
    "说大声一点，比平时说话的音量再高一些",
    "先点「听示范」听一遍节奏，再跟读",
)


def _checks_text(checks: tuple[str, ...]) -> str:
    return "；".join(f"{idx}. {item}" for idx, item in enumerate(checks, start=1))


def _score_values(scores: dict) -> list[float]:
    return [
        float(value)
        for value in (scores.get(key) for key in ("pron", "accuracy", "fluency", "completeness"))
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    ]


def is_no_speech_payload(payload: dict) -> bool:
    """判断"这一句基本没被录进来"。

    触发条件（满足其一）：
    1. `recognized_text` 字段存在，但去掉标点后**没有任何英文词**（实况里的 `"."`）；
    2. 四个分项全为 0，且 issues 里 Omission 占 ≥80%（至少 3 条），或所有词都是 Omission；
    3. 四个分项全为 0，且 warnings 同时带 `low_snr` + `asr_mismatch`。

    反例保护：payload 里**没有** `recognized_text`（契约 §5 的请求本来就不要求这个字段）时，
    绝不能因为"字段缺失"就判成没听到 —— 必须靠分数/issue 证据。
    """
    scores = payload.get("scores") or {}
    values = _score_values(scores)
    all_zero = bool(values) and all(value <= 0.0 for value in values)

    issues = [item for item in (payload.get("issues") or []) if isinstance(item, dict)]
    words = [item for item in (payload.get("words") or []) if isinstance(item, dict)]
    omissions_issue = sum(1 for item in issues if str(item.get("type") or "") == "Omission")
    omissions_word = sum(1 for item in words if str(item.get("error_type") or "") == "Omission")

    if "recognized_text" in payload and payload.get("recognized_text") is not None:
        recognized = str(payload.get("recognized_text") or "")
        if not _WORD_RE.findall(recognized):
            return True

    # 每个词都是 Omission（>=2 个词）本身就很强：识别器一个词都没听到。
    # 分数可能缺失（web 未回传）或全 0，两种都算。
    if words and len(words) >= 2 and omissions_word == len(words) and (not values or all_zero):
        return True

    if not all_zero:
        return False

    if issues and len(issues) >= 3 and omissions_issue / len(issues) >= 0.8:
        return True

    warnings = payload.get("warnings")
    if isinstance(warnings, list):
        flags = {str(item) for item in warnings}
        if {"low_snr", "asr_mismatch"} <= flags:
            return True
    return False


def _no_speech_feedback(payload: dict, child: bool) -> dict:
    """"基本没听到语音"专用反馈：**不含任何表扬**，只给可执行的三步排查。"""
    reference_text = str(payload.get("reference_text") or "")
    reference_words: list[str] = []
    for token in _WORD_RE.findall(reference_text):
        if token.lower() not in {word.lower() for word in reference_words}:
            reference_words.append(token)

    checks = MIC_CHECKS_CHILD if child else MIC_CHECKS_ADULT
    if child:
        summary = "我好像没听到你的声音，我们再试一次好吗？"
        praise = "不着急，我们先把声音送进麦克风里。"
        title = "先检查三件小事"
        why = "这段录音里几乎没有声音，可能是麦克风没有收到。"
        closing = "准备好了就再读一次，我在这儿听着呢 🔊"
    else:
        summary = "这次录音里几乎没有识别到语音，先确认一下设备再试一次。"
        praise = "我们把录音环境调好，再重新录一遍。"
        title = "先做三项检查"
        why = "这段音频里没有可识别的语音内容。"
        closing = "调整好后请再录一次 🔊"

    point = {
        "title": title,
        "why": why,
        "how": _checks_text(checks),
        "practice_words": reference_words[:4],
        "demo_text": reference_text,
        "severity": "medium",
    }
    return {
        "provider": "template",
        "summary": summary,
        "praise": praise,
        "points": [point],
        "closing": closing,
    }

def _summary_for(pron: float | None, child: bool) -> str:
    if pron is None:
        return "这次录音已经保存好了，我们再读一遍试试？" if child else "这次没有拿到完整分数，可以再读一遍。"
    if pron >= 85:
        return "这一句读得很棒，发音很清楚 👍" if child else "整体非常好，发音清晰自然。"
    if pron >= 70:
        return "整句都读下来了，再打磨两个小地方就更棒啦 👍" if child else "整体不错，个别音再打磨一下会更好。"
    if pron >= 55:
        return "已经很接近了，我们挑一个音慢慢练一下 😊" if child else "基本可懂，建议针对下面的音做专项练习。"
    return "我们一起慢慢来，先听一遍示范再读 😊" if child else "建议先跟读示范音频，再从单词开始练。"


def _praise_for(reference_text: str, words: list[dict], child: bool) -> str:
    good = [w.get("word") for w in (words or []) if (w.get("score") or 0) >= 80]
    picks = [w for w in good if w][:2]
    if picks:
        joined = " 和 ".join(picks)
        return f"{joined} 都说得很清楚。" if not child else f"{joined} 读得特别清楚！"

    scored = [w for w in (words or []) if isinstance(w, dict)]
    nothing_heard = bool(scored) and all(
        float(w.get("score") or 0) <= 0 or str(w.get("error_type") or "") == "Omission" for w in scored
    )
    if nothing_heard:
        # 一个词都没被听到：不许编造"整句都说出来了/坚持读完了"
        return "我们先确认一下麦克风，再一起读一次。" if child else "先确认录音设备，再重新录一遍。"
    return "整句都坚持读完了，很不错。" if not child else "你把整句都说出来了，真棒！"


def _sentence_words_with_phoneme(reference_text: str, phoneme: str | None, limit: int = 4) -> list[str]:
    """从参考句里挑出**真的包含这个音素**的词（用于"练习词必须相关"）。"""
    if not phoneme:
        return []
    from .phonemes import canonicalize_phoneme
    from .text import tokens, word_phonemes

    target = canonicalize_phoneme(phoneme)
    found: list[str] = []
    for token in tokens(reference_text):
        if token in found:
            continue
        if target in word_phonemes(token):
            found.append(token)
        if len(found) >= limit:
            break
    return found


def _select_issues(issues: list[dict]) -> list[dict]:
    def rank(item: dict) -> tuple:
        severity = str(item.get("severity") or "medium")
        order = {"high": 0, "medium": 1, "low": 2}.get(severity, 3)
        return (order, float(item.get("score") or 100.0))

    return sorted(issues or [], key=rank)[:2]


def template_feedback(payload: dict) -> dict:
    """基于 hint_key 查表的离线反馈（契约 §5：provider="template"，HTTP 200）。"""
    learner = payload.get("learner") or {}
    child = str(learner.get("age_band") or "adult") == "child"
    if is_no_speech_payload(payload):
        # 硬要求：整句没被录进来时，不得出现任何表扬词，也不做逐词指责
        return _no_speech_feedback(payload, child)
    scores = payload.get("scores") or {}
    pron = scores.get("pron")
    issues = _select_issues(payload.get("issues") or [])
    reference_text = str(payload.get("reference_text") or "")
    intonation = payload.get("intonation") or {}
    worst = (intonation.get("worst_regions") or []) if isinstance(intonation, dict) else []

    points: list[dict] = []
    for issue in issues:
        word = str(issue.get("word") or "")
        ph = issue.get("phoneme")
        actual = issue.get("actual")
        hint_key = derive_hint_key(
            phoneme=ph if isinstance(ph, str) else None,
            actual=actual if isinstance(actual, str) else None,
            word=word,
            error_type=str(issue.get("type") or "Mispronunciation"),
            explicit=issue.get("hint_key") if isinstance(issue.get("hint_key"), str) else None,
        )
        template = HINT_TEMPLATES.get(hint_key, _DEFAULT_TEMPLATE)
        issue_type = str(issue.get("type") or "Mispronunciation")
        actual_text = actual.strip() if isinstance(actual, str) else ""
        title = template["title"].format(word=word or "这个词")
        why = template["why"]
        how = template["how"]
        # 逐词类问题的练习素材必须与**这个词本身**相关，不能复用通用提示词表（张冠李戴）
        practice_words = list(template["practice_words"])
        demo_text = template["demo_text"]
        if issue_type == "Omission":
            practice_words = [word] if word else []
            demo_text = word or demo_text
        elif issue_type == "Insertion":
            practice_words = [word] if word else []
            demo_text = reference_text or demo_text
        elif issue_type in ("UnexpectedBreak", "MissingBreak"):
            practice_words = [word] if word else []
        # 音素已知、但提示表里没有它的专用条目时，`derive_hint_key` 只能按**单词拼写**猜
        # （例如 today /eɪ/ 被猜成"词尾音"），教学内容和练习词都会张冠李戴。这里改用中性卡片，
        # 练习词从句子中**真正含这个音素**的词里挑。
        if issue_type == "Mispronunciation" and ph and canonical_phoneme(ph) not in PHONEME_HINT:
            related = _sentence_words_with_phoneme(reference_text, ph) or ([word] if word else [])
            practice_words = related[:4]
            demo_text = ", ".join(related[:3]) or (word or "")
            why = "这个音还不够清楚，我们把它单独放慢读一遍。"
            how = "先慢慢读这个词，注意嘴型和舌头的位置，再按正常速度读一次。"
            if child:
                title = f"“{word}”里的这个音还不够清楚" if word else "这个音还不够清楚"
            else:
                title = f"“{word}”里的 {canonical_phoneme(ph)} 音还不够清楚" if word else f"{canonical_phoneme(ph)} 音还不够清楚"
        # actual 缺失时不许编造"你读成了 X"
        elif issue_type == "Mispronunciation" and not actual_text:
            why = "这个音还不够清楚，我们把它单独放慢读一遍。"
            if not child and ph:
                title = f"{title} 没读准"
        # severity：调用方没给就按分数/错误类型推导（契约要求 severity 有明确映射）
        severity = str(issue.get("severity") or "")
        if severity not in ("high", "medium", "low"):
            severity = severity_from_score(
                issue.get("score") if isinstance(issue.get("score"), (int, float)) else None,
                str(issue.get("type") or "Mispronunciation"),
            )
        if not child and ph and actual_text:
            title = f"{title} 读成了 {actual_text}"
        if child:
            title = child_title(title)
            why = strip_ipa(why)
            how = strip_ipa(how)
        points.append(
            {
                "title": title,
                "why": why,
                "how": how,
                "practice_words": practice_words,
                "demo_text": demo_text,
                "severity": severity,
            }
        )

    if not points and worst:
        region = worst[0]
        issue_type = str(region.get("issue") or "")
        hint_key = "monotone" if issue_type in ("expected_rise_but_flat", "expected_fall_but_flat", "monotone_overall") else "pause_wrong"
        template = HINT_TEMPLATES.get(hint_key, _DEFAULT_TEMPLATE)
        text = str(region.get("text") or "")
        title = template["title"].format(word=text or "整句")
        points.append(
            {
                "title": strip_ipa(title) if child else title,
                "why": template["why"],
                "how": template["how"],
                "practice_words": list(template["practice_words"]),
                "demo_text": reference_text or template["demo_text"],
                "severity": "low",
            }
        )

    points = points[:2]  # 硬约束：最多 2 条
    return {
        "provider": "template",
        "summary": strip_ipa(_summary_for(pron, child)) if child else _summary_for(pron, child),
        "praise": strip_ipa(_praise_for(payload.get("reference_text") or "", payload.get("words") or [], child))
        if child
        else _praise_for(payload.get("reference_text") or "", payload.get("words") or [], child),
        "points": points,
        "closing": "再跟我读一次好吗？我先读一遍你跟着读 🔊" if child else "再录一遍试试，注意上面的要点 🔊",
    }


# --------------------------------------------------------------------------------------
# LLM prompt + 结果校验
# --------------------------------------------------------------------------------------
FEEDBACK_SYSTEM_PROMPT = """You are a warm English pronunciation coach for a Chinese family.
Return ONLY a JSON object with keys: summary, praise, points, closing.
- summary, praise, closing: Simplified Chinese, 1 sentence each, encouraging.
- points: at most 2 items, each {"title","why","how","practice_words","demo_text","severity"}.
  * title/why/how: Simplified Chinese, concrete and short.
  * practice_words: 3-4 English words; demo_text: a short English practice phrase.
  * severity: "high" | "medium" | "low".
Never invent phoneme scores; use only the numbers given in the input."""

CHILD_EXTRA_RULE = (
    "IMPORTANT: the learner is a 6-9 year old child. Never use IPA symbols (θ, ð, ʃ, æ, ...) "
    "in any Chinese field; describe the sound with letters and mouth positions instead. "
    "Never use negative or critical wording. Be playful and encouraging."
)


def build_feedback_user_prompt(payload: dict, llm_available: bool) -> str:
    import json

    trimmed = {
        "reference_text": payload.get("reference_text"),
        "scores": payload.get("scores"),
        "issues": payload.get("issues"),
        "intonation": payload.get("intonation"),
        "learner": payload.get("learner"),
        "words": [
            {"word": w.get("word"), "score": w.get("score"), "error_type": w.get("error_type")}
            for w in (payload.get("words") or [])
        ][:40],
    }
    return json.dumps(trimmed, ensure_ascii=False)


def sanitize_feedback(data: dict, child: bool) -> dict:
    """截断到 ≤2 条，并把儿童模式下的 IPA 全部去掉。"""
    points = []
    for item in (data.get("points") or [])[:2]:
        if not isinstance(item, dict):
            continue
        point = {
            "title": str(item.get("title") or ""),
            "why": str(item.get("why") or ""),
            "how": str(item.get("how") or ""),
            "practice_words": [str(w) for w in (item.get("practice_words") or [])][:5],
            "demo_text": str(item.get("demo_text") or ""),
            "severity": str(item.get("severity") or "medium"),
        }
        if point["severity"] not in ("high", "medium", "low"):
            point["severity"] = "medium"
        if child:
            point["title"] = strip_ipa(point["title"])
            point["why"] = strip_ipa(point["why"])
            point["how"] = strip_ipa(point["how"])
        points.append(point)
    out = {
        "summary": str(data.get("summary") or ""),
        "praise": str(data.get("praise") or ""),
        "points": points,
        "closing": str(data.get("closing") or ""),
    }
    if child:
        out["summary"] = strip_ipa(out["summary"])
        out["praise"] = strip_ipa(out["praise"])
        out["closing"] = strip_ipa(out["closing"])
    return out
