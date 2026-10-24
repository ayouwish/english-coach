import { NextResponse } from "next/server";
import { HttpError } from "./auth";
import { VoiceError } from "./voice";

/** 统一错误格式，对齐契约 §8：{ error: { code, message, detail } } */
export function jsonError(
  status: number,
  code: string,
  message: string,
  detail?: unknown,
): NextResponse {
  return NextResponse.json({ error: { code, message, detail: detail ?? {} } }, { status });
}

export function jsonOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data as unknown as Record<string, unknown>, { status });
}

export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return jsonError(err.status, err.code, err.message, err.detail);
  }
  if (err instanceof VoiceError) {
    const status = err.code === "provider_timeout" ? 504 : err.status ?? 502;
    return jsonError(status, err.code, err.message, err.detail);
  }
  const message = err instanceof Error ? err.message : String(err);
  return jsonError(500, "internal_error", message);
}

/** 包一层 try/catch，避免每个 route 重复写样板。 */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (!(err instanceof HttpError)) {
        console.error("[api]", err);
      }
      return toErrorResponse(err);
    }
  };
}

export function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function parseJsonObject<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
