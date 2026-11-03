import { type NextRequest, NextResponse } from "next/server";

const OAUTH_SIGN_IN_PROVIDERS = new Set(["google", "microsoft-entra-id"]);

export function middleware(request: NextRequest): NextResponse {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return NextResponse.next();
  }

  const [, , , action, provider] = request.nextUrl.pathname.split("/");

  if (action !== "signin" || provider === undefined || !OAUTH_SIGN_IN_PROVIDERS.has(provider)) {
    return NextResponse.next();
  }

  const nextUrl = request.nextUrl.clone();
  nextUrl.pathname = `/api/auth/start/${provider}`;

  return NextResponse.redirect(nextUrl);
}

export const config = {
  matcher: "/api/auth/signin/:path*",
};
