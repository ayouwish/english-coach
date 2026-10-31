"use client";

import { useEffect, useState } from "react";
import { AVATAR_STYLE_LABELS, MAX_DESC_LENGTH, type AvatarStyle } from "@/lib/avatar-shared";

interface Presets {
  styles: { id: string; label_zh: string }[];
  characters: {
    id: string;
    label_zh: string;
    desc_en: string;
    audience: "child" | "adult";
    images: Record<string, string>;
  }[];
  placeholder: boolean;
}

interface AvatarState {
  avatar_url: string | null;
  preset_id: string | null;
  style: string | null;
  character_desc: string | null;
  prompt_used: string | null;
  updated_at: string | null;
}

/**
 * 「🎨 我的虚拟形象」= **预置形象选择题**（task-64，已改为不上传照片）。
 *
 * 用户决定不接受"照片上云"：这里只做选择题 —— 先选 5 种风格，再从 8 个预置角色里挑一个，
 * 点「就用这个」立即生效（**不生成图片、零等待**）。选中后角色描述会用于故事插画。
 */
export function AvatarSection({
  isChild,
  initialPresets = null,
  initialAvatar = null,
}: {
  isChild: boolean;
  /** 服务端预取的预置库（SSR 首屏就能看到风格卡片/角色网格） */
  initialPresets?: Presets | null;
  /** 服务端预取的当前形象 */
  initialAvatar?: AvatarState | null;
}) {
  const [presets, setPresets] = useState<Presets | null>(initialPresets);
  const [state, setState] = useState<AvatarState | null>(initialAvatar);
  const [loading, setLoading] = useState(!initialPresets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [style, setStyle] = useState<AvatarStyle>(
    (initialAvatar?.style as AvatarStyle) ?? "watercolor",
  );
  const [presetId, setPresetId] = useState<string | null>(initialAvatar?.preset_id ?? null);

  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState(initialAvatar?.character_desc ?? "");
  /** 形象分组（task-66：儿童/成人）——儿童默认「给小朋友的」，家长默认「给爸爸妈妈的」 */
  const [audience, setAudience] = useState<"child" | "adult">(isChild ? "child" : "adult");
  /** 图片加载失败的卡片（缺图时显示占位，不崩） */
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});

  /** 首屏已有服务端数据时，只在挂载后轻量刷新一次（不闪 loading） */
  useEffect(() => {
    if (!initialPresets && !initialAvatar) void load();
    else void refreshAvatar();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时刷新一次
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [pRes, aRes] = await Promise.all([fetch("/api/avatar/presets"), fetch("/api/avatar")]);
      const pData = (await pRes.json().catch(() => null)) as (Presets & { error?: { message?: string } }) | null;
      const aData = (await aRes.json().catch(() => null)) as (AvatarState & { error?: { message?: string } }) | null;
      if (!pRes.ok || !pData) {
        setError(pData?.error?.message ?? `读取预置形象库失败（HTTP ${pRes.status}）`);
      } else {
        setPresets({
          styles: pData.styles ?? [],
          characters: (pData.characters ?? []).map((c) => ({
            ...c,
            audience: c.audience === "adult" ? ("adult" as const) : ("child" as const),
          })),
          placeholder: pData.placeholder === true,
        });
      }
      if (aRes.ok && aData) {
        setState(aData);
        if (aData.style) setStyle(aData.style as AvatarStyle);
        if (aData.preset_id) setPresetId(aData.preset_id);
        setDesc(aData.character_desc ?? "");
      }
    } catch (err) {
      setError(`加载失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  /** 只刷新当前形象（预置库来自服务端 props），失败静默（首屏已有数据） */
  async function refreshAvatar() {
    try {
      const res = await fetch("/api/avatar");
      const data = (await res.json().catch(() => null)) as AvatarState | null;
      if (!res.ok || !data) return;
      setState(data);
      if (data.style) setStyle(data.style as AvatarStyle);
      if (data.preset_id) setPresetId(data.preset_id);
      setDesc(data.character_desc ?? "");
      } catch {
      /* 静默：首屏数据已够用 */
    }
  }

  async function choose() {
    if (!presetId) {
      setError(isChild ? "先点一个你喜欢的形象吧" : "请先选择一个预置形象");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/avatar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset_id: presetId, style }),
      });
      const data = (await res.json().catch(() => null)) as (AvatarState & { error?: { message?: string } }) | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `保存失败（HTTP ${res.status}）`);
        return;
      }
      setState(data);
      setDesc(data?.character_desc ?? "");
      setNotice(isChild ? "选好啦！这个就是我啦 🎉" : "已保存，下次画故事会用它");
    } catch (err) {
      setError(`保存失败：${(err as Error).message}`);
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
      setPresetId(null);
      setDesc("");
      setNotice("已清空虚拟形象");
    } catch (err) {
      setError(`清空失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const allCharacters = presets?.characters ?? [];
  const characters = allCharacters.filter((c) => (c.audience ?? "child") === audience);
  const childCount = allCharacters.filter((c) => (c.audience ?? "child") === "child").length;
  const adultCount = allCharacters.filter((c) => c.audience === "adult").length;
  const hasAvatar = Boolean(state?.avatar_url);

  return (
    <section className="ec-card" data-testid="avatar-section">
      <h2 className="text-lg font-extrabold">🎨 我的虚拟形象</h2>
      <p className="mt-1 rounded-xl bg-[#eef8ff] p-2 text-sm font-semibold text-[#1d4ed8]" data-testid="avatar-no-photo-note">
        🛡️ 不用上传照片，选一个就好
      </p>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        {isChild
          ? "从下面挑一个你喜欢的我，故事里的小人就会用它 🙂"
          : "预置卡通形象库：选风格 → 选角色 → 立即可用；故事插画会按这个形象生成。"}
        照片不会被上传。生成故事插画时会把<strong>角色描述文字</strong>（不是照片）发给 AI 服务。
      </p>

      {loading ? <p className="mt-3 text-sm text-[var(--ec-muted)]">加载中…</p> : null}

      {hasAvatar ? (
        <div className="mt-3 flex flex-wrap items-start gap-4" data-testid="avatar-current">
          {/* eslint-disable-next-line @next/next/no-img-element -- 预置静态图 */}
          <img
            src={state?.avatar_url ?? ""}
            alt="我的虚拟形象"
            data-testid="avatar-image"
            className="h-28 w-28 rounded-2xl border border-[#e6e8f5] object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              风格：<strong>{state?.style ? AVATAR_STYLE_LABELS[state.style as AvatarStyle] ?? state.style : "—"}</strong>
            </p>
            {state?.character_desc ? (
              <p className="mt-1 break-words text-xs text-[var(--ec-muted)]" data-testid="avatar-desc">
                形象描述：{state.character_desc}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <a href="#avatar-chooser" className="ec-btn ec-btn-primary !px-2 !py-0.5 text-xs" data-testid="avatar-change">
                {isChild ? "换一个" : "换一个形象"}
              </a>
              <button
                type="button"
                className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                data-testid="avatar-edit-desc"
                onClick={() => setEditingDesc((v) => !v)}
              >
                {editingDesc ? "收起描述" : "把描述改成更像我的"}
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
          </div>
        </div>
      ) : null}

      <div className="mt-3" data-testid="avatar-chooser">
          {presets?.placeholder ? (
            <p className="mb-2 rounded-lg bg-[#fff3d6] p-2 text-xs text-[#7a4d00]" data-testid="avatar-placeholder-note">
              预览图（未生成真实插画）：当前用的是占位图，真实预置图上线后会自动替换。
            </p>
          ) : null}

          <p className="text-sm font-semibold">第 1 步：选风格</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {(presets?.styles ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                data-testid={`avatar-style-${s.id}`}
                aria-pressed={style === s.id}
                onClick={() => setStyle(s.id as AvatarStyle)}
                className={`ec-btn ${style === s.id ? "ec-btn-primary" : "ec-btn-ghost"} ${isChild ? "text-base" : "text-sm"}`}
              >
                {s.label_zh}
              </button>
            ))}
          </div>

          <p className="mt-3 text-sm font-semibold">
            第 2 步：选一个形象（{audience === "child" ? (isChild ? "选一个你喜欢的我" : "给小朋友的") : isChild ? "给爸爸妈妈的" : "选一个你的形象"}）
          </p>
          <div className="mt-1 flex flex-wrap gap-2" data-testid="avatar-audience-tabs">
            <button
              type="button"
              data-testid="avatar-audience-child"
              aria-pressed={audience === "child"}
              onClick={() => setAudience("child")}
              className={`ec-btn ${audience === "child" ? "ec-btn-primary" : "ec-btn-ghost"} ${isChild ? "text-base" : "text-sm"}`}
            >
              🧒 给小朋友的（{childCount}）
            </button>
            <button
              type="button"
              data-testid="avatar-audience-adult"
              aria-pressed={audience === "adult"}
              onClick={() => setAudience("adult")}
              className={`ec-btn ${audience === "adult" ? "ec-btn-primary" : "ec-btn-ghost"} ${isChild ? "text-base" : "text-sm"}`}
            >
              🧑 给爸爸妈妈的（{adultCount}）
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="avatar-character-grid">
            {characters.map((c) => {
              const img = c.images[style] ?? "";
              const active = presetId === c.id;
              const broken = brokenImages[c.id];
              return (
                <button
                  key={c.id}
                  type="button"
                  data-testid={`avatar-preset-${c.id}`}
                  aria-pressed={active}
                  onClick={() => setPresetId(c.id)}
                  className={`flex flex-col items-center gap-1 rounded-xl border-2 p-2 text-center transition ${
                    active ? "border-[var(--ec-primary)] bg-[var(--ec-primary-soft)]" : "border-[#e6e8f5] bg-white"
                  }`}
                >
                  {broken || !img ? (
                    <span className="flex h-16 w-16 items-center justify-center rounded-lg bg-[#eef0f8] text-2xl" data-testid="avatar-image-placeholder">
                      🙂
                    </span>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- 预置静态图
                    <img
                      src={img}
                      alt={c.label_zh}
                      className="h-16 w-16 rounded-lg object-cover"
                      onError={() => setBrokenImages((prev) => ({ ...prev, [c.id]: true }))}
                    />
                  )}
                  <span className={isChild ? "text-sm font-semibold" : "text-xs font-semibold"}>{c.label_zh}</span>
                </button>
              );
            })}
            {characters.length === 0 ? (
              <p className="col-span-full text-xs text-[var(--ec-muted)]">预置形象库暂时不可用，请稍后再试。</p>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className="ec-btn ec-btn-primary" data-testid="avatar-choose" disabled={busy} onClick={() => void choose()}>
              {busy ? "保存中…" : isChild ? "就用这个！" : "就用这个"}
            </button>
            <span className="text-xs text-[var(--ec-muted)]">点一下立即生效，不需要等待生成</span>
          </div>
        </div>

      {editingDesc && hasAvatar ? (
        <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3" data-testid="avatar-desc-editor">
          <p className="text-sm font-semibold">把描述改成更像我的（会用在故事插画里）</p>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value.slice(0, MAX_DESC_LENGTH))}
            rows={2}
            data-testid="avatar-desc-input"
            className="mt-1 w-full rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
          />
          <div className="mt-1 flex items-center justify-between text-xs text-[var(--ec-muted)]">
            <span>
              {desc.length} / {MAX_DESC_LENGTH}
            </span>
            <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs" data-testid="avatar-save-desc" disabled={busy} onClick={() => void patchDesc()}>
              保存描述
            </button>
          </div>
        </div>
      ) : null}

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
