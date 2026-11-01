/**
 * 故事插画生成（task-53 / 76）：抽成 lib，手动接口与「保存后自动生成」共用同一套逻辑。
 * 失败抛 HttpError（可读文案）或 VoiceError（由调用方分类）。
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { readingMaterials } from "@/db/schema";
import { HttpError, type SessionUser } from "@/lib/auth";
import { getAvatar } from "@/lib/avatar";
import { base64ToBytes, MAX_ILLUSTRATION_BYTES, writeIllustration } from "@/lib/illustration";
import { buildCharacterDesc } from "@/lib/illustration-character";
import { getMaterial } from "@/lib/materials";
import { callIllustrate } from "@/lib/voice";

export interface IllustrationResult {
  ok: true;
  image_url: string;
  image_path: string;
  mime: string;
  provider: string | null;
  model: string | null;
  size: string | null;
  elapsed_ms: number | null;
  warnings: unknown[];
  prompt_used: string | null;
  character_used: boolean;
  character_desc_used: string;
  character_style_used: string | null;
  force: boolean;
}

/** 生成（或重生成）某故事的插画；成功返回结果，失败抛错（不写文件） */
export async function generateStoryIllustration(
  user: SessionUser,
  materialId: string,
  opts: { force?: boolean; style?: string } = {},
): Promise<IllustrationResult> {
  const material = await getMaterial(materialId);
  if (!material) throw new HttpError(404, "not_found", "找不到这个故事");
  const force = opts.force === true;
  const style = opts.style ?? "watercolor";

  const avatar = await getAvatar(user.id);
  // task-76 ②：提示词必须带性别（girl→a girl…；已选形象 → 用形象 desc_en；未设 → a child）
  const characterDesc = buildCharacterDesc({
    gender: user.gender,
    birthYear: user.birthYear,
    avatarDesc: avatar.character_desc,
  });
  const result = await callIllustrate({
    story_text: material.text,
    title_en: material.title,
    style,
    force,
    character_desc: characterDesc,
    character_style: avatar.style,
  });

  const bytes = base64ToBytes(result.image_b64 ?? "");
  if (!bytes) throw new HttpError(502, "provider_error", "插画服务返回的数据无法解析，请稍后再试");
  if (bytes.byteLength > MAX_ILLUSTRATION_BYTES) throw new HttpError(502, "provider_error", "生成的图片过大，请稍后再试");
  const written = writeIllustration(material.id, bytes);
  if (!written.ok) throw new HttpError(502, "provider_error", written.reason);

  await getDb()
    .update(readingMaterials)
    .set({
      imagePath: written.relativePath,
      imagePrompt: typeof result.prompt_used === "string" ? result.prompt_used.slice(0, 2000) : null,
      imageCharacterUsed: (result as { character_used?: unknown }).character_used ? 1 : 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(readingMaterials.id, material.id));

  return {
    ok: true,
    image_url: `/api/materials/${material.id}/image`,
    image_path: written.relativePath,
    mime: written.mime,
    provider: result.provider ?? null,
    model: result.model ?? null,
    size: result.size ?? null,
    elapsed_ms: result.elapsed_ms ?? null,
    warnings: result.warnings ?? [],
    prompt_used: typeof result.prompt_used === "string" ? result.prompt_used : null,
    character_used: Boolean((result as { character_used?: unknown }).character_used),
    character_desc_used: characterDesc,
    character_style_used: avatar.style,
    force,
  };
}
