import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { autocompletePlace } from "@/lib/google-maps";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimitResult = await checkRateLimit(request, "google-autocomplete");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const env = getCloudflareEnv();
  const apiKey = (env as { GOOGLE_MAPS_API_KEY?: string }).GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Google Maps API key not configured" }, { status: 500 });
  }

  const suggestions = await autocompletePlace(q, apiKey);
  return NextResponse.json({ suggestions });
}
