import { NextResponse } from "next/server";
import { COOKIE, sitePassword, tokenFor, safeEqual } from "./lib/auth";

// Everything except the login page, the login/logout API and static assets needs the cookie.
const OPEN = new Set(["/login", "/api/login", "/api/logout"]);

export async function middleware(req) {
  const { pathname, search } = req.nextUrl;
  if (OPEN.has(pathname)) return NextResponse.next();

  const password = sitePassword();
  if (!password) {
    // Local dev without a password: let it through. Anywhere else: fail closed.
    if (process.env.NODE_ENV === "development") return NextResponse.next();
    return new NextResponse("Site password is not configured (set SITE_PASSWORD).", { status: 503 });
  }

  const cookie = req.cookies.get(COOKIE)?.value;
  if (cookie && safeEqual(cookie, await tokenFor(password))) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in. Reload the page and enter the password." }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
