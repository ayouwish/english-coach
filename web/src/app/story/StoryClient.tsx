"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Recorder } from "@/components/Recorder";
import { harderLevel, simplerLevel } from "@/lib/levels";
import { consecutiveDays, groupStoriesByDay, streakMessage } from "@/lib/story-stats";

interface StorySentence {
  zh: string;
  en: string;
}

interface MaterialItem {
  id: string;
  title: string;
  sentence_count: number;
  has_image: boolean;
  kind: string;
  level: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
}

interface Readability {
  sentence_count?: number;
  avg_words?: number;
  max_words?: number;
  unknown_words?: string[];
  ok?: boolean;
}

/**
 * 故事模式（task-49）：中文（打字或「🎤 说中文」）→ `/api/story/rewrite` → 英文对照可编辑
 * → 保存为 `reading_materials.kind='story'` → 跳 `/flow` 直接连读（鼓励语在 flow 汇总处自动生效）。
 *
 * 失败一律可见：ASR 失败、改写失败（含"服务端未就绪"）、保存失败都在页面上写明原因。
 */
export function StoryClient({
  viewerId,
  isChild,
  defaultLevel,
  levels,
  levelSuggestion = { suggest: null, message: null },
}: {
  viewerId: string;
  isChild: boolean;
  defaultLevel: string;
  levels: string[];
  /** 难度自适应提示（task-50 P2）：只提示，不强制 */
  levelSuggestion?: { suggest: "harder" | "easier" | null; message: string | null };
}) {
  const [textZh, setTextZh] = useState("");
  const [level, setLevel] = useState(defaultLevel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [asrBusy, setAsrBusy] = useState(false);
  const [sentences, setSentences] = useState<StorySentence[] | null>(null);
  const [titleEn, setTitleEn] = useState("");
  const [readability, setReadability] = useState<Readability | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stories, setStories] = useState<MaterialItem[]>([]);
  /** P1：故事集筛选（全家 / 只看我的） */
  const [storyScope, setStoryScope] = useState<"family" | "mine">("family");
  /** P2：把弱音练进故事里（默认开） */
  const [useWeakPhonemes, setUseWeakPhonemes] = useState(true);
  const [weakUsed, setWeakUsed] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [storiesError, setStoriesError] = useState<string | null>(null);
  const [storyBusy, setStoryBusy] = useState<string | null>(null);
  const objectUrls = useRef<string[]>([]);

  const loadStories = useCallback(async () => {
    try {
      const res = await fetch("/api/materials?kind=story&limit=50");
      const data = (await res.json().catch(() => null)) as
        | { items?: MaterialItem[]; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setStoriesError(data?.error?.message ?? `加载故事集失败（HTTP ${res.status}）`);
        return;
      }
      setStories(data?.items ?? []);
      setStoriesError(null);
    } catch (err) {
      setStoriesError(`加载故事集失败：${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void loadStories();
  }, [loadStories]);

  useEffect(() => {
    const urls = objectUrls;
    return () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
    };
  }, []);

  /** 「🎤 说中文」：录音 → /api/asr?language=zh-CN → 追加到文本框 */
  async function speakChinese(blob: Blob) {
    setAsrBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("audio", blob, `story-zh.${blob.type.includes("wav") ? "wav" : "webm"}`);
      form.append("language", "zh-CN");
      const res = await fetch("/api/asr?language=zh-CN", { method: "POST", body: form });
      const data = (await res.json().catch(() => null)) as
        | { text?: string; error?: { message?: string } }
        | null;
      if (!res.ok || !data?.text) {
        setError(data?.error?.message ?? `中文识别失败（HTTP ${res.status}）。可以再录一次，或直接打字。`);
        return;
      }
      const text = data.text.trim();
      setTextZh((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
      setNotice("听到啦，已经写进上面的框里了 ✅");
    } catch (err) {
      setError(`中文识别失败：${(err as Error).message}。可以再录一次，或直接打字。`);
    } finally {
      setAsrBusy(false);
    }
  }

  async function generate(nextLevel = level) {
    if (!textZh.trim()) {
      setError(isChild ? "先讲一讲你的故事吧（打字或者点话筒说）" : "请先用中文写（或说）你的故事");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/story/rewrite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text_zh: textZh,
          level: nextLevel,
          max_sentences: 6,
          use_weak_phonemes: useWeakPhonemes,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | {
            title_en?: string;
            sentences?: string[];
            text_en?: string;
            readability?: Readability | null;
            warnings?: string[];
            weak_phonemes_used?: string[];
            error?: { message?: string };
          }
        | null;
      if (!res.ok) {
        // 服务端未就绪（503）也走这里：message 已经是可读中文
        setError(data?.error?.message ?? `故事改写失败（HTTP ${res.status}）`);
        return;
      }
      const enList = (data?.sentences ?? []).filter((s) => typeof s === "string" && s.trim());
      const zhList = textZh
        .split(/(?<=[。！？!?])/)
        .map((s) => s.trim())
        .filter(Boolean);
      setSentences(
        enList.map((en, i) => ({
          en,
          zh: zhList[i] ?? (i === 0 ? textZh : ""),
        })),
      );
      setTitleEn((data?.title_en || enList[0] || "My Story").slice(0, 60));
      setReadability(data?.readability ?? null);
      setWarnings(Array.isArray(data?.warnings) ? data.warnings : []);
      setWeakUsed(Array.isArray(data?.weak_phonemes_used) ? data.weak_phonemes_used : []);
      setLevel(nextLevel);
    } catch (err) {
      setError(`故事改写失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveAndRead() {
    if (!sentences || sentences.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const text = sentences.map((s) => s.en.trim()).filter(Boolean).join(" ");
      const res = await fetch("/api/materials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: titleEn.trim() || sentences[0].en.slice(0, 40) || "My Story",
          text,
          kind: "story",
          source_zh: textZh,
          level,
          source: "text",
        }),
      });
      const data = (await res.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
      if (!res.ok || !data?.id) {
        setSaveError(data?.error?.message ?? `保存失败（HTTP ${res.status}），请重试`);
        return;
      }
      // 保存后：后台自动画一张插画（keepalive 保证跳转后请求继续完成），再进连读
      try {
        void fetch(`/api/story/${encodeURIComponent(data.id)}/illustrate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: false }),
          keepalive: true,
        });
      } catch {
        /* 画插画失败不影响阅读 */
      }
      window.location.href = `/flow?material=${encodeURIComponent(data.id)}`;
    } catch (err) {
      setSaveError(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeStory(id: string) {
    if (typeof window !== "undefined" && !window.confirm("确定删除这个故事吗？")) return;
    setStoryBusy(id);
    setStoriesError(null);
    try {
      const res = await fetch(`/api/materials/${id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setStoriesError(data?.error?.message ?? `删除失败（HTTP ${res.status}）`);
        return;
      }
      setStories((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setStoriesError(`删除失败：${(err as Error).message}`);
    } finally {
      setStoryBusy(null);
    }
  }

  const canEdit = sentences !== null;

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <h1 className="text-xl font-extrabold">📖 {isChild ? "我的故事" : "故事模式"}</h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          {isChild
            ? "今天想讲什么故事？写下来，或者点话筒讲一讲，我给你变成简单的英文，你再读一遍 🙂"
            : "用中文讲/写你的故事 → 变成符合你当前难度的英文 → 自己读一遍录进去。这就是你自己的英文故事书。"}
        </p>
      </section>

      {/* 输入区：文字 + 中文语音 */}
      <section className="ec-card">
        <label className="flex flex-col gap-1">
          <span className={isChild ? "text-lg font-bold" : "text-sm font-bold"}>
            今天有什么想讲的？写下来，或者点下面的话筒说
          </span>
          <textarea
            value={textZh}
            onChange={(e) => setTextZh(e.target.value.slice(0, 2000))}
            rows={isChild ? 5 : 4}
            placeholder={
              isChild ? "比如：今天我和小明搭积木塔，被小华碰倒了，我很生气…" : "例如：今天我和朋友搭了一座很高的积木塔，后来被碰倒了…"
            }
            data-testid="story-input"
            className={`w-full rounded-xl border border-[#d9dcf0] px-3 py-2 ${isChild ? "text-base" : "text-sm"}`}
          />
        </label>
        <div className="mt-1 flex items-center justify-between text-xs text-[var(--ec-muted)]">
          <span data-testid="story-count">{textZh.trim().length} / 2000</span>
          <span>中文讲、中文写都可以</span>
        </div>

        <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3" data-testid="story-voice-panel">
          <p className="text-sm font-semibold">🎤 {isChild ? "说中文（我听着）" : "说中文"}</p>
          <p className="mt-1 text-xs text-[var(--ec-muted)]">
            {isChild ? "点一下按钮，对着麦克风讲你的故事，说完再点一次。" : "录音后会自动转成中文文字，追加到上面的框里。"}
          </p>
          <div className="mt-2">
            <Recorder onRecorded={(blob) => void speakChinese(blob)} disabled={asrBusy} isChild={isChild} />
          </div>
          {asrBusy ? (
            <p className="mt-2 text-sm text-[var(--ec-muted)]" data-testid="story-asr-busy">
              正在听懂你的话… ⏳
            </p>
          ) : null}
        </div>
      </section>

      {/* 难度 + 生成 */}
      <section className="ec-card">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold">难度：</span>
          {levels.map((l) => (
            <button
              key={l}
              type="button"
              data-testid={`story-level-${l}`}
              aria-pressed={level === l}
              onClick={() => setLevel(l)}
              className={`ec-btn ${level === l ? "ec-btn-primary" : "ec-btn-ghost"}`}
            >
              {l}
            </button>
          ))}
          <span className="mx-2 h-5 w-px bg-[#e6e8f5]" />
          <button
            type="button"
            className="ec-btn ec-btn-ghost"
            data-testid="story-simpler"
            onClick={() => {
              const next = simplerLevel(level);
              setLevel(next);
              if (canEdit) void generate(next);
            }}
          >
            ⬇️ 再简单一点
          </button>
          <button
            type="button"
            className="ec-btn ec-btn-ghost"
            data-testid="story-harder"
            onClick={() => {
              const next = harderLevel(level);
              setLevel(next);
              if (canEdit) void generate(next);
            }}
          >
            ⬆️ 再难一点
          </button>
        </div>
        {levelSuggestion.message ? (
          <p className="mt-2 rounded-xl bg-[#eef8ff] p-2 text-xs text-[#1d4ed8]" data-testid="story-level-suggestion">
            💡 {levelSuggestion.message}
            {levelSuggestion.suggest === "harder" ? "（选上面更难的级别即可）" : "（选上面更简单的级别即可）"}
          </p>
        ) : null}

        <label className="mt-3 flex items-start gap-2 text-sm" data-testid="story-weak-toggle">
          <input
            type="checkbox"
            checked={useWeakPhonemes}
            onChange={(e) => setUseWeakPhonemes(e.target.checked)}
            className="mt-1"
          />
          <span>
            {isChild ? "把这几个音也练进去（让故事里多出现一点）" : "把最近薄弱的音练进故事里"}
            {weakUsed.length > 0 ? `：${weakUsed.join(" / ")}` : "（会根据你的发音诊断自动选）"}
          </span>
        </label>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="ec-btn ec-btn-primary"
            data-testid="story-generate"
            disabled={busy}
            onClick={() => void generate()}
          >
            {busy ? "✍️ 正在把你的故事变成英文…" : "✨ 变成英文故事"}
          </button>
          {busy ? (
            <span className="text-xs text-[var(--ec-muted)]" data-testid="story-progress">
              生成中，大约几秒…（可以先看看下面的说明）
            </span>
          ) : null}
        </div>
        {error ? (
          <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="story-error">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="mt-3 rounded-xl bg-[#e8f7ee] p-3 text-sm text-[#166534]" data-testid="story-notice">
            {notice}
          </p>
        ) : null}
      </section>

      {/* 对照预览（英文可编辑） */}
      {sentences ? (
        <section className="ec-card" data-testid="story-preview">
          <h2 className="text-lg font-extrabold">你的故事 · 英文版</h2>
          <p className="mt-1 text-xs text-[var(--ec-muted)]">英文可以直接改；保存后就会变成你以后要读的故事。</p>
          <label className="mt-2 flex flex-col gap-1">
            <span className="text-xs text-[var(--ec-muted)]">标题</span>
            <input
              value={titleEn}
              onChange={(e) => setTitleEn(e.target.value.slice(0, 60))}
              data-testid="story-title"
              className="rounded-xl border border-[#d9dcf0] px-3 py-2 text-sm"
            />
          </label>

          {warnings.includes("too_hard") ? (
            <p className="mt-2 rounded-xl bg-[#fff3d6] p-2 text-sm" data-testid="story-too-hard">
              这段可能有点难，要不要点「⬇️ 再简单一点」？
            </p>
          ) : null}

          {readability ? (
            <p className="mt-2 text-xs text-[var(--ec-muted)]" data-testid="story-readability">
              可读性：{readability.sentence_count ?? sentences.length} 句 · 平均 {(readability.avg_words ?? 0).toFixed(1)} 词/句
              {typeof readability.max_words === "number" ? ` · 最长 ${readability.max_words} 词` : ""}
              {readability.unknown_words && readability.unknown_words.length > 0
                ? ` · 可能偏难的词：${readability.unknown_words.slice(0, 6).join(", ")}`
                : ""}
              {readability.ok === false ? "（有点难，可以点「再简单一点」）" : ""}
            </p>
          ) : null}

          <ol className="mt-3 flex flex-col gap-3">
            {sentences.map((s, i) => (
              <li key={i} className="rounded-xl bg-[#f8f9ff] p-3" data-testid="story-sentence">
                <p className="text-sm text-[var(--ec-muted)]">
                  你说：{s.zh || "（这一段没有对应的中文）"}
                </p>
                <textarea
                  value={s.en}
                  onChange={(e) =>
                    setSentences((prev) =>
                      (prev ?? []).map((x, j) => (j === i ? { ...x, en: e.target.value } : x)),
                    )
                  }
                  rows={2}
                  data-testid="story-sentence-en"
                  aria-label={`第 ${i + 1} 句英文`}
                  className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-2 py-1 text-base"
                />
              </li>
            ))}
          </ol>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ec-btn ec-btn-primary"
              data-testid="story-save"
              disabled={saving}
              onClick={() => void saveAndRead()}
            >
              {saving ? "保存中…" : isChild ? "💾 存下来，去读" : "💾 保存并开始读"}
            </button>
            <button type="button" className="ec-btn ec-btn-ghost" onClick={() => void generate()}>
              🔄 重新生成
            </button>
            {saveError ? (
              <span className="text-sm text-red-700" role="alert" data-testid="story-save-error">
                {saveError}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* 故事集 */}
      <section className="ec-card">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-extrabold">📚 我的故事集</h2>
          <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs" onClick={() => void loadStories()}>
            刷新
          </button>
          <span className="mx-1 h-5 w-px bg-[#e6e8f5]" />
          <button
            type="button"
            data-testid="story-scope-family"
            aria-pressed={storyScope === "family"}
            onClick={() => setStoryScope("family")}
            className={`ec-btn ${storyScope === "family" ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-0.5 text-xs`}
          >
            全家
          </button>
          <button
            type="button"
            data-testid="story-scope-mine"
            aria-pressed={storyScope === "mine"}
            onClick={() => setStoryScope("mine")}
            className={`ec-btn ${storyScope === "mine" ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py=0.5 text-xs`}
          >
            只看我的
          </button>
          {storiesError ? (
            <span className="text-xs text-red-700" role="alert" data-testid="stories-error">
              {storiesError}
            </span>
          ) : null}
        </div>
        {stories.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1" data-testid="story-streak">
            <p className="text-sm font-semibold">🔥 {streakMessage(consecutiveDays(stories.map((s) => s.created_at)))}</p>
          </div>
        ) : null}
        {stories.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--ec-muted)]" data-testid="stories-empty">
            还没有故事。讲讲今天发生的事，存下来就是你的第一本英文故事书。
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-3" data-testid="story-groups">
            {(() => {
              const scoped = storyScope === "mine" ? stories.filter((x) => x.created_by === viewerId) : stories;
              const groups = groupStoriesByDay(scoped);
              const sections: { key: string; label: string; items: MaterialItem[] }[] = [
                { key: "today", label: "今天", items: groups.today },
                { key: "yesterday", label: "昨天", items: groups.yesterday },
                { key: "earlier", label: "更早", items: groups.earlier },
              ];
              return sections
                .filter((sec) => sec.items.length > 0)
                .map((sec) => (
                  <div key={sec.key} data-testid={`story-group-${sec.key}`}>
                    <h3 className="text-xs font-semibold text-[var(--ec-muted)]">{sec.label}</h3>
                    <ul className="mt-1 flex flex-col gap-2">
                      {sec.items.map((s) => (
                        <li key={s.id} className="rounded-xl border border-[#e6e8f5] p-3" data-testid="story-item">
                          <div className="flex flex-wrap items-center gap-3">
                            {s.has_image ? (
                              // eslint-disable-next-line @next/next/no-img-element -- 本地 API 图片
                              <img
                                src={`/api/materials/${s.id}/image`}
                                alt={`${s.title} 的插画`}
                                data-testid="story-thumb"
                                className="h-14 w-14 rounded-lg border border-[#e6e8f5] object-cover"
                              />
                            ) : null}
                            <Link
                              href={`/story/${encodeURIComponent(s.id)}`}
                              className="min-w-0 flex-1 text-left"
                              data-testid="story-open"
                            >
                              <span className="block truncate font-semibold">{s.title}</span>
                              <span className="block text-xs text-[var(--ec-muted)]">
                                {s.sentence_count} 句{s.level ? ` · ${s.level}` : ""} ·{" "}
                                {new Date(s.created_at).toLocaleDateString("zh-CN")}
                                {s.created_by_name ? ` · ${s.created_by_name}` : ""}
                              </span>
                            </Link>
                            <Link
                              href={`/flow?material=${encodeURIComponent(s.id)}`}
                              className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                              data-testid="story-read"
                            >
                              ▶ 读这篇
                            </Link>
                            <button
                              type="button"
                              className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                              data-testid="story-delete"
                              disabled={storyBusy === s.id}
                              onClick={() => void removeStory(s.id)}
                            >
                              删除
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ));
            })()}
          </div>
        )}
      </section>
    </div>
  );
}
