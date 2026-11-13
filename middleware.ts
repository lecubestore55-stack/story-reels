import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, safeEqual, sessionToken } from "./lib/auth";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login" || pathname === "/api/health") return NextResponse.next();

  const cookie = req.cookies.get(SESSION_COOKIE)?.value || "";
  if (process.env.ADMIN_PASSWORD && safeEqual(cookie, await sessionToken())) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
