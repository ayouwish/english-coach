/** task-115：后台「一键缓存所有音色」的估算与启动（预热不计入家庭成本台账）。 */
import { ne } from "drizzle-orm";
import { getDb } from "@/db";
import { sentences } from "@/db/schema";
import { HttpError } from "@/lib/auth";
import { VOICE_OPTIONS } from "@/lib/voices";
import { cancelBulkWarmup, getBulkWarmupStatus, startBulkWarmup, VoiceError, type BulkWarmupStatus } from "@/lib/voice";

export const WARMUP_RATES = ["normal", "slow"] as const;
export type WarmupRate = (typeof WARMUP_RATES)[number];
export const WARMUP_PRICE_DEFAULT = 0.12;

export function warmupPricePer1K(): number {
  const raw = process.env.COST_TTS_WARMUP_CNY_PER_1K_CHARS;
  const n = raw === undefined || raw === "" ? WARMUP_PRICE_DEFAULT : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : WARMUP_PRICE_DEFAULT;
}

async function corpusTexts(): Promise<string[]> {
  const rows = await getDb()
    .select({ text: sentences.text })
    .from(sentences)
    .where(ne(sentences.source, "flow-custom"))
    .orderBy(sentences.sortOrder);
  return rows.map((r) => r.text).filter((t) => typeof t === "string" && t.trim().length > 0);
}

/** 成本估算（items = 句数 × 音色数 × 语速数；chars = Σlen × 音色 × 语速） */
export function estimateWarmup(texts: string[], voiceCount: number, rateCount: number) {
  const chars = texts.reduce((acc, t) => acc + t.length, 0);
  const items = texts.length * voiceCount * rateCount;
  const totalChars = chars * voiceCount * rateCount;
  const price = warmupPricePer1K();
  return {
    items,
    chars: totalChars,
    cost_cny: Math.round((totalChars / 1000) * price * 100) / 100,
    price_per_1k_chars: price,
  };
}

export interface WarmupMeta {
  sentences: { count: number; chars: number };
  voices: { id: string; label_zh: string; lang: string }[];
  rates: WarmupRate[];
  estimate: ReturnType<typeof estimateWarmup>;
  prices: { tts_warmup_per_1k_chars: number };
  status: BulkWarmupStatus | null;
  status_error: string | null;
}

export async function buildWarmupMeta(): Promise<WarmupMeta> {
  const texts = await corpusTexts();
  const voices = VOICE_OPTIONS.map((v) => ({ id: v.id, label_zh: v.label_zh, lang: v.lang }));
  const chars = texts.reduce((acc, t) => acc + t.length, 0);
  let status: BulkWarmupStatus | null = null;
  let status_error: string | null = null;
  try {
    status = await getBulkWarmupStatus();
  } catch (err) {
    status_error = err instanceof VoiceError ? `voice 不可达：${err.message}` : `读取预热状态失败：${(err as Error).message}`;
  }
  return {
    sentences: { count: texts.length, chars },
    voices,
    rates: [...WARMUP_RATES],
    estimate: estimateWarmup(texts, voices.length, WARMUP_RATES.length),
    prices: { tts_warmup_per_1k_chars: warmupPricePer1K() },
    status,
    status_error,
  };
}

export interface WarmupStartBody {
  voices?: unknown;
  rates?: unknown;
  texts?: unknown;
}

export async function startWarmup(body: WarmupStartBody) {
  const allTexts = await corpusTexts();
  let texts = allTexts;
  if (body.texts !== undefined) {
    if (!Array.isArray(body.texts)) throw new HttpError(400, "bad_request", "texts 必须是字符串数组");
    const given = body.texts.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.slice(0, 2000));
    if (given.length === 0) throw new HttpError(400, "bad_request", "texts 不能为空");
    if (given.length > 1000) throw new HttpError(400, "bad_request", "texts 最多 1000 条");
    if (body.texts.length <= 50 && given.length > 50) throw new HttpError(400, "bad_request", "小样本 texts 最多 50 条");
    texts = given;
  }
  const known = new Set(VOICE_OPTIONS.map((v) => v.id));
  let voices = VOICE_OPTIONS.map((v) => v.id);
  if (body.voices !== undefined) {
    if (!Array.isArray(body.voices)) throw new HttpError(400, "bad_request", "voices 必须是数组");
    voices = body.voices.filter((x): x is string => typeof x === "string" && known.has(x));
    if (voices.length === 0) throw new HttpError(400, "bad_request", "voices 至少要选一个已知音色");
    if (voices.length > 12) throw new HttpError(400, "bad_request", "voices 最多 12 个");
  }
  let rates: WarmupRate[] = [...WARMUP_RATES];
  if (body.rates !== undefined) {
    if (!Array.isArray(body.rates)) throw new HttpError(400, "bad_request", "rates 必须是数组");
    rates = body.rates.filter((x): x is WarmupRate => x === "normal" || x === "slow");
    if (rates.length === 0) throw new HttpError(400, "bad_request", "rates 至少选一个（normal/slow）");
    rates = [...new Set(rates)];
  }
  try {
    const started = await startBulkWarmup({ texts, voices, rates });
    return { started, estimate: estimateWarmup(texts, voices.length, rates.length) };
  } catch (err) {
    if (err instanceof VoiceError) {
      if (err.status === 409) {
        throw new HttpError(409, "warmup_running", "已有预热任务在运行，请等它完成或先取消", err.detail);
      }
      if (err.code === "voice_unreachable" || err.status === 503 || err.status === 504) {
        throw new HttpError(503, "voice_unreachable", "voice 服务不可达，暂时无法预热");
      }
      throw new HttpError(err.status === 400 ? 400 : 502, err.code, `启动预热失败：${err.message}`);
    }
    throw err;
  }
}

export async function cancelWarmup() {
  try {
    return await cancelBulkWarmup();
  } catch (err) {
    if (err instanceof VoiceError) {
      if (err.code === "voice_unreachable" || err.status === 503 || err.status === 504) {
        throw new HttpError(503, "voice_unreachable", "voice 服务不可达，暂时无法取消");
      }
      throw new HttpError(502, err.code, `取消预热失败：${err.message}`);
    }
    throw err;
  }
}
