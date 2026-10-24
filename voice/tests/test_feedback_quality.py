"""task-13 回归：反馈质量（虚假表扬 / 练习词张冠李戴 / 编造 actual）。

三个真实场景（截图与数据库已确认）：
1. 整句没被录进来（recognized_text="."、四项全 0、每个词都 Omission）却夸"你把整句都说出来了"；
2. `Good` 漏读，练习词却是通用表的 `think · weather · really · today`；
3. `today /eɪ/ → None` 的卡片不能编造"你读成了 X"。
"""

from __future__ import annotations

import pytest

from app.feedback_templates import PRAISE_MARKERS, is_no_speech_payload, template_feedback

# 表扬词黑名单：这个分支里一个都不许出现（含 lead 点名的"棒/好/说出来了/坚持读完"类）
EXTRA_PRAISE = ("真棒", "很棒", "说出来了", "坚持读完", "读得", "很好", "不错", "厉害", "清楚")
ALL_PRAISE = tuple(dict.fromkeys(PRAISE_MARKERS + EXTRA_PRAISE))


def _words(text: str) -> list[str]:
    return [w for w in text.replace(",", " ").replace("?", " ").split() if w]


REFERENCE = "Good morning, how are you today?"


def _no_speech_payload(age_band: str = "child") -> dict:
    words = ["Good", "morning", "how", "are", "you", "today"]
    return {
        "reference_text": REFERENCE,
        "recognized_text": ".",
        "scores": {"pron": 0, "accuracy": 0, "fluency": 0, "completeness": 0, "prosody": 0},
        "issues": [{"type": "Omission", "word": word, "score": 0, "severity": "high"} for word in words],
        "words": [{"word": word, "score": 0, "error_type": "Omission"} for word in words],
        "intonation": {"available": False},
        "learner": {"age_band": age_band, "level": "A2", "native_language": "zh"},
    }


def _blob(feedback: dict) -> str:
    parts = [feedback.get("summary") or "", feedback.get("praise") or "", feedback.get("closing") or ""]
    for point in feedback.get("points") or []:
        parts.extend(
            [
                str(point.get("title") or ""),
                str(point.get("why") or ""),
                str(point.get("how") or ""),
                str(point.get("demo_text") or ""),
                " ".join(str(w) for w in (point.get("practice_words") or [])),
            ]
        )
    return " ".join(parts)


def _praise_hits(feedback: dict) -> list[str]:
    blob = _blob(feedback)
    return [marker for marker in ALL_PRAISE if marker in blob]


# --------------------------------------------------------------------------------------
# 触发条件
# --------------------------------------------------------------------------------------
def test_no_speech_detection_rules():
    assert is_no_speech_payload(_no_speech_payload()) is True
    # 只有标点 / 空串（字段存在）
    assert is_no_speech_payload({"recognized_text": ".", "scores": {"pron": 0}}) is True
    assert is_no_speech_payload({"recognized_text": "", "scores": {}, "issues": []}) is True
    # 字段缺失（契约 §5 的请求本来就不带 recognized_text）时靠分数+issue 证据
    payload = _no_speech_payload()
    payload.pop("recognized_text")
    assert is_no_speech_payload(payload) is True
    # warnings 佐证
    assert (
        is_no_speech_payload(
            {"scores": {"pron": 0, "accuracy": 0, "fluency": 0, "completeness": 0}, "warnings": ["low_snr", "asr_mismatch"]}
        )
        is True
    )
    # 反例：字段缺失且没有任何证据 -> 不能判"没听到"（否则会把所有正常请求都误判）
    assert is_no_speech_payload({"reference_text": "Hello", "scores": {"pron": 80}}) is False
    assert is_no_speech_payload({"scores": {}, "issues": []}) is False
    # 反例：正常读（识别到词、分数正常）
    normal = {
        "recognized_text": "Good morning how are you today",
        "scores": {"pron": 82, "accuracy": 85, "fluency": 80, "completeness": 100},
        "issues": [],
    }
    assert is_no_speech_payload(normal) is False
    # 反例：全 0 分但只漏了 1 个词（不是"没听到"）
    one_omission = {
        "recognized_text": "morning how are you today",
        "scores": {"pron": 0, "accuracy": 0, "fluency": 0, "completeness": 0},
        "issues": [{"type": "Omission", "word": "Good"}],
        "words": [{"word": "morning", "score": 0, "error_type": "Omission"}],
    }
    assert is_no_speech_payload(one_omission) is False


# --------------------------------------------------------------------------------------
# 场景 1：整句没听到 -> 不许表扬
# --------------------------------------------------------------------------------------
@pytest.mark.parametrize("age_band", ["child", "adult"])
def test_no_speech_feedback_has_no_praise_words(age_band):
    feedback = template_feedback(_no_speech_payload(age_band))
    assert feedback["provider"] == "template"
    hits = _praise_hits(feedback)
    assert hits == [], f"{age_band} 版在'没听到'分支出现了表扬词: {hits}\n{_blob(feedback)}"


@pytest.mark.parametrize("age_band", ["child", "adult"])
def test_no_speech_feedback_says_it_did_not_hear(age_band):
    feedback = template_feedback(_no_speech_payload(age_band))
    assert "没听到" in feedback["summary"] or "没有识别到语音" in feedback["summary"], feedback["summary"]


@pytest.mark.parametrize("age_band", ["child", "adult"])
def test_no_speech_feedback_gives_three_actionable_checks(age_band):
    feedback = template_feedback(_no_speech_payload(age_band))
    blob = _blob(feedback)
    assert "麦克风" in blob
    assert "大声" in blob
    assert "听示范" in blob
    how = feedback["points"][0]["how"]
    assert how.count("；") >= 2 or how.count("\n") >= 2, f"三条排查要可数: {how}"


@pytest.mark.parametrize("age_band", ["child", "adult"])
def test_no_speech_feedback_does_not_blame_individual_words(age_band):
    feedback = template_feedback(_no_speech_payload(age_band))
    blob = _blob(feedback)
    for marker in ("没说出口", "漏掉", "漏读", "Omission"):
        assert marker not in blob, f"{age_band}: 整句没听到时不该逐词指责（{marker}）"
    # 不许把参考句里的词单独列成"漏读"卡片标题
    for word in _words(REFERENCE):
        assert word not in (feedback["points"][0]["title"] or ""), word
    assert len(feedback["points"]) <= 2


def test_no_speech_mostly_omission_but_scores_missing_still_branch():
    payload = _no_speech_payload("child")
    payload.pop("recognized_text")
    payload["scores"] = {}
    payload["words"] = [{"word": "Good", "score": 0, "error_type": "Omission"}, {"word": "morning", "score": 0, "error_type": "Omission"}]
    feedback = template_feedback(payload)
    assert _praise_hits(feedback) == []
    assert "没听到" in feedback["summary"]


# --------------------------------------------------------------------------------------
# 场景 2：Omission / Insertion / Break 的练习词必须与目标词相关
# --------------------------------------------------------------------------------------
def _one_issue(issue: dict, age_band: str = "child") -> dict:
    return {
        "reference_text": REFERENCE,
        "recognized_text": "morning how are you today",
        "scores": {"pron": 60, "accuracy": 64, "fluency": 78, "completeness": 83, "prosody": 60},
        "issues": [issue],
        "words": [{"word": "morning", "score": 88, "error_type": "None"}],
        "learner": {"age_band": age_band},
    }


@pytest.mark.parametrize("age_band", ["child", "adult"])
def test_omission_practice_words_are_the_omitted_word(age_band):
    feedback = template_feedback(_one_issue({"type": "Omission", "word": "Good", "score": 0, "severity": "high"}, age_band))
    point = feedback["points"][0]
    assert point["practice_words"] == ["Good"], point
    assert point["demo_text"] == "Good"
    assert "Good" in point["title"]
    # 不能出现通用提示表的无关词
    for unrelated in ("think", "weather", "really", "today"):
        assert unrelated not in point["practice_words"], point


@pytest.mark.parametrize("age_band", ["child", "adult"])
def test_insertion_practice_words_are_related(age_band):
    feedback = template_feedback(_one_issue({"type": "Insertion", "word": "very", "score": 40, "severity": "medium"}, age_band))
    point = feedback["points"][0]
    assert point["practice_words"] == ["very"], point
    for unrelated in ("think", "thick", "three"):
        assert unrelated not in point["practice_words"]


@pytest.mark.parametrize("issue_type", ["UnexpectedBreak", "MissingBreak"])
def test_break_practice_words_are_related(issue_type):
    feedback = template_feedback(
        _one_issue({"type": issue_type, "word": "how", "score": None, "severity": "medium"})
    )
    point = feedback["points"][0]
    assert point["practice_words"] == ["how"], point
    assert point["demo_text"], "停顿类也要给可跟读的示范"


def test_omission_practice_words_never_fall_back_to_generic_table():
    """通用表里 omission/insertion 模板的练习词就是那 4 个通用词，必须被替换掉。"""
    from app.feedback_templates import HINT_TEMPLATES

    generic = set(HINT_TEMPLATES["omission"]["practice_words"]) | set(HINT_TEMPLATES["insertion"]["practice_words"])
    feedback = template_feedback(_one_issue({"type": "Omission", "word": "Good", "score": 0}))
    assert not (set(feedback["points"][0]["practice_words"]) & generic - {"Good"}), feedback["points"][0]


# --------------------------------------------------------------------------------------
# 场景 3：actual == null / 音素没有专用提示 时不许编造
# --------------------------------------------------------------------------------------
def _mispronunciation(word: str, phoneme: str | None, actual, age_band: str = "adult") -> dict:
    return {
        "reference_text": "I think the weather is really nice today.",
        "recognized_text": "I think the weather is really nice today",
        "scores": {"pron": 71, "accuracy": 74, "fluency": 80, "completeness": 100, "prosody": 58},
        "issues": [{"type": "Mispronunciation", "word": word, "phoneme": phoneme, "actual": actual, "score": 48, "severity": "high"}],
        "words": [{"word": word, "score": 48, "error_type": "Mispronunciation"}, {"word": "nice", "score": 90, "error_type": "None"}],
        "learner": {"age_band": age_band},
    }


@pytest.mark.parametrize("age_band", ["child", "adult"])
@pytest.mark.parametrize("phoneme", ["eɪ", "θ", "ɑ", None])
def test_mispronunciation_without_actual_does_not_invent(age_band, phoneme):
    feedback = template_feedback(_mispronunciation("today", phoneme, None, age_band))
    blob = _blob(feedback)
    assert "读成了" not in blob, f"actual 为 null 时不能编造实际音素: {blob}"
    assert "today" in blob


def test_mispronunciation_with_actual_still_reports_it():
    """有 actual 时仍要如实说明（这是有用的信息，不能一刀切删掉）。"""
    feedback = template_feedback(_mispronunciation("think", "θ", "s", "adult"))
    assert "读成了 s" in feedback["points"][0]["title"]


def test_unmapped_phoneme_uses_phoneme_related_practice_words():
    """today /eɪ/ 以前会被按拼写猜成"词尾音"并给无关练习词，现在必须是相关卡片。"""
    feedback = template_feedback(_mispronunciation("today", "eɪ", None, "adult"))
    point = feedback["points"][0]
    assert "词尾" not in point["title"], point
    assert "eɪ" in point["title"]  # 成人版可以显示音素符号（不算编造 actual）
    assert point["practice_words"] == ["today"], point
    assert "good" not in point["practice_words"]


def test_unmapped_phoneme_child_version_has_no_ipa():
    feedback = template_feedback(_mispronunciation("today", "eɪ", None, "child"))
    point = feedback["points"][0]
    assert not any(sym in point["title"] + point["why"] + point["how"] for sym in ("eɪ", "ɪ", "ə")), point
    assert point["practice_words"] == ["today"]


# --------------------------------------------------------------------------------------
# 端到端：路由层也要保证（LLM 不许把表扬词带回来）
# --------------------------------------------------------------------------------------
def test_route_bypasses_llm_for_no_speech(client, monkeypatch):
    class PraiseHappyLLM:
        available = True
        provider_name = "deepseek"

        def __init__(self, *args, **kwargs):
            pass

        def chat_json(self, *args, **kwargs):
            from app.llm import LLMOutcome

            return LLMOutcome(
                provider="deepseek",
                data={
                    "summary": "你把整句都说出来了，真棒！",
                    "praise": "读得很好！",
                    "closing": "继续加油！",
                    "points": [{"title": "整句都读得很好", "why": "w", "how": "h", "practice_words": [], "demo_text": "", "severity": "low"}],
                },
            )

    monkeypatch.setattr("app.api.LLMClient", PraiseHappyLLM)
    response = client.post("/v1/feedback", json=_no_speech_payload("child"))
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "template", "没听到语音时不允许走 LLM（输出不可控）"
    assert _praise_hits(body) == [], _blob(body)


def test_route_still_uses_llm_for_normal_case(client, monkeypatch):
    class GoodLLM:
        available = True
        provider_name = "deepseek"

        def __init__(self, *args, **kwargs):
            pass

        def chat_json(self, *args, **kwargs):
            from app.llm import LLMOutcome

            return LLMOutcome(
                provider="deepseek",
                data={
                    "summary": "整体不错 👍",
                    "praise": "weather 很清楚。",
                    "closing": "再来一次？",
                    "points": [{"title": "θ 音", "why": "w", "how": "h", "practice_words": ["think"], "demo_text": "think", "severity": "high"}],
                },
            )

    monkeypatch.setattr("app.api.LLMClient", GoodLLM)
    body = client.post(
        "/v1/feedback",
        json={
            "reference_text": "I think the weather is really nice today.",
            "recognized_text": "I think the weather is really nice today",
            "scores": {"pron": 82, "accuracy": 85, "fluency": 80, "completeness": 100},
            "issues": [],
            "learner": {"age_band": "child"},
        },
    ).json()
    assert body["provider"] == "deepseek"


def test_all_words_omitted_does_not_claim_success_even_without_zero_scores():
    """分数没给全 0、但每个词都是 Omission 时，praise 也不能说"整句都说出来了"。"""
    payload = _no_speech_payload("child")
    payload["scores"] = {"pron": 20}  # 不是全 0 -> 不进"没听到"分支
    payload.pop("recognized_text")
    feedback = template_feedback(payload)
    blob = _blob(feedback)
    for marker in ("说出来了", "坚持读完", "整句都"):
        assert marker not in blob, blob


def test_healthy_payload_keeps_encouraging_praise():
    feedback = template_feedback(
        {
            "reference_text": "Good morning",
            "recognized_text": "Good morning",
            "scores": {"pron": 88, "accuracy": 90, "fluency": 85, "completeness": 100},
            "issues": [],
            "words": [{"word": "Good", "score": 92, "error_type": "None"}, {"word": "morning", "score": 88, "error_type": "None"}],
            "learner": {"age_band": "child"},
        }
    )
    assert "读得特别清楚" in feedback["praise"]
    assert _praise_hits(feedback)  # 正常情况当然可以表扬
