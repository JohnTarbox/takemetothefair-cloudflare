import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(_request: NextRequest) {
  const response = NextResponse.next();

  // Security headers
  response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files and internal Next.js paths
    "/((?!_next/static|_next/image|favicon.ico|og-default|manifest).*)",
  ],
};
