/**
 * 独立后台管理员认证（task-110）：**不依赖家庭账号**。
 * env：ADMIN_PASSWORD（未设置 → 后台不可用）；ADMIN_COOKIE_SECRET（可选，签名用）。
 * cookie：`ec_admin` = `<exp>.<hmac>`，HttpOnly / SameSite=Lax / 7 天 / HTTPS 时 Secure。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { HttpError } from "./auth";

export const ADMIN_COOKIE = "ec_admin";
export const ADMIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function adminEnabled(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length > 0);
}

function secret(): string {
  return process.env.ADMIN_COOKIE_SECRET || `ec-admin-v1:${process.env.ADMIN_PASSWORD ?? ""}`;
}

export function signAdminToken(exp: number): string {
  const payload = `v1.${exp}`;
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifyAdminToken(raw: string | null | undefined): boolean {
  if (!adminEnabled() || !raw) return false;
  const [expStr, sig] = raw.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const expected = createHmac("sha256", secret()).update(`v1.${exp}`).digest("base64url");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function verifyAdminPassword(raw: unknown): boolean {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  const given = typeof raw === "string" ? raw : "";
  if (!expected || given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function isAdminRequest(): Promise<boolean> {
  if (!adminEnabled()) return false;
  const store = await cookies();
  return verifyAdminToken(store.get(ADMIN_COOKIE)?.value);
}

/** 页面用：未登录/未启用 → false（调用方 redirect /admin/login）。 */
export async function hasAdminSession(): Promise<boolean> {
  return isAdminRequest();
}

/** API 用：未启用 → 503；未登录 → 401。 */
export async function requireAdmin(): Promise<void> {
  if (!adminEnabled()) throw new HttpError(503, "admin_disabled", "后台未启用（未设置 ADMIN_PASSWORD）");
  if (!(await isAdminRequest())) throw new HttpError(401, "unauthorized", "请先登录管理员后台");
}

export async function setAdminCookie(): Promise<void> {
  const store = await cookies();
  const exp = Date.now() + ADMIN_TTL_MS;
  store.set(ADMIN_COOKIE, signAdminToken(exp), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "1",
    path: "/",
    expires: new Date(exp),
  });
}

export async function clearAdminCookie(): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}
