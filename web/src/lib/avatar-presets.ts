/**
 * 预置形象库（task-64）：优先读仓库内的 `src/data/avatar-presets.json`
 * （由 voice 侧脚本生成并提交），文件不存在时回退 voice `/v1/image/avatar/presets`。
 *
 * 图片静态托管于 `web/public/avatars/presets/`，**不经 voice 代理**。
 * 占位图（`placeholder: true`）时 UI 标注「预览图（未生成真实插画）」。
 */
import fs from "node:fs";
import path from "node:path";
import type { AvatarPresets } from "./avatar";
import { isForbiddenStyle } from "./avatar";
import { callAvatarPresets, VoiceError } from "./voice";

const DATA_FILE = path.join(process.cwd(), "src", "data", "avatar-presets.json");

function normalize(raw: unknown): AvatarPresets | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const stylesRaw = Array.isArray(obj.styles) ? obj.styles : [];
  const styles = stylesRaw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
    .map((s) => ({ id: String(s.id ?? ""), label_zh: String(s.label_zh ?? s.id ?? "") }))
    .filter((s) => s.id && !isForbiddenStyle(s.id));
  const charsRaw = Array.isArray(obj.characters) ? obj.characters : [];
  const characters = charsRaw
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
    .map((c) => ({
      id: String(c.id ?? ""),
      label_zh: String(c.label_zh ?? c.id ?? ""),
      desc_en: String(c.desc_en ?? ""),
      images: (typeof c.images === "object" && c.images ? c.images : {}) as Record<string, string>,
    }))
    .filter((c) => c.id && c.desc_en);
  if (styles.length === 0 || characters.length === 0) return null;
  return { styles, characters, placeholder: obj.placeholder === true };
}

/** 读取预置库：先仓库文件，再 voice 兜底；都不可用 → null（页面显示可读提示） */
export async function loadAvatarPresets(): Promise<AvatarPresets | null> {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = normalize(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
      if (parsed) return parsed;
    }
  } catch (err) {
    console.warn("[avatar-presets] 读取仓库文件失败：", (err as Error).message);
  }
  try {
    const fromVoice = await callAvatarPresets();
    return normalize(fromVoice);
  } catch (err) {
    if (!(err instanceof VoiceError)) console.warn("[avatar-presets] voice 兜底失败：", (err as Error).message);
    return null;
  }
}

/** 校验并取某个 (preset, style) 的静态图路径 + 角色描述 */
export function resolvePresetChoice(
  presets: AvatarPresets,
  presetId: unknown,
  style: unknown,
): { imagePath: string; descEn: string; style: string } | null {
  if (typeof presetId !== "string" || typeof style !== "string") return null;
  if (isForbiddenStyle(style)) return null;
  const character = presets.characters.find((c) => c.id === presetId);
  if (!character) return null;
  if (!presets.styles.some((s) => s.id === style)) return null;
  const url = character.images[style];
  if (!url || !/^\/avatars\/presets\/[\w.-]+$/.test(url)) return null;
  return { imagePath: url.replace(/^\//, ""), descEn: character.desc_en, style };
}
