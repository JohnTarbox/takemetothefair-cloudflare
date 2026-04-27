import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { getPlaceById } from "@/lib/google-maps";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimitResult = await checkRateLimit(request, "google-place-details");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const { searchParams } = new URL(request.url);
  const placeId = searchParams.get("placeId")?.trim();
  if (!placeId) {
    return NextResponse.json({ error: "placeId parameter is required" }, { status: 400 });
  }

  const env = getCloudflareEnv();
  const apiKey = (env as { GOOGLE_MAPS_API_KEY?: string }).GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Google Maps API key not configured" }, { status: 500 });
  }

  const result = await getPlaceById(placeId, apiKey);
  if (!result) {
    return NextResponse.json({ error: "Place not found" }, { status: 404 });
  }

  return NextResponse.json(result);
}
