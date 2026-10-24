"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Recorder } from "@/components/Recorder";
import { RecordedAudio } from "@/components/RecordedAudio";
import {
  EMPTY_SCORES,
  FeedbackCard,
  IntonationSection,
  IssuesSection,
  NoSpeechNotice,
  PhonemeChips,
} from "@/components/ResultSections";
import { ScoreRadar } from "@/components/ScoreRadar";
import { TotalScore } from "@/components/ScoreBars";
import { WordBars } from "@/components/WordBars";
import { isSpeechMissing } from "@/lib/speech-detection";
import type { AttemptApiResponse, SentenceItem, VoiceCapabilities } from "@/lib/types";
import { warmSentence, warmSentences } from "@/lib/warmup-queue";

interface Props {
  sentences: SentenceItem[];
  isChild: boolean;
  userLevel: string;
  capabilities: VoiceCapabilities;
  voiceReachable: boolean;
  voiceMode: string;
  initialUsage: AttemptApiResponse["usage"];
}

export function PracticeClient({
  sentences,
  isChild,
  userLevel,
  capabilities,
  voiceReachable,
  voiceMode,
  initialUsage,
}: Props) {
  const [level, setLevel] = useState<string>(userLevel || "A1");
  const [selectedId, setSelectedId] = useState<string>(sentences[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [response, setResponse] = useState<AttemptApiResponse | null>(null);
  const [usage, setUsage] = useState(initialUsage);
  const [myAudioUrl, setMyAudioUrl] = useState<string | null>(null);
  // 录音时长：webm 头里没有时长，原生 <audio> 一开始显示 0:00，所以自己记一份用于回显
  const [myAudioDurationMs, setMyAudioDurationMs] = useState<number | null>(null);
  const [demoUrl, setDemoUrl] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  // 「跟我读」：播完示范音把 startSignal 加一，Recorder 收到后自动开始录音
  const [followBusy, setFollowBusy] = useState(false);
  const [startSignal, setStartSignal] = useState(0);
  const [attemptsToday, setAttemptsToday] = useState(0);
  const objectUrls = useRef<string[]>([]);

  const levels = useMemo(() => [...new Set(sentences.map((s) => s.level))].sort(), [sentences]);
  const list = useMemo(
    () => sentences.filter((s) => s.level === level),
    [sentences, level],
  );
  const selected = sentences.find((s) => s.id === selectedId) ?? list[0] ?? sentences[0];

  const phonemeLevel = capabilities.phoneme_level;

  // ── task-14 A：参考音静默预热 ──────────────────────────────────────────────
  // 触发点：句子被选中/切换时（含首次进入）。fire-and-forget：不播放、无 loading、
  // 不阻塞 UI、失败静默忽略；队列内部串行（云 TTS 免费层并发=1）并按文本+语速去重。
  const selectedText = selected?.text ?? "";
  useEffect(() => {
    if (!selectedText) return;
    // 示范音路径用页面实际播放所用的语速（儿童=慢速）
    warmSentence(selectedText, { rate: isChild ? "slow" : "normal" });
    // 儿童还要给"评测路径"预热一次 normal（pronounce 内部合成参考音用的是 normal）
    if (isChild) warmSentence(selectedText, { rate: "normal" });
  }, [selectedText, isChild]);

  // 低优先级：进入页面/切换等级后，静默预热当前等级前 5 句（串行、去重）
  useEffect(() => {
    const timer = setTimeout(() => {
      warmSentences(
        list.slice(0, 5).map((s) => s.text),
        { rate: "normal" },
      );
    }, 1500);
    return () => clearTimeout(timer);
  }, [level, list]);

  function rememberUrl(url: string) {
    objectUrls.current.push(url);
    if (objectUrls.current.length > 6) {
      const old = objectUrls.current.shift();
      if (old) URL.revokeObjectURL(old);
    }
  }

  async function submit(blob: Blob, durationMs: number) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setLimitMessage(null);
    try {
      const localUrl = URL.createObjectURL(blob);
      rememberUrl(localUrl);
      setMyAudioUrl(localUrl);
      setMyAudioDurationMs(durationMs);

      const form = new FormData();
      form.append("audio", blob, `record.${blob.type.includes("wav") ? "wav" : "webm"}`);
      form.append("sentence_id", selected.id);
      form.append("reference_text", selected.text);
      form.append("mode", "scripted");
      form.append("duration_ms", String(Math.round(durationMs)));

      const res = await fetch("/api/attempts", { method: "POST", body: form });
      const data = (await res.json()) as AttemptApiResponse & {
        error?: { code?: string; message?: string };
      };

      if (res.status === 429) {
        setLimitMessage(data?.error?.message ?? "今天的练习时间到啦，明天再来吧 🌙");
        return;
      }
      if (!res.ok) {
        setError(data?.error?.message ?? "提交失败");
        return;
      }
      setResponse(data);
      setUsage(data.usage);
      setAttemptsToday((n) => n + 1);
      setDemoUrl(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!response) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/attempts/${response.attempt_id}/retry`, { method: "POST" });
      const data = (await res.json()) as AttemptApiResponse & { error?: { message?: string } };
      if (!res.ok) {
        setError(data?.error?.message ?? "重试失败");
        return;
      }
      setResponse(data);
      setUsage(data.usage);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 取当前句的示范音地址（走 /api/tts，voice 侧命中缓存时几乎瞬时返回） */
  async function getDemoUrl(): Promise<string | null> {
    if (!selected) return null;
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: selected.text,
        rate: isChild ? "slow" : "normal",
      }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    rememberUrl(url);
    return url;
  }

  async function playDemo() {
    if (!selected) return;
    setDemoBusy(true);
    try {
      const url = await getDemoUrl();
      if (!url) {
        setError("示范音暂时不可用，稍后再试");
        return;
      }
      setDemoUrl(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDemoBusy(false);
    }
  }

  /**
   * 「跟我读」：先播一遍示范音 → **播完自动开始录音**。
   * 把原来「听示范 → 点开始录音 → 点说完啦」三步压成「跟我读 → 说完啦」两步，
   * 孩子不用在中间找按钮；麦克风已预取，所以开录几乎无延迟，不会丢开头。
   */
  async function followAlong() {
    if (!selected || busy || followBusy) return;
    setFollowBusy(true);
    setError(null);
    const begin = () => setStartSignal((n) => n + 1);
    try {
      const url = await getDemoUrl();
      if (!url) {
        // 示范音拿不到也别挡住练习：直接开始录音
        setError("示范音暂时不可用，已直接开始录音");
        begin();
        return;
      }
      setDemoUrl(url);
      const audio = new Audio(url);
      audio.onended = () => setTimeout(begin, 250); // 留一点"换气"时间
      audio.onerror = () => begin();
      await audio.play().catch(() => {
        // 浏览器自动播放策略可能拦截 → 退化为直接开录，用户仍可点「听示范」
        begin();
      });
    } catch (err) {
      setError((err as Error).message);
      begin();
    } finally {
      setFollowBusy(false);
    }
  }

  const result = response?.result ?? null;
  // task-14 D：整句没听到（recognized_text 极短 / low_snr）→ 不展示 0 分热力图
  const noSpeech =
    Boolean(response) &&
    isSpeechMissing({ recognized_text: result?.recognized_text, warnings: result?.warnings });
  const intonation = result?.intonation ?? null;
  const words = result?.words ?? [];

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-extrabold">
            {isChild ? "🎤 我们一起读句子吧！" : "🎤 跟读练习"}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-[var(--ec-primary-soft)] px-3 py-1 font-medium text-[var(--ec-primary)]">
              今日 {usage.minutes}/{usage.limitMinutes} 分钟
            </span>
            <span className="rounded-full bg-[#eef0f8] px-3 py-1">
              {voiceReachable ? `voice: ${voiceMode}` : "voice 未就绪"}
            </span>
            <span className="rounded-full bg-[#eef0f8] px-3 py-1" data-testid="phoneme-capability">
              {phonemeLevel ? "音素级可用" : "单词级粗评"}
            </span>
          </div>
        </div>

        {!voiceReachable ? (
          <p className="mt-3 rounded-xl bg-[#fff3d6] p-3 text-sm" data-testid="voice-down-banner">
            ⚠️ 语音评测服务暂时没有响应。你仍然可以录音：录音和文本会先存下来，等它恢复后点「重试评测」即可，不会丢数据。
          </p>
        ) : null}
        {!phonemeLevel ? (
          <p className="mt-3 rounded-xl bg-[#eef4ff] p-3 text-sm" data-testid="word-level-banner">
            ℹ️ 当前 provider 不支持音素级评分，下面显示的是<strong>单词级（粗评）</strong>结果，不展示 IPA 音素。
          </p>
        ) : null}
        {limitMessage ? (
          <p className="ec-pop mt-3 rounded-xl bg-[#fff3d6] p-3 text-sm" data-testid="limit-banner">
            🌙 {limitMessage}
          </p>
        ) : null}
      </section>

      {/* 宽屏双栏：左=选句（自带滚动，不会再无限变长），右=录音与结果（吸顶常驻）。
          窄屏单栏：列表有高度上限，操作区紧跟其后，不用把 100 句滚到底才能录音。 */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] lg:items-start">
      <section className="ec-card">
        <div className="flex flex-wrap gap-2">
          {levels.map((l) => (
            <button
              key={l}
              type="button"
              className={`ec-btn ${l === level ? "ec-btn-primary" : "ec-btn-ghost"}`}
              onClick={() => setLevel(l)}
            >
              {l}
            </button>
          ))}
          <span className="ml-auto self-center text-xs text-[var(--ec-muted)]">
            共 {sentences.length} 句 · 当前 {list.length} 句
          </span>
        </div>

        <ul className="mt-3 grid max-h-[46vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:max-h-[calc(100vh_-_15rem)] lg:grid-cols-1">
          {list.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(s.id);
                  setResponse(null);
                }}
                className={`w-full rounded-xl border p-3 text-left transition ${
                  s.id === selected?.id
                    ? "border-[var(--ec-primary)] bg-[var(--ec-primary-soft)]"
                    : "border-[#e6e8f5] bg-white hover:border-[var(--ec-primary)]"
                }`}
              >
                <span className="block font-semibold">{s.text}</span>
                <span className="mt-1 block text-xs text-[var(--ec-muted)]">{s.translation_zh}</span>
                {!isChild && s.focus_phonemes.length > 0 ? (
                  <span className="mt-1 block text-xs text-[var(--ec-muted)]">
                    重点音素：{s.focus_phonemes.join(" ")}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* 右列：录音与结果。宽屏吸顶常驻；窄屏紧跟（已被限高的）列表之后，一屏内可达。 */}
      <div className="flex flex-col gap-5 lg:sticky lg:top-4">
      {selected ? (
        <section className="ec-card">
          <h2 className="text-2xl font-extrabold leading-snug">{selected.text}</h2>
          <p className="mt-1 text-sm text-[var(--ec-muted)]">{selected.translation_zh}</p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {/* 主操作：「跟我读」一把完成 听示范 → 自动开录，所以它是唯一的实心按钮 */}
            <button
              type="button"
              className="ec-btn ec-btn-primary"
              onClick={() => void followAlong()}
              disabled={busy || followBusy}
              data-testid="follow-along"
            >
              🎧 {followBusy ? "准备中…" : isChild ? "跟我读" : "跟我读一遍"}
            </button>
            {/* 次要入口：手动录音 / 只播放示范 */}
            <Recorder
              onRecorded={submit}
              disabled={busy}
              isChild={isChild}
              recording={busy}
              startSignal={startSignal}
              emphasis="secondary"
            />
            <button type="button" className="ec-btn ec-btn-ghost" onClick={playDemo} disabled={demoBusy}>
              🔊 {demoBusy ? "生成中…" : isChild ? "只听示范" : "只听示范音"}
            </button>
            {response?.retryable ? (
              <button type="button" className="ec-btn ec-btn-warn" onClick={retry} disabled={busy}>
                🔁 重试评测（不用重录）
              </button>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
            {myAudioUrl ? (
              <RecordedAudio src={myAudioUrl} durationMs={myAudioDurationMs} />
            ) : null}
            {demoUrl ? (
              <span className="flex items-center gap-2">
                示范音：
                <audio controls src={demoUrl} className="h-9" />
              </span>
            ) : null}
          </div>

          {error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        </section>
      ) : null}

      {response ? (
        <>
          <section className="ec-card" data-testid="result-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {noSpeech ? (
                <p className="text-lg font-bold">— 本次没有有效评分</p>
              ) : (
                <TotalScore value={result?.scores?.pron ?? null} isChild={isChild} />
              )}
              <div className="text-right text-xs text-[var(--ec-muted)]">
                <p>识别结果：{result?.recognized_text?.trim() ? result.recognized_text : "—"}</p>
                <p>
                  provider：{result?.provider ?? "—"} · 粒度：
                  {result?.granularity === "phoneme" ? "音素级" : "单词级（粗评）"}
                </p>
                <p>
                  时长：{result?.duration_ms ? `${(result.duration_ms / 1000).toFixed(1)}s` : "—"} · 本次记录 id：
                  {response.attempt_id}
                </p>
                {response.degraded ? (
                  <p className="mt-1 text-[#b45309]">{response.message}</p>
                ) : null}
              </div>
            </div>

            {/* 整句没听到时不给"反馈"（否则会和"没听到"自相矛盾） */}
            {!noSpeech ? <FeedbackCard feedback={response.feedback ?? null} isChild={isChild} /> : null}
          </section>

          {noSpeech ? (
            <NoSpeechNotice isChild={isChild} recognizedText={result?.recognized_text}>
              {/* 重录按钮放在最显眼处（就在提示卡片里） */}
              <Recorder onRecorded={submit} disabled={busy} isChild={isChild} recording={busy} />
            </NoSpeechNotice>
          ) : (
            <>
              <section className="ec-card">
                <h3 className="text-lg font-bold">{isChild ? "📊 这一次的表现" : "能力多边形"}</h3>
                <div className="mt-3">
                  <ScoreRadar scores={result?.scores ?? EMPTY_SCORES} isChild={isChild} />
                </div>
              </section>

              {result ? (
                <section className="ec-card">
                  <h3 className="text-lg font-bold">{isChild ? "🔤 每个词读得怎么样" : "逐词得分"}</h3>
                  <div className="mt-3">
                    <WordBars words={words} isChild={isChild} />
                  </div>
                  <PhonemeChips words={words} phonemeLevel={phonemeLevel} isChild={isChild} />
                </section>
              ) : null}

              <IntonationSection intonation={intonation} isChild={isChild} />
              <IssuesSection issues={result?.issues ?? []} isChild={isChild} phonemeLevel={phonemeLevel} />

              {attemptsToday > 0 && attemptsToday % 5 === 0 ? (
                <p className="ec-star text-lg font-bold text-[var(--ec-primary)]">
                  ⭐ 你已经连续读了 {attemptsToday} 句，超棒！
                </p>
              ) : null}
            </>
          )}
        </>
      ) : (
        <section className="ec-card" data-testid="empty-selection">
          <p className="text-lg font-bold">
            {isChild ? "👈 先从左边挑一句吧！" : "👈 请先在左侧选择一句"}
          </p>
          <p className="mt-2 text-sm text-[var(--ec-muted)]">
            选中后这里会出现录音按钮（{isChild ? "按这里开始说" : "开始录音"}）和示范音，不用往下翻。
          </p>
        </section>
      )}
      </div>
      </div>
    </div>
  );
}
