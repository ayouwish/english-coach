"use client";

import { useEffect, useRef, useState } from "react";
import { AVATAR_STYLES, AVATAR_STYLE_LABELS, MAX_DESC_LENGTH, type AvatarStyle } from "@/lib/avatar-shared";

interface AvatarState {
  avatar_url: string | null;
  style: string | null;
  character_desc: string | null;
  prompt_used: string | null;
  updated_at: string | null;
}

/**
 * 「🎨 我的虚拟形象」（task-62）：拍照/上传照片 → voice 生成风格化形象（5 风格）。
 *
 * - 未设置：拍照/上传 + 风格卡片 + 生成（儿童文案「给我画一个我」）
 * - 已设置：显示头像 + 换一张 / 换风格 / 编辑形象描述（character_desc，可改「戴眼镜」之类）
 * - **提示词用户可见**（折叠「生成用的提示词」），便于反馈问题
 * - voice 未上线时显示可读提示，不白屏
 */
export function AvatarSection({ isChild }: { isChild: boolean }) {
  const [state, setState] = useState<AvatarState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [style, setStyle] = useState<AvatarStyle>("watercolor");
  const [desc, setDesc] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const fileRef = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/avatar");
      const data = (await res.json().catch(() => null)) as (AvatarState & { error?: { message?: string } }) | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `读取虚拟形象失败（HTTP ${res.status}）`);
        return;
      }
      setState(data);
      if (data?.style) setStyle((AVATAR_STYLES as readonly string[]).includes(data.style) ? (data.style as AvatarStyle) : "watercolor");
      setDesc(data?.character_desc ?? "");
    } catch (err) {
      setError(`读取虚拟形象失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const urls: string[] = [];
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  function pickPhoto(file: File) {
    if (!file.type.startsWith("image/")) {
      setError(`这不是图片（${file.type || "未知类型"}），请选择照片文件。`);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("照片太大（上限 10MB），换一张小一点的吧。");
      return;
    }
    fileRef.current = file;
    setError(null);
    setNotice(null);
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoUrl(URL.createObjectURL(file));
  }

  async function generate() {
    const file = fileRef.current;
    if (!file) {
      setError("先拍一张或选一张照片吧");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("photo", file, file.name || "photo.jpg");
      form.append("style", style);
      if (desc.trim()) form.append("character_desc", desc.trim());
      const res = await fetch("/api/avatar", { method: "POST", body: form });
      const data = (await res.json().catch(() => null)) as (AvatarState & { error?: { message?: string } }) | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `生成失败（HTTP ${res.status}）`);
        return;
      }
      setState(data);
      setNotice("形象生成好啦 ✅");
      setEditingDesc(false);
    } catch (err) {
      setError(`生成失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function patchDesc() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/avatar", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ character_desc: desc }),
      });
      const data = (await res.json().catch(() => null)) as (AvatarState & { message?: string; error?: { message?: string } }) | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `保存失败（HTTP ${res.status}）`);
        return;
      }
      setState(data);
      setNotice(data?.message ?? "形象描述已更新，下次画故事会用它");
      setEditingDesc(false);
    } catch (err) {
      setError(`保存失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function clearAvatar() {
    if (typeof window !== "undefined" && !window.confirm("确定清空虚拟形象吗？")) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/avatar", { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `清空失败（HTTP ${res.status}）`);
        return;
      }
      setState(null);
      setDesc("");
      setPhotoUrl(null);
      fileRef.current = null;
      setNotice("已清空虚拟形象");
    } catch (err) {
      setError(`清空失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const hasAvatar = Boolean(state?.avatar_url);

  return (
    <section className="ec-card" data-testid="avatar-section">
      <h2 className="text-lg font-extrabold">🎨 我的虚拟形象</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        {isChild
          ? "拍一张你的照片，选一个风格，我给你画一个「你」，以后的故事里就会用这个形象 🙂"
          : "拍照/上传照片 → 生成风格化形象；故事插画会参考它，让主角看起来像你。"}
      </p>

      {loading ? <p className="mt-3 text-sm text-[var(--ec-muted)]">加载中…</p> : null}

      {hasAvatar ? (
        <div className="mt-3 flex flex-wrap items-start gap-4" data-testid="avatar-current">
          {/* eslint-disable-next-line @next/next/no-img-element -- 本地 API 图片，无需 next/image */}
          <img src={state?.avatar_url ?? ""} alt="我的虚拟形象" data-testid="avatar-image" className="h-28 w-28 rounded-2xl border border-[#e6e8f5] object-cover" />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              风格：<strong>{state?.style ? AVATAR_STYLE_LABELS[state.style as AvatarStyle] ?? state.style : "—"}</strong>
              {state?.updated_at ? ` · ${new Date(state.updated_at).toLocaleDateString("zh-CN")}` : ""}
            </p>
            {state?.character_desc ? (
              <p className="mt-1 break-words text-xs text-[var(--ec-muted)]" data-testid="avatar-desc">
                形象描述：{state.character_desc}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="ec-btn ec-btn-primary !px-2 !py-0.5 text-xs"
                data-testid="avatar-regen"
                disabled={busy || !fileRef.current}
                onClick={() => void generate()}
              >
                {busy ? "生成中…" : "换一张"}
              </button>
              <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs" onClick={() => inputRef.current?.click()}>
                重新选照片
              </button>
              <button
                type="button"
                className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                data-testid="avatar-edit-desc"
                onClick={() => setEditingDesc((v) => !v)}
              >
                {editingDesc ? "收起描述" : "编辑形象描述"}
              </button>
              <button
                type="button"
                className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                data-testid="avatar-clear"
                disabled={busy}
                onClick={() => void clearAvatar()}
              >
                清空
              </button>
            </div>
            {state?.prompt_used ? (
              <details className="mt-2 text-xs text-[var(--ec-muted)]" data-testid="avatar-prompt">
                <summary className="cursor-pointer">生成用的提示词（可复制）</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#f8f9ff] p-2">{state.prompt_used}</pre>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 生成/换风格表单 */}
      <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3" data-testid="avatar-form">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="ec-btn ec-btn-primary" data-testid="avatar-pick" onClick={() => inputRef.current?.click()}>
            📷 {isChild ? "拍一张照片 / 选一张" : "拍照 / 上传照片"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            data-testid="avatar-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickPhoto(f);
              e.target.value = "";
            }}
          />
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- 本地预览
            <img src={photoUrl} alt="待生成的照片预览" data-testid="avatar-photo-preview" className="h-16 w-16 rounded-xl border border-[#e6e8f5] object-cover" />
          ) : null}
        </div>

        <p className="mt-3 text-sm font-semibold">选一个风格</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {AVATAR_STYLES.map((s) => (
            <button
              key={s}
              type="button"
              data-testid={`avatar-style-${s}`}
              aria-pressed={style === s}
              onClick={() => setStyle(s)}
              className={`ec-btn ${style === s ? "ec-btn-primary" : "ec-btn-ghost"} ${isChild ? "text-base" : "text-sm"}`}
            >
              {AVATAR_STYLE_LABELS[s]}
            </button>
          ))}
        </div>

        <div className="mt-3">
          <p className="text-sm font-semibold">
            形象描述（角色卡）{editingDesc ? "" : "（可编辑）"}
          </p>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value.slice(0, MAX_DESC_LENGTH))}
            rows={2}
            data-testid="avatar-desc-input"
            placeholder={isChild ? "比如：我有短头发，戴眼镜" : "比如：我女儿，7 岁，短发，戴红框眼镜，笑起来有小酒窝"}
            className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
          />
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ec-muted)]">
            <span>
              {desc.length} / {MAX_DESC_LENGTH} · 改完点「保存描述」，下次画故事会用它
            </span>
            <button
              type="button"
              className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
              data-testid="avatar-save-desc"
              disabled={busy || !hasAvatar}
              onClick={() => void patchDesc()}
            >
              保存描述
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="ec-btn ec-btn-primary" data-testid="avatar-generate" disabled={busy} onClick={() => void generate()}>
            {busy ? "🎨 正在画你的形象… 约 10–30 秒" : `🎨 ${isChild ? "给我画一个我" : hasAvatar ? "换风格生成" : "生成我的形象"}`}
          </button>
          {busy ? <span className="text-xs text-[var(--ec-muted)]">生成中，可以先去做别的，回来再看</span> : null}
        </div>
      </div>

      {error ? (
        <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="avatar-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 rounded-xl bg-[#e8f7ee] p-3 text-sm text-[#166534]" data-testid="avatar-notice">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
