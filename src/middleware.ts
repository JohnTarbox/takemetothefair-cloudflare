import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const path = request.nextUrl.pathname;

  // Add Cache-Tag headers for entity pages (used by Cloudflare for targeted purging)
  const eventMatch = path.match(/^\/events\/([^/]+)$/);
  if (eventMatch) {
    response.headers.set("Cache-Tag", `event,event:${eventMatch[1]}`);
  }

  const venueMatch = path.match(/^\/venues\/([^/]+)$/);
  if (venueMatch) {
    response.headers.set("Cache-Tag", `venue,venue:${venueMatch[1]}`);
  }

  const vendorMatch = path.match(/^\/vendors\/([^/]+)$/);
  if (vendorMatch) {
    response.headers.set("Cache-Tag", `vendor,vendor:${vendorMatch[1]}`);
  }

  return response;
}

export const config = {
  matcher: ["/events/:path*", "/venues/:path*", "/vendors/:path*"],
};
