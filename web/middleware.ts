import { NextResponse, type NextRequest } from "next/server";

/** 仅用于把 pathname 传给服务端 layout（决定 /admin 用独立布局，不套家庭导航）。 */
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
