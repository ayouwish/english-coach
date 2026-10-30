"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EncouragementBox } from "@/components/EncouragementBox";
import { Recorder } from "@/components/Recorder";
import { FeedbackCard, IssuesSection } from "@/components/ResultSections";
import { ScoreRadar } from "@/components/ScoreRadar";
import { WordBars } from "@/components/WordBars";
import { drawRandomSentences } from "@/lib/random-pick";
import { splitSentences } from "@/lib/sentence-split";
import type { FeedbackResult, PronounceIssue, PronounceResult } from "@/lib/types";

interface CorpusSentence {
  id: string;
  text: string;
  level: string;
}

interface FlowItem {
  /** 本地序号 */
  index: number;
  text: string;
  sentenceId: string | null;
  source: "corpus" | "custom";
  attemptId: string | null;
  status: "unsent" | "pending" | "scoring" | "done" | "failed";
  error: string | null;
  result: {
    scores: PronounceResult["scores"] | null;
    words: PronounceResult["words"];
    issues: PronounceIssue[];
    feedback: FeedbackResult | null;
    intonation: PronounceResult["intonation"] | null;
    recognized_text: string | null;
  } | null;
}

type Phase = "setup" | "running" | "summary";

const COUNTS = [5, 10, 15];

/**
 * 连读模式（task-24）：录完一句立刻进入下一句，评分在后台排队；右侧列表轮询更新。
 * - 复用现有 Recorder（不改它）
 * - 儿童：大字号/大按钮、文案口语化、绝不出现 IPA
 * - 失败可见：每条显示失败原因 + 「重录这句」
 */
export function FlowClient({
  isChild,
  userLevel,
  corpus,
  voiceReachable,
  ocrAvailable,
  heicAvailable,
}: {
  isChild: boolean;
  userLevel: string;
  corpus: CorpusSentence[];
  voiceReachable: boolean;
  /** voice 的 capabilities.ocr（未实现/未启用时为 false → 按钮置灰，不让用户白转圈） */
  ocrAvailable: boolean;
  /** voice 的 capabilities.heic（true = 服务端能解 HEIC，相册里的 HEIC 可直接上传） */
  heicAvailable: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [mode, setMode] = useState<"corpus" | "materials" | "custom">("corpus");
  const [level, setLevel] = useState(userLevel || "A1");
  const [start, setStart] = useState(0);
  const [count, setCount] = useState(5);
  /** 🎲 随机抽句（task-31）：结果只在事件回调里生成并存 state，**绝不在 render 里随机** */
  const [randomMode, setRandomMode] = useState(false);
  const [randomPick, setRandomPick] = useState<CorpusSentence[] | null>(null);
  const [customText, setCustomText] = useState("");
  const [customSentences, setCustomSentences] = useState<string[]>([]);
  const [items, setItems] = useState<FlowItem[]>([]);
  const [current, setCurrent] = useState(0);
  const [autoNext, setAutoNext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── 拍照识别（task-26）────────────────────────────────────────────────────
  const [ocrState, setOcrState] = useState<"idle" | "uploading" | "error">("idle");
  const [ocrPreviewUrl, setOcrPreviewUrl] = useState<string | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrInfo, setOcrInfo] = useState<{ provider: string; lines: number; elapsedMs: number | null } | null>(null);
  const ocrInputRef = useRef<HTMLInputElement | null>(null);
  const ocrGalleryRef = useRef<HTMLInputElement | null>(null);
  /** 多选相册时的进度（正在识别 k/N） */
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number } | null>(null);
  const lastImageRef = useRef<File | null>(null);
  /** voice 返回的预处理 JPEG（base64）——保存"我的书页"时一起存；null 表示这次只保存文字 */
  const [ocrImageB64, setOcrImageB64] = useState<string | null>(null);
  const [saveTitle, setSaveTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  // ── 我的书页（task-29）─────────────────────────────────────────────────────
  interface MaterialItem {
    id: string;
    title: string;
    sentence_count: number;
    has_image: boolean;
    source: string;
    created_at: string;
  }
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const [materialsError, setMaterialsError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editText, setEditText] = useState("");
  const [materialBusy, setMaterialBusy] = useState<string | null>(null);

  const loadMaterials = useCallback(async () => {
    setMaterialsLoading(true);
    setMaterialsError(null);
    try {
      const res = await fetch("/api/materials?limit=50");
      const data = (await res.json().catch(() => null)) as
        | { items?: MaterialItem[]; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setMaterialsError(data?.error?.message ?? `加载书页失败（HTTP ${res.status}）`);
        return;
      }
      setMaterials(data?.items ?? []);
    } catch (err) {
      setMaterialsError(`加载书页失败：${(err as Error).message}`);
    } finally {
      setMaterialsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === "materials") void loadMaterials();
  }, [mode, loadMaterials]);

  function startFromText(text: string, source: "corpus" | "custom") {
    const list = splitSentences(text);
    if (list.length === 0) {
      setError(isChild ? "这一页没有找到句子" : "这一页没有可读的句子");
      return;
    }
    setItems(
      list.map((t, i) => ({
        index: i,
        text: t,
        sentenceId: null,
        source,
        attemptId: null,
        status: "unsent" as const,
        error: null,
        result: null,
      })),
    );
    beginRun();
  }

  async function startMaterial(id: string) {
    setMaterialBusy(id);
    setMaterialsError(null);
    try {
      const res = await fetch(`/api/materials/${id}`);
      const data = (await res.json().catch(() => null)) as
        | { text?: string; error?: { message?: string } }
        | null;
      if (!res.ok || !data?.text) {
        setMaterialsError(data?.error?.message ?? `载入失败（HTTP ${res.status}）`);
        return;
      }
      startFromText(data.text, "custom");
    } catch (err) {
      setMaterialsError(`载入失败：${(err as Error).message}`);
    } finally {
      setMaterialBusy(null);
    }
  }

  async function saveMaterial() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/materials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: saveTitle.trim() || "未命名书页",
          text: customText,
          image_b64: ocrImageB64,
          source: ocrImageB64 ? "photo" : "text",
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { id?: string; has_image?: boolean; error?: { message?: string } }
        | null;
      if (!res.ok || !data?.id) {
        setSaveError(data?.error?.message ?? `保存失败（HTTP ${res.status}），请重试`);
        return;
      }
      setSavedId(data.id);
      void loadMaterials();
    } catch (err) {
      setSaveError(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function patchMaterial(id: string, patch: { title?: string; text?: string }) {
    setMaterialBusy(id);
    setMaterialsError(null);
    try {
      const res = await fetch(`/api/materials/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setMaterialsError(data?.error?.message ?? `保存失败（HTTP ${res.status}）`);
        return;
      }
      setEditingId(null);
      void loadMaterials();
    } catch (err) {
      setMaterialsError(`保存失败：${(err as Error).message}`);
    } finally {
      setMaterialBusy(null);
    }
  }

  async function removeMaterial(id: string) {
    if (typeof window !== "undefined" && !window.confirm("确定删除这个书页吗？（图片也会一起删掉）")) return;
    setMaterialBusy(id);
    setMaterialsError(null);
    try {
      const res = await fetch(`/api/materials/${id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setMaterialsError(data?.error?.message ?? `删除失败（HTTP ${res.status}）`);
        return;
      }
      setMaterials((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setMaterialsError(`删除失败：${(err as Error).message}`);
    } finally {
      setMaterialBusy(null);
    }
  }

  useEffect(() => {
    // 卸载时释放缩略图的 object URL
    return () => {
      if (ocrPreviewUrl) URL.revokeObjectURL(ocrPreviewUrl);
    };
  }, [ocrPreviewUrl]);

  function clearOcr() {
    if (ocrPreviewUrl) URL.revokeObjectURL(ocrPreviewUrl);
    setOcrPreviewUrl(null);
    setOcrInfo(null);
    setOcrError(null);
    setOcrState("idle");
    lastImageRef.current = null;
    if (ocrInputRef.current) ocrInputRef.current.value = "";
  }

  /** HEIC/HEIF 检测（iPhone 相册默认格式） */
  function isHeicFile(file: File): boolean {
    const type = (file.type || "").toLowerCase();
    return (
      type === "image/heic" ||
      type === "image/heif" ||
      type === "image/heic-sequence" ||
      type === "image/heif-sequence" ||
      /\.(heic|heif)$/i.test(file.name || "")
    );
  }

  const HEIC_HINT =
    "这是 iPhone 的 HEIC 格式照片，当前服务端还不能直接解码。建议：① 用「📷 拍照」按钮直接拍（会自动存成 JPEG）；② 或在相册里「存储为 JPEG」后再来选；③ 或先把它转成 JPEG/JPG 再上传。";

  /** 选图前的本地校验：返回错误文案（null = 可以上传） */
  function validatePicked(file: File): string | null {
    if (isHeicFile(file) && !heicAvailable) return HEIC_HINT;
    if (file.type && !file.type.startsWith("image/")) {
      return `这不是图片（${file.type || "未知类型"}），请重新拍照或选择图片文件。`;
    }
    if (!file.type && !/\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name || "")) {
      return `无法识别的文件类型（${file.name || "未命名"}），请选择图片文件。`;
    }
    if (file.size > 10 * 1024 * 1024) return "照片太大（上限 10MB），请靠近一点拍或拍小一点。";
    return null;
  }

  type OcrOutcome =
    | { ok: true; text: string; provider: string; lines: number; elapsedMs: number | null; imageB64: string | null }
    | { ok: false; error: string };

  /**
   * 识别一张图（不碰 UI 状态，只发请求 + 归一化结果）。
   * 错误语义保持 Lead 的版本：区分「请求失败」与「没识别到文字」，并透出 warnings。
   * 拍照 / 相册单选 / 相册多选 三个入口都走这一个函数。
   */
  async function recognize(file: File): Promise<OcrOutcome> {
    try {
      const form = new FormData();
      form.append("image", file, file.name || "page.jpg");
      // 让 voice 顺带返回预处理 JPEG（保存"我的书页"用）；voice 未实现时该字段为 null
      form.append("return_image", "1");
      const res = await fetch("/api/ocr", { method: "POST", body: form });
      const data = (await res.json().catch(() => null)) as
        | {
            text?: string;
            lines?: unknown[];
            provider?: string;
            elapsed_ms?: number;
            warnings?: string[];
            image_jpeg_b64?: string | null;
            error?: { message?: string };
          }
        | null;

      // ① 真正的失败（网络错、服务不可用、图片被拒等）：用服务端的可操作提示
      if (!res.ok) {
        return {
          ok: false,
          error:
            data?.error?.message ??
            `识别失败（HTTP ${res.status}）。可以换一张更清晰的照片，或改用「自己输入一段」。`,
        };
      }

      // ② 请求成功、但没识别出文字（HTTP 200 + text 为空）——不是"请求失败"，
      //    而是"这张图里没找到英文"。单独给出可操作的说法，并透出 voice 的 warnings 方便排查。
      const text = (data?.text ?? "").trim();
      if (!data || !text) {
        const warnings = (data?.warnings ?? []).filter(Boolean);
        const provider = data?.provider ?? "OCR";
        return {
          ok: false,
          error: isChild
            ? "这张图里没有找到英文句子。换一张更清楚的照片试试，或者用「✍️ 自己输入一段」。"
            : `这张图里没有识别到英文文字（${provider}${warnings.length ? `，warnings: ${warnings.join(", ")}` : ""}）。\n` +
              "多半是文字太小/太模糊/反光，或这张图里确实没有英文。可以换一张更清晰、文字更大的照片，或改用「自己输入一段」。",
        };
      }

      return {
        ok: true,
        text,
        provider: data.provider ?? "-",
        lines: (data.lines ?? []).length,
        elapsedMs: data.elapsed_ms ?? null,
        imageB64: typeof data.image_jpeg_b64 === "string" && data.image_jpeg_b64 ? data.image_jpeg_b64 : null,
      };
    } catch (err) {
      return { ok: false, error: `识别失败：${(err as Error).message}。可以重试或改用「自己输入一段」。` };
    }
  }

  /** 把识别出的文本追加到自定义文本框（与"再拍一张追加"语义一致） */
  function appendOcrText(out: Extract<OcrOutcome, { ok: true }>) {
    setMode("custom");
    setCustomText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${out.text}` : out.text));
    setCustomSentences(splitSentences(out.text));
    setOcrInfo({ provider: out.provider, lines: out.lines, elapsedMs: out.elapsedMs });
    if (out.imageB64) setOcrImageB64(out.imageB64);
    setSaveTitle((out.text.split("\n")[0] ?? "").slice(0, 40) || "未命名书页");
    setSavedId(null);
    setSaveError(null);
  }

  function setPreview(file: File) {
    lastImageRef.current = file;
    if (ocrPreviewUrl) URL.revokeObjectURL(ocrPreviewUrl);
    setOcrPreviewUrl(URL.createObjectURL(file));
  }

  /** 单张入口（📷 拍照）：保持原有状态语义 */
  async function runOcr(file: File) {
    if (!ocrAvailable) {
      setOcrError("当前部署未启用拍照识别，可以先用「✍️ 自己输入一段」。");
      setOcrState("error");
      return;
    }
    const invalid = validatePicked(file);
    if (invalid) {
      setOcrError(invalid);
      setOcrState("error");
      return;
    }
    setPreview(file);
    setOcrState("uploading");
    setOcrError(null);
    const out = await recognize(file);
    if (out.ok) {
      appendOcrText(out);
      setOcrState("idle");
    } else {
      setOcrError(out.error);
      setOcrState("error");
    }
  }

  /** 多选入口（🖼️ 从相册选）：依次识别、文本追加，期间显示「正在识别 k/N」 */
  async function runOcrMany(files: File[]) {
    if (!ocrAvailable) {
      setOcrError("当前部署未启用拍照识别，可以先用「✍️ 自己输入一段」。");
      setOcrState("error");
      return;
    }
    const valid: File[] = [];
    const problems: string[] = [];
    for (const f of files) {
      const invalid = validatePicked(f);
      if (invalid) problems.push(`${f.name || "未命名文件"}：${invalid}`);
      else valid.push(f);
    }
    if (valid.length === 0) {
      setOcrError(problems.join("\n"));
      setOcrState("error");
      return;
    }
    setOcrError(null);
    setOcrState("uploading");
    let okCount = 0;
    for (let i = 0; i < valid.length; i++) {
      setOcrProgress({ done: i, total: valid.length });
      setPreview(valid[i]);
      const out = await recognize(valid[i]);
      if (out.ok) {
        okCount += 1;
        appendOcrText(out);
      } else {
        problems.push(`${valid[i].name || `第 ${i + 1} 张`}：${out.error}`);
      }
      setOcrProgress({ done: i + 1, total: valid.length });
    }
    setOcrProgress(null);
    setOcrState(okCount > 0 ? "idle" : "error");
    if (problems.length > 0) setOcrError(problems.join("\n"));
  }
  const levels = useMemo(() => [...new Set(corpus.map((s) => s.level))].sort(), [corpus]);
  // level === "" 表示「全部」（随机时从 300 句里抽；非随机时按 sort_order 全量再 slice）
  const levelSentences = useMemo(
    () => (level === "" ? corpus : corpus.filter((s) => s.level === level)),
    [corpus, level],
  );
  const preview = useMemo(
    () => (randomMode && randomPick ? randomPick : levelSentences.slice(start, start + count)),
    [randomMode, randomPick, levelSentences, start, count],
  );

  /** 抽一批（只在事件回调里调用：切换随机 / 换一批 / 改级别 / 改条数） */
  function drawRandom(nextCount: number = count, nextLevel: string = level) {
    const pool = nextLevel === "" ? corpus : corpus.filter((s) => s.level === nextLevel);
    setRandomPick(drawRandomSentences(pool, nextCount));
  }

  function toggleRandom() {
    const next = !randomMode;
    setRandomMode(next);
    if (next) drawRandom();
    else setRandomPick(null); // 关闭：回到确定的 start/count 行为
  }

  function startCorpus() {
    if (preview.length === 0) {
      setError(isChild ? "这里还没有句子，换一个起点吧" : "这个位置没有句子，换个起点或级别试试");
      return;
    }
    setItems(
      preview.map((s, i) => ({
        index: i,
        text: s.text,
        sentenceId: s.id,
        source: "corpus",
        attemptId: null,
        status: "unsent",
        error: null,
        result: null,
      })),
    );
    beginRun();
  }

  function startCustom() {
    const list = customSentences.length > 0 ? customSentences : splitSentences(customText);
    if (list.length === 0) {
      setError(isChild ? "先写几句话吧" : "先输入一段文本，再点「切句」");
      return;
    }
    setCustomSentences(list);
    setItems(
      list.map((text, i) => ({
        index: i,
        text,
        sentenceId: null,
        source: "custom" as const,
        attemptId: null,
        status: "unsent" as const,
        error: null,
        result: null,
      })),
    );
    beginRun();
  }

  function beginRun() {
    setCurrent(0);
    setExpanded(null);
    setError(null);
    setPhase("running");
  }

  // 轮询：还有 pending/scoring 时每 1.2s 查一次
  const refreshStatuses = useCallback(async () => {
    const ids = items
      .filter((it) => it.attemptId && (it.status === "pending" || it.status === "scoring"))
      .map((it) => it.attemptId as string);
    if (ids.length === 0) return;
    try {
      const res = await fetch(`/api/attempts/status?ids=${encodeURIComponent(ids.join(","))}`);
      const data = (await res.json()) as {
        items?: { id: string; status: string; error: string | null; result: FlowItem["result"] }[];
      };
      if (!res.ok || !data.items) return;
      const byId = new Map(data.items.map((x) => [x.id, x]));
      setItems((prev) =>
        prev.map((it) => {
          if (!it.attemptId) return it;
          const upd = byId.get(it.attemptId);
          if (!upd) return it;
          return {
            ...it,
            status: upd.status as FlowItem["status"],
            error: upd.error,
            result: upd.result,
          };
        }),
      );
    } catch {
      /* 轮询失败静默重试（下一轮） */
    }
  }, [items]);

  useEffect(() => {
    if (phase !== "running") return;
    const anyPending = items.some((it) => it.status === "pending" || it.status === "scoring");
    if (!anyPending) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => void refreshStatuses(), 1200);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [phase, items, refreshStatuses]);

  // 全部处理完 → 汇总
  useEffect(() => {
    if (phase !== "running" || items.length === 0) return;
    const allSettled = items.every((it) => it.status === "done" || it.status === "failed");
    if (allSettled && items.every((it) => it.status !== "unsent")) setPhase("summary");
  }, [phase, items]);

  async function submit(blob: Blob, durationMs: number) {
    const item = items[current];
    if (!item) return;
    setBusy(true);
    setError(null);
    setLimitMessage(null);
    try {
      const form = new FormData();
      form.append("audio", blob, `flow.${blob.type.includes("wav") ? "wav" : "webm"}`);
      form.append("reference_text", item.text);
      form.append("mode", "scripted");
      form.append("source", item.source);
      if (item.sentenceId) form.append("sentence_id", item.sentenceId);
      form.append("duration_ms", String(Math.round(durationMs)));

      const res = await fetch("/api/attempts/async", { method: "POST", body: form });
      const data = (await res.json()) as { id?: string; status?: string; error?: { message?: string } };
      if (res.status === 429) {
        setLimitMessage(data?.error?.message ?? "今天的练习时间到啦 🌙");
        return;
      }
      if (!res.ok || !data.id) {
        setError(data?.error?.message ?? `提交失败（HTTP ${res.status}）—— 可以再录一次`);
        return;
      }
      setItems((prev) =>
        prev.map((it, i) =>
          i === current ? { ...it, attemptId: data.id as string, status: "pending" as const } : it,
        ),
      );
      // 立刻进入下一句（400ms 缓冲），评分留在后台
      const next = current + 1;
      if (next < items.length) {
        if (autoNext) setTimeout(() => setCurrent(next), 400);
        else setCurrent(next);
      }
    } catch (err) {
      setError(`${(err as Error).message}。可以再录一次，或稍后重试`);
    } finally {
      setBusy(false);
    }
  }

  function redo(index: number) {
    setItems((prev) =>
      prev.map((it, i) =>
        i === index ? { ...it, attemptId: null, status: "unsent", error: null, result: null } : it,
      ),
    );
    setCurrent(index);
    setExpanded(null);
    setPhase("running");
  }

  const doneItems = items.filter((it) => it.status === "done" && it.result?.scores);
  /** 鼓励语音的确定性种子：同一轮全部读完 → 同一句话（避免水合/重复播报不一致） */
  const encouragementSeed = items.map((it) => it.attemptId ?? `-${it.index}`).join("|") || "flow";
  const encouragementWords = doneItems.flatMap((it) => it.result?.words ?? []);
  const avgPron =
    doneItems.length > 0
      ? Math.round(
          (doneItems.reduce((a, it) => a + (it.result?.scores?.pron ?? 0), 0) / doneItems.length) * 10,
        ) / 10
      : null;
  const worst = [...doneItems]
    .sort((a, b) => (a.result?.scores?.pron ?? 0) - (b.result?.scores?.pron ?? 0))
    .slice(0, 3);

  const progress = items.length > 0 ? Math.round((items.filter((it) => it.status !== "unsent").length / items.length) * 100) : 0;

  // ── 设置阶段 ────────────────────────────────────────────────────────────────
  if (phase === "setup") {
    return (
      <div className="flex flex-col gap-5">
        <section className="ec-card">
          <h1 className="text-xl font-extrabold">🔗 {isChild ? "一口气读好多句" : "连读模式"}</h1>
          <p className="mt-1 text-sm text-[var(--ec-muted)]">
            {isChild
              ? "读完一句就自动跳到下一句，不用等评分。读完后分数会自己出现在下面的列表里 🙂"
              : "逐句连读：录完一句立刻进入下一句，评分在后台排队，结果陆续显示（每句仍有完整音素级反馈）。"}
          </p>
          {!voiceReachable ? (
            <p className="mt-2 rounded-xl bg-[#fff3d6] p-3 text-xs">
              ⚠️ 语音评测服务暂时不可用：句子仍会入库为「待评分」，服务恢复后可重试。
            </p>
          ) : null}
        </section>

        <section className="ec-card">
            {/* ── 拍照识别（task-26）────────────────────────────────────── */}
            <div className="rounded-xl bg-[#f8f9ff] p-3" data-testid="ocr-panel">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="ocr-button"
                  aria-label={isChild ? "拍张照识别书上的句子" : "拍照识别书页"}
                  disabled={!ocrAvailable || ocrState === "uploading"}
                  onClick={() => ocrInputRef.current?.click()}
                  className={`ec-btn ${ocrAvailable ? "ec-btn-primary" : "ec-btn-ghost"}`}
                >
                  📷 {isChild ? "拍张照" : "拍照"}
                  {ocrInfo ? (isChild ? "（再拍一张）" : "（再拍一张追加）") : ""}
                </button>
                {/* 拍照：capture 会直接唤起后置相机 */}
                <input
                  ref={ocrInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  data-testid="ocr-input"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void runOcr(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  data-testid="ocr-gallery-button"
                  aria-label={isChild ? "从相册里选一张照片" : "从相册/文件里选择照片"}
                  disabled={!ocrAvailable || ocrState === "uploading"}
                  onClick={() => ocrGalleryRef.current?.click()}
                  className={`ec-btn ${ocrAvailable ? "ec-btn-primary" : "ec-btn-ghost"}`}
                >
                  🖼️ {isChild ? "选一张照片" : "从相册选"}
                </button>
                {/* 相册/文件：**不带 capture**（否则手机只会唤起相机），支持一次多选 */}
                <input
                  ref={ocrGalleryRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  data-testid="ocr-input-gallery"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length === 1) void runOcr(files[0]);
                    else if (files.length > 1) void runOcrMany(files);
                    e.target.value = "";
                  }}
                />
                {ocrPreviewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 本地 object URL 缩略图，无需 next/image 优化
                  <img
                    src={ocrPreviewUrl}
                    alt="待识别照片预览"
                    data-testid="ocr-preview"
                    className="h-16 w-16 rounded-lg border border-[#e6e8f5] object-cover"
                  />
                ) : null}
                {ocrState === "uploading" ? (
                  <span className="text-sm text-[var(--ec-muted)]" data-testid="ocr-uploading">
                    {ocrProgress
                      ? `⏳ 正在识别 ${Math.min(ocrProgress.done + 1, ocrProgress.total)}/${ocrProgress.total}…`
                      : "⏳ 正在识别…（第一次识别可能要等 1–2 秒，请不要离开本页）"}
                  </span>
                ) : null}
                {ocrInfo ? (
                  <span className="text-xs text-[var(--ec-muted)]" data-testid="ocr-info">
                    已识别 {ocrInfo.lines} 行 · {ocrInfo.provider}
                    {ocrInfo.elapsedMs !== null ? ` · ${ocrInfo.elapsedMs}ms` : ""}，已追加到下面的文本框
                  </span>
                ) : null}
                {ocrPreviewUrl ? (
                  <button
                    type="button"
                    className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                    data-testid="ocr-clear"
                    onClick={clearOcr}
                  >
                    清空重来
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-[var(--ec-muted)]" data-testid="ocr-heic-note">
                📱 iPhone 相册如果存的是 HEIC：用「📷 拍照」拍会自动存成 JPEG，或先在相册里「存储为 JPEG」再来选。
                {heicAvailable ? "（当前服务端支持 HEIC 解码，可直接上传。）" : ""}
              </p>
              <p className="mt-2 text-xs text-[var(--ec-muted)]" data-testid="ocr-privacy">
                🔒 照片会保存在<strong>你自己的 NAS 上</strong>（方便以后反复读）；识别时会上传到你配置的 AI 服务（DeepSeek）。
              </p>
              {!ocrAvailable ? (
                <p className="mt-1 text-xs" data-testid="ocr-unavailable">
                  当前部署<strong>未启用</strong>拍照识别 —— 可以先用下面的「自己输入一段」。
                </p>
              ) : null}
              {/* 识别成功后：保存为「我的书页」（task-29） */}
              {ocrInfo && customText.trim() ? (
                <div className="mt-3 rounded-xl bg-white p-3" data-testid="save-material-panel">
                  <p className="text-sm font-semibold">💾 {isChild ? "存起来以后还能读" : "保存为我的书页"}</p>
                  {ocrImageB64 ? (
                    <p className="mt-1 text-xs text-[var(--ec-muted)]">这次也拿到了书页图片，会一起保存。</p>
                  ) : (
                    <p className="mt-1 text-xs text-[#b45309]" data-testid="save-text-only">
                      这次没拿到图片，只保存了文字（识别服务暂未返回图片）。
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      value={saveTitle}
                      onChange={(e) => setSaveTitle(e.target.value.slice(0, 60))}
                      placeholder="书页标题（默认取第一行）"
                      data-testid="save-material-title"
                      className="min-w-0 flex-1 rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      data-testid="save-material"
                      disabled={saving || Boolean(savedId)}
                      onClick={() => void saveMaterial()}
                      className="ec-btn ec-btn-primary"
                    >
                      {saving ? "保存中…" : savedId ? "已保存 ✅" : isChild ? "💾 存起来" : "💾 保存为我的书页"}
                    </button>
                    {savedId ? (
                      <button
                        type="button"
                        data-testid="save-then-read"
                        onClick={() => startFromText(customText, "custom")}
                        className="ec-btn ec-btn-ghost"
                      >
                        立即开始读 →
                      </button>
                    ) : null}
                  </div>
                  {saveError ? (
                    <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700" role="alert" data-testid="save-material-error">
                      {saveError}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {ocrError ? (
                <p
                  // whitespace-pre-line：错误文案里有多行（原因 + 怎么办），别让它们挤成一行
                  className="mt-2 whitespace-pre-line rounded-xl bg-red-50 p-2 text-sm text-red-700"
                  role="alert"
                  data-testid="ocr-error"
                >
                  {ocrError}
                  <button
                    type="button"
                    className="ec-btn ec-btn-ghost ml-2 !px-2 !py-0.5 text-xs"
                    data-testid="ocr-retry"
                    onClick={() => {
                      const f = lastImageRef.current;
                      if (f) void runOcr(f);
                      else ocrInputRef.current?.click();
                    }}
                  >
                    重试
                  </button>
                </p>
              ) : null}
            </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={`ec-btn ${mode === "corpus" ? "ec-btn-primary" : "ec-btn-ghost"}`}
              onClick={() => setMode("corpus")}
            >
              📚 从语料选
            </button>
            <button
              type="button"
              data-testid="flow-mode-materials"
              className={`ec-btn ${mode === "materials" ? "ec-btn-primary" : "ec-btn-ghost"}`}
              onClick={() => setMode("materials")}
            >
              📚 {isChild ? "我的书页" : "我的书页"}
            </button>
            <button
              type="button"
              className={`ec-btn ${mode === "custom" ? "ec-btn-primary" : "ec-btn-ghost"}`}
              onClick={() => setMode("custom")}
            >
              ✍️ 自己输入一段
            </button>
          </div>

          {mode === "materials" ? (
            <div className="mt-4 flex flex-col gap-3" data-testid="materials-panel">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">📚 我的书页（家里人的都在这里）</p>
                <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs" onClick={() => void loadMaterials()}>
                  刷新
                </button>
                {materialsLoading ? <span className="text-xs text-[var(--ec-muted)]">加载中…</span> : null}
              </div>
              {materialsError ? (
                <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="materials-error">
                  {materialsError}
                </p>
              ) : null}
              {materials.length === 0 && !materialsLoading ? (
                <p className="text-sm text-[var(--ec-muted)]" data-testid="materials-empty">
                  还没有保存的书页。可以先用「📷 {isChild ? "拍张照" : "拍照识别"}」拍一页，识别后点「💾 存起来」。
                </p>
              ) : null}
              <div className="flex flex-col gap-2">
                {materials.map((m) => (
                  <div key={m.id} className="rounded-xl border border-[#e6e8f5] p-3" data-testid="material-card" data-id={m.id}>
                    <div className="flex flex-wrap items-center gap-3">
                      {m.has_image ? (
                        // eslint-disable-next-line @next/next/no-img-element -- 本地 API 图片，无需 next/image
                        <img
                          src={`/api/materials/${m.id}/image`}
                          alt={`${m.title} 的缩略图`}
                          data-testid="material-thumb"
                          className="h-14 w-14 rounded-lg border border-[#e6e8f5] object-cover"
                        />
                      ) : (
                        <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-[#eef0f8] text-xs text-[var(--ec-muted)]">
                          只有文字
                        </span>
                      )}
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        data-testid="material-open"
                        disabled={materialBusy === m.id}
                        onClick={() => void startMaterial(m.id)}
                      >
                        <span className="block truncate font-semibold">{m.title}</span>
                        <span className="block text-xs text-[var(--ec-muted)]">
                          {m.sentence_count} 句 · {new Date(m.created_at).toLocaleDateString("zh-CN")}
                          {m.has_image ? " · 有图片" : " · 仅文字"}
                        </span>
                      </button>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                          data-testid="material-rename"
                          onClick={() => {
                            setEditingId(m.id);
                            setEditTitle(m.title);
                            setEditText("");
                          }}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                          data-testid="material-edit"
                          onClick={async () => {
                            setEditingId(m.id);
                            setEditTitle("");
                            try {
                              const res = await fetch(`/api/materials/${m.id}`);
                              const d = (await res.json().catch(() => null)) as { text?: string } | null;
                              setEditText(d?.text ?? "");
                            } catch {
                              setMaterialsError("读取书页文本失败，请重试");
                              setEditText("");
                            }
                          }}
                        >
                          编辑文本
                        </button>
                        <button
                          type="button"
                          className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                          data-testid="material-delete"
                          disabled={materialBusy === m.id}
                          onClick={() => void removeMaterial(m.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>

                    {editingId === m.id ? (
                      <div className="mt-2 flex flex-col gap-2">
                        <input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value.slice(0, 60))}
                          placeholder="新标题（留空表示不改）"
                          data-testid="material-title-input"
                          className="rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
                        />
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={4}
                          data-testid="material-text-input"
                          aria-label="编辑书页文本"
                          className="w-full rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
                        />
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="ec-btn ec-btn-primary !px-2 !py-0.5 text-xs"
                            data-testid="material-save"
                            disabled={materialBusy === m.id}
                            onClick={() =>
                              void patchMaterial(m.id, {
                                ...(editTitle.trim() ? { title: editTitle.trim() } : {}),
                                ...(editText.trim() ? { text: editText } : {}),
                              })
                            }
                          >
                            保存修改
                          </button>
                          <button
                            type="button"
                            className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                            onClick={() => setEditingId(null)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {mode === "corpus" ? (
            <div className="mt-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  级别
                  <select
                    value={level}
                    data-testid="corpus-level"
                    onChange={(e) => {
                      const next = e.target.value;
                      setLevel(next);
                      setStart(0);
                      if (randomMode) drawRandom(count, next);
                    }}
                    className="rounded-xl border border-[#d9dcf0] px-2 py-1"
                  >
                    {levels.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                    <option value="">全部（{corpus.length} 句）</option>
                  </select>
                </label>
                {!randomMode ? (
                  <label className="flex items-center gap-2" data-testid="corpus-start-label">
                    从第
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0, levelSentences.length - 1)}
                      value={start}
                      onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
                      className="w-16 rounded-xl border border-[#d9dcf0] px-2 py-1"
                      data-testid="corpus-start-input"
                    />
                    句开始
                  </label>
                ) : null}
                <label className="flex items-center gap-2">
                  读
                  <select
                    value={count}
                    data-testid="corpus-count"
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setCount(n);
                      if (randomMode) drawRandom(n, level);
                    }}
                    className="rounded-xl border border-[#d9dcf0] px-2 py-1"
                  >
                    {COUNTS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  句
                </label>
                <button
                  type="button"
                  data-testid="corpus-random-toggle"
                  aria-pressed={randomMode}
                  aria-label={randomMode ? "关闭随机抽句" : "开启随机抽句"}
                  onClick={toggleRandom}
                  className={`ec-btn ${randomMode ? "ec-btn-primary" : "ec-btn-ghost"}`}
                >
                  🎲 {isChild ? "随机来几句" : "随机"}
                </button>
                {randomMode ? (
                  <button
                    type="button"
                    data-testid="corpus-reshuffle"
                    aria-label="换一批随机句子"
                    onClick={() => drawRandom()}
                    className="ec-btn ec-btn-ghost"
                  >
                    🔀 换一批
                  </button>
                ) : null}
              </div>
              {randomMode ? (
                <p className="text-xs text-[var(--ec-muted)]" data-testid="corpus-random-hint">
                  {isChild
                    ? "每次都随机来几句，不会重复；想换就点「🔀 换一批」。"
                    : "从当前级别的句子里随机抽取、不重复；点「🔀 换一批」重新抽。"}
                </p>
              ) : null}
              <ol className="list-decimal pl-6 text-sm" data-testid="flow-preview">
                {preview.map((s) => (
                  <li key={s.id} className="py-0.5" data-testid="corpus-preview-item" data-id={s.id}>
                    {s.text}
                  </li>
                ))}
                {preview.length === 0 ? <li className="text-[var(--ec-muted)]">这个位置没有句子</li> : null}
              </ol>
              <div>
                <button type="button" className="ec-btn ec-btn-primary" data-testid="flow-start" onClick={startCorpus}>
                  🎤 开始连读（{preview.length} 句）
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <textarea
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                rows={4}
                placeholder="把想读的英文段落贴进来（会按 . ! ? 。！？ 自动切句）"
                className="w-full rounded-xl border border-[#d9dcf0] px-3 py-2 text-sm"
                data-testid="flow-custom-input"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="ec-btn ec-btn-ghost"
                  data-testid="flow-split"
                  onClick={() => {
                    setCustomSentences(splitSentences(customText));
                    setError(null);
                  }}
                >
                  ✂️ 切句
                </button>
                <span className="text-xs text-[var(--ec-muted)]">
                  切出 {customSentences.length} 句（可逐句修改后再开始）
                </span>
              </div>
              {customSentences.length > 0 ? (
                <ol className="flex flex-col gap-2">
                  {customSentences.map((s, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-6 text-right text-xs text-[var(--ec-muted)]">{i + 1}</span>
                      <input
                        value={s}
                        onChange={(e) =>
                          setCustomSentences((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                        }
                        className="min-w-0 flex-1 rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
                      />
                    </li>
                  ))}
                </ol>
              ) : null}
              <div>
                <button
                  type="button"
                  className="ec-btn ec-btn-primary"
                  data-testid="flow-start-custom"
                  disabled={customSentences.length === 0}
                  onClick={startCustom}
                >
                  🎤 开始连读（{customSentences.length} 句）
                </button>
              </div>
            </div>
          )}

          {error ? (
            <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    );
  }

  // ── 汇总阶段 ────────────────────────────────────────────────────────────────
  if (phase === "summary") {
    return (
      <div className="flex flex-col gap-5">
        <section className="ec-card">
          <h1 className="text-xl font-extrabold">🎉 {isChild ? "读完啦！" : "连读完成"}</h1>
          <p className="mt-2 text-sm">
            共 {items.length} 句 · 已评分 {doneItems.length} 句
            {items.some((it) => it.status === "failed") ? ` · 失败 ${items.filter((it) => it.status === "failed").length} 句` : ""}
            {avgPron !== null ? (
              <>
                {" "}
                · 平均 <strong className="text-lg">{avgPron}</strong> 分
              </>
            ) : null}
          </p>
          {/* 读完之后的分级鼓励（task-45）：按平均分/完成情况选文案，中英双语 + 顺序播放 */}
          <EncouragementBox
            attemptId={encouragementSeed}
            pron={avgPron}
            noSpeech={doneItems.length === 0}
            words={encouragementWords}
            isChild={isChild}
          />

          {worst.length > 0 ? (
            <div className="mt-3" data-testid="flow-worst">
              <h2 className="font-bold">{isChild ? "这几句可以再读一遍" : "最需要再练的几句"}</h2>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {worst.map((it) => (
                  <li key={it.index}>
                    {it.result?.scores?.pron ?? "—"} 分 · {it.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className="ec-btn ec-btn-primary" href="/report">
              📊 看发音诊断
            </Link>
            <button
              type="button"
              className="ec-btn ec-btn-ghost"
              onClick={() => {
                setPhase("setup");
                setItems([]);
              }}
            >
              再读一段
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          {items.map((it) => (
            <FlowRow
              key={it.index}
              item={it}
              isChild={isChild}
              expanded={expanded === it.index}
              onToggle={() => setExpanded(expanded === it.index ? null : it.index)}
              onRedo={() => redo(it.index)}
            />
          ))}
        </section>
      </div>
    );
  }

  // ── 连读中 ──────────────────────────────────────────────────────────────────
  const item = items[current];
  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-extrabold">🔗 {isChild ? "一句一句读" : "连读模式"}</h1>
          <span className="rounded-full bg-[var(--ec-primary-soft)] px-3 py-1 text-sm font-semibold text-[var(--ec-primary)]">
            {isChild ? "第" : "第"} {Math.min(current + 1, items.length)} / {items.length} {isChild ? "句" : "句"}
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[#eef0f8]">
          <div className="h-full rounded-full bg-[var(--ec-primary)] transition-all" style={{ width: `${progress}%` }} />
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-[var(--ec-muted)]">
          <input type="checkbox" checked={autoNext} onChange={(e) => setAutoNext(e.target.checked)} />
          {isChild ? "读完自动跳到下一句" : "录完后自动进入下一句（400ms 缓冲）"}
        </label>
        {limitMessage ? (
          <p className="mt-2 rounded-xl bg-[#fff3d6] p-3 text-sm" data-testid="limit-banner">
            🌙 {limitMessage}
          </p>
        ) : null}
      </section>

      {item ? (
        <section className="ec-card">
          <p className={isChild ? "text-3xl font-extrabold leading-snug" : "text-2xl font-extrabold leading-snug"}>
            {item.text}
          </p>
          <div className="mt-4">
            <Recorder onRecorded={submit} disabled={busy} isChild={isChild} recording={busy} />
          </div>
          {item.status !== "unsent" ? (
            <p className="mt-2 text-xs text-[var(--ec-muted)]">
              这一句已提交，{item.status === "pending" ? "正在排队评分…" : item.status === "scoring" ? "正在评分…" : item.status === "done" ? "已评分 ✅" : "评分失败"}
              （可以继续读下一句）
            </p>
          ) : null}
          {!autoNext && current + 1 < items.length ? (
            <button type="button" className="ec-btn ec-btn-ghost mt-2" onClick={() => setCurrent(current + 1)}>
              下一句 →
            </button>
          ) : null}
          {error ? (
            <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="flow-error">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2" data-testid="flow-list">
        <h2 className="font-bold">{isChild ? "评分结果（会自动更新）" : "实时评分"}</h2>
        {items.map((it) => (
          <FlowRow
            key={it.index}
            item={it}
            isChild={isChild}
            expanded={expanded === it.index}
            onToggle={() => setExpanded(expanded === it.index ? null : it.index)}
            onRedo={() => redo(it.index)}
            highlight={it.index === current}
          />
        ))}
      </section>
    </div>
  );
}

function FlowRow({
  item,
  isChild,
  expanded,
  onToggle,
  onRedo,
  highlight = false,
}: {
  item: FlowItem;
  isChild: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRedo: () => void;
  highlight?: boolean;
}) {
  const score = item.result?.scores?.pron ?? null;
  const badge =
    item.status === "done"
      ? `${score ?? "—"} 分`
      : item.status === "scoring"
        ? "评分中…"
        : item.status === "pending"
          ? "待评分…"
          : item.status === "failed"
            ? "评分失败"
            : "未读";
  return (
    <article
      className={`ec-card ${highlight ? "border-2 border-[var(--ec-primary)]" : ""}`}
      data-testid="flow-item"
      data-status={item.status}
    >
      <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={onToggle}>
        <span className="min-w-0 flex-1 truncate text-sm">
          {item.index + 1}. {item.text}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
            item.status === "done" ? "bg-[#e8f7ee] text-[#166534]" : item.status === "failed" ? "bg-red-50 text-red-700" : "bg-[#eef0f8]"
          }`}
          data-testid="flow-item-status"
        >
          {badge}
        </span>
      </button>

      {item.status === "failed" ? (
        <p className="mt-2 text-xs text-red-700">
          {item.error ?? "评分失败"}
          <button type="button" className="ec-btn ec-btn-ghost ml-2 !px-2 !py-0.5 text-xs" onClick={onRedo}>
            重录这句
          </button>
        </p>
      ) : null}

      {expanded && item.result ? (
        <div className="mt-3 flex flex-col gap-3" data-testid="flow-item-detail">
          <ScoreRadar
            scores={
              item.result.scores ?? {
                pron: null,
                accuracy: null,
                fluency: null,
                completeness: null,
                prosody: null,
              }
            }
            isChild={isChild}
          />
          <WordBars words={item.result.words ?? []} isChild={isChild} />
          <FeedbackCard feedback={item.result.feedback} isChild={isChild} />
          <IssuesSection issues={item.result.issues ?? []} isChild={isChild} phonemeLevel={false} />
        </div>
      ) : null}
    </article>
  );
}
