import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { resolveGoogleMapsUrl } from "@/lib/google-maps";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "edge";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimitResult = await checkRateLimit(request, "google-url-resolve");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = body.url?.trim();
  if (!url) {
    return NextResponse.json(
      { error: "url field is required" },
      { status: 400 }
    );
  }

  // Validate it looks like a Google Maps URL
  const validDomains = [
    "google.com/maps",
    "maps.google.com",
    "maps.app.goo.gl",
    "goo.gl/maps",
  ];
  if (!validDomains.some((d) => url.includes(d))) {
    return NextResponse.json(
      { error: "URL must be a Google Maps link" },
      { status: 400 }
    );
  }

  const env = getCloudflareEnv();
  const apiKey = (env as { GOOGLE_MAPS_API_KEY?: string }).GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Google Maps API key not configured" },
      { status: 500 }
    );
  }

  const result = await resolveGoogleMapsUrl(url, apiKey);
  if (!result) {
    return NextResponse.json(
      { error: "Could not resolve venue from this URL" },
      { status: 404 }
    );
  }

  return NextResponse.json(result);
}
