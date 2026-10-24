"use client";

import { useState } from "react";
import type { SentenceView } from "@/lib/corpus";

/**
 * 家长自定义语料（task-5 B）：
 * - 单条录入：英文必填，中文翻译/等级/重点音素可选；
 * - 批量粘贴：每行一句（可只填英文，翻译用 Tab 或 | 分隔）；
 * - 归属隔离由服务端保证：只有本人与其孩子可见可用（其他家长看不到）。
 */
export function CorpusManager({ initial }: { initial: SentenceView[] }) {
  const [items, setItems] = useState(initial);
  const [text, setText] = useState("");
  const [translation, setTranslation] = useState("");
  const [level, setLevel] = useState("A1");
  const [phonemes, setPhonemes] = useState("");
  const [batch, setBatch] = useState("");
  const [batchLevel, setBatchLevel] = useState("A1");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addOne() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/sentences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          translation_zh: translation,
          level,
          focus_phonemes: phonemes,
        }),
      });
      const body = (await res.json()) as { created?: SentenceView; error?: { message?: string } };
      if (!res.ok || !body.created) {
        setError(body?.error?.message ?? "录入失败");
        return;
      }
      setItems((prev) => [body.created as SentenceView, ...prev]);
      setText("");
      setTranslation("");
      setPhonemes("");
      setMessage("已添加 ✅（你自己和女儿都能在跟读练习里看到）");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addBatch() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/sentences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch, level: batchLevel }),
      });
      const body = (await res.json()) as {
        created?: SentenceView[];
        created_count?: number;
        skipped_count?: number;
        skipped?: { line: string; reason: string }[];
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(body?.error?.message ?? "批量录入失败");
        return;
      }
      setItems((prev) => [...(body.created ?? []), ...prev]);
      setBatch("");
      setMessage(
        `批量添加 ${body.created_count ?? 0} 句` +
          (body.skipped_count ? `，跳过 ${body.skipped_count} 行` : "") +
          " ✅",
      );
      if (body.skipped_count) {
        setError(
          "跳过原因：" +
            (body.skipped ?? []).slice(0, 3).map((s) => `${s.line.slice(0, 20)}…（${s.reason}）`).join("；"),
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sentences/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        setError(body?.error?.message ?? "删除失败");
        return;
      }
      setItems((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ec-card mt-5" data-testid="corpus-manager">
      <h2 className="text-lg font-extrabold">📚 自定义语料（家长录入）</h2>
      <p className="mt-1 text-sm text-[var(--ec-muted)]">
        可以录入课本上的句子。归属隔离：只有<strong>你本人和你的孩子</strong>能看到、能练；其他家长录的句子互相不可见。
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          英文句子 *
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="I would like a glass of water, please."
            className="rounded-xl border border-[#d9dcf0] px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          中文翻译（可留空）
          <input
            value={translation}
            onChange={(e) => setTranslation(e.target.value)}
            placeholder="请给我一杯水。"
            className="rounded-xl border border-[#d9dcf0] px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          等级
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            className="rounded-xl border border-[#d9dcf0] px-3 py-2"
          >
            <option value="A1">A1</option>
            <option value="A2">A2</option>
            <option value="B1">B1</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          重点音素（可选，空格分隔，如 θ r）
          <input
            value={phonemes}
            onChange={(e) => setPhonemes(e.target.value)}
            placeholder="θ"
            className="rounded-xl border border-[#d9dcf0] px-3 py-2"
          />
        </label>
      </div>
      <div className="mt-3">
        <button type="button" className="ec-btn ec-btn-primary" onClick={addOne} disabled={busy || !text.trim()}>
          添加这一句
        </button>
      </div>

      <details className="mt-4 rounded-xl bg-[#f8f9ff] p-3">
        <summary className="cursor-pointer font-semibold">📋 从课本批量粘贴（每行一句）</summary>
        <p className="mt-2 text-xs text-[var(--ec-muted)]">
          每行一句英文即可；想带翻译就写成 <code>English sentence | 中文翻译</code>（或用 Tab 分隔）。
        </p>
        <textarea
          value={batch}
          onChange={(e) => setBatch(e.target.value)}
          rows={6}
          placeholder={"Good morning, Miss Li.\nHow many apples do you have? | 你有几个苹果？"}
          className="mt-2 w-full rounded-xl border border-[#d9dcf0] px-3 py-2 font-mono text-sm"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <select
            value={batchLevel}
            onChange={(e) => setBatchLevel(e.target.value)}
            className="rounded-xl border border-[#d9dcf0] px-3 py-2 text-sm"
          >
            <option value="A1">A1</option>
            <option value="A2">A2</option>
            <option value="B1">B1</option>
          </select>
          <button type="button" className="ec-btn ec-btn-ghost" onClick={addBatch} disabled={busy || !batch.trim()}>
            批量添加
          </button>
        </div>
      </details>

      {message ? <p className="ec-pop mt-3 text-sm font-semibold text-[var(--ec-green,#16a34a)]">{message}</p> : null}
      {error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

      <h3 className="mt-5 font-bold">我录入的句子（{items.length}）</h3>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--ec-muted)]">还没有自定义语料。</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2" data-testid="custom-sentence-list">
          {items.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e6e8f5] p-3">
              <span>
                <span className="font-semibold">{s.text}</span>
                <span className="ml-2 text-xs text-[var(--ec-muted)]">
                  {s.level}
                  {s.translation_zh ? ` · ${s.translation_zh}` : ""}
                  {s.focus_phonemes.length > 0 ? ` · 重点音素 ${s.focus_phonemes.join(" ")}` : ""}
                </span>
              </span>
              <button type="button" className="ec-btn ec-btn-ghost" onClick={() => remove(s.id)} disabled={busy}>
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
