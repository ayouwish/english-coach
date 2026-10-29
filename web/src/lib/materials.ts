/**
 * 书页材料库（task-29）：保存识别过的书页（文本 + voice 预处理后的 JPEG），
 * 以后在连读模式里反复读。
 *
 * 存储：
 *   - 元数据在 `reading_materials` 表；
 *   - 图片落 `DATA_DIR/materials/<id>.jpg`（与 audio/ 同级），**不入库、不进缓存淘汰**；
 *   - 写入用「临时文件 + rename」原子写；路径解析限定在 materials/ 内（防目录穿越）。
 *
 * 权限：家庭共享（所有登录用户都能看/读）；**删除/修改 = 创建者或家长**。
 * 隐私：照片会留在用户自己的 NAS 上（UI 文案已同步更新）。
 */
import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { DATA_DIR, getDb } from "@/db";
import { readingMaterials } from "@/db/schema";
import type { SessionUser } from "./auth";
import { countSentences } from "./sentence-split";

export const MATERIALS_DIR = path.join(DATA_DIR, "materials");
export const MAX_TITLE = 60;
export const MAX_TEXT = 20000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class MaterialValidationError extends Error {}

function ensureDir() {
  fs.mkdirSync(MATERIALS_DIR, { recursive: true });
}

/** 只允许解析到 materials/ 内部（防目录穿越；参照 audio.ts 的做法） */
export function resolveMaterialPath(relativePath: string): string | null {
  const abs = path.resolve(DATA_DIR, relativePath);
  const root = path.resolve(MATERIALS_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function looksLikeJpeg(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** 原子写：先写 .tmp 再 rename（避免半张图被读到） */
export function writeMaterialImage(id: string, jpeg: Uint8Array): string | null {
  if (!looksLikeJpeg(jpeg)) return null;
  if (jpeg.byteLength > MAX_IMAGE_BYTES) return null;
  ensureDir();
  const fileName = `${id.replace(/[^A-Za-z0-9_-]/g, "")}.jpg`;
  const abs = path.join(MATERIALS_DIR, fileName);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, jpeg);
  fs.renameSync(tmp, abs);
  return path.posix.join("materials", fileName);
}

export function deleteMaterialImage(relativePath: string | null): void {
  if (!relativePath) return;
  const abs = resolveMaterialPath(relativePath);
  if (!abs) return;
  try {
    fs.unlinkSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[materials] 删除图片失败", abs, err);
    }
  }
}

export interface MaterialRow {
  id: string;
  title: string;
  text: string;
  imagePath: string | null;
  sentenceCount: number;
  source: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialSummary {
  id: string;
  title: string;
  sentence_count: number;
  has_image: boolean;
  source: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toSummary(r: typeof readingMaterials.$inferSelect): MaterialSummary {
  return {
    id: r.id,
    title: r.title,
    sentence_count: r.sentenceCount,
    has_image: Boolean(r.imagePath),
    source: r.source,
    created_by: r.createdBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function normalizeTitle(raw: unknown): string {
  const t = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!t) throw new MaterialValidationError("标题不能为空");
  if (t.length > MAX_TITLE) throw new MaterialValidationError(`标题最多 ${MAX_TITLE} 字（当前 ${t.length}）`);
  return t;
}

function normalizeText(raw: unknown): string {
  const t = typeof raw === "string" ? raw.replace(/\r\n/g, "\n").trim() : "";
  if (!t) throw new MaterialValidationError("内容不能为空");
  if (t.length > MAX_TEXT) throw new MaterialValidationError(`内容最多 ${MAX_TEXT} 字（当前 ${t.length}）`);
  return t;
}

export async function createMaterial(
  user: SessionUser,
  input: { title?: unknown; text?: unknown; imageB64?: unknown; source?: unknown },
): Promise<MaterialSummary> {
  const title = normalizeTitle(input.title);
  const text = normalizeText(input.text);
  const source = input.source === "text" ? "text" : "photo";
  const id = `mat_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  let imagePath: string | null = null;
  if (typeof input.imageB64 === "string" && input.imageB64.trim()) {
    const b64 = input.imageB64.replace(/^data:image\/[a-z]+;base64,/i, "").trim();
    if (b64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 100) {
      throw new MaterialValidationError("图片太大（上限 5MB）");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      throw new MaterialValidationError("图片数据不是合法的 base64");
    }
    if (bytes.byteLength > 0) {
      imagePath = writeMaterialImage(id, new Uint8Array(bytes));
      if (!imagePath) {
        // 不是 JPEG / 太大 → 不阻断保存，只是没有图（UI 会说明"只保存了文字"）
        console.warn("[materials] 图片不是有效 JPEG，已忽略（仅保存文本）");
      }
    }
  }

  const now = new Date().toISOString();
  const db = getDb();
  await db.insert(readingMaterials).values({
    id,
    createdBy: user.id,
    title,
    text,
    imagePath,
    sentenceCount: countSentences(text),
    source,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(readingMaterials).where(eq(readingMaterials.id, id)).limit(1);
  return toSummary(row);
}

export async function listMaterials(opts: { limit?: number; offset?: number } = {}): Promise<MaterialSummary[]> {
  const db = getDb();
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = await db
    .select()
    .from(readingMaterials)
    .orderBy(desc(readingMaterials.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map(toSummary);
}

export async function getMaterial(id: string): Promise<MaterialRow | null> {
  const db = getDb();
  const [row] = await db.select().from(readingMaterials).where(eq(readingMaterials.id, id)).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    imagePath: row.imagePath,
    sentenceCount: row.sentenceCount,
    source: row.source,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 删除/修改权限：创建者本人，或家长（儿童改/删别人的 → false） */
export function canModify(user: SessionUser, material: MaterialRow): boolean {
  return user.role === "parent" || material.createdBy === user.id;
}

export async function updateMaterial(
  user: SessionUser,
  id: string,
  patch: { title?: unknown; text?: unknown },
): Promise<MaterialSummary | "forbidden" | null> {
  const material = await getMaterial(id);
  if (!material) return null;
  if (!canModify(user, material)) return "forbidden";

  const next: { title?: string; text?: string; sentenceCount?: number; updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.title !== undefined) next.title = normalizeTitle(patch.title);
  if (patch.text !== undefined) {
    const text = normalizeText(patch.text);
    next.text = text;
    next.sentenceCount = countSentences(text);
  }
  const db = getDb();
  await db.update(readingMaterials).set(next).where(eq(readingMaterials.id, id));
  const [row] = await db.select().from(readingMaterials).where(eq(readingMaterials.id, id)).limit(1);
  return toSummary(row);
}

export async function deleteMaterial(
  user: SessionUser,
  id: string,
): Promise<"ok" | "forbidden" | "not_found"> {
  const material = await getMaterial(id);
  if (!material) return "not_found";
  if (!canModify(user, material)) return "forbidden";
  await getDb().delete(readingMaterials).where(eq(readingMaterials.id, id));
  deleteMaterialImage(material.imagePath);
  return "ok";
}
