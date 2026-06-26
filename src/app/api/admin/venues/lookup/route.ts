export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { lookupPlace } from "@/lib/google-maps";

export const POST = withAuth({ role: "ADMIN" }, async ({ request }) => {
  const body = (await request.json()) as {
    name: string;
    city: string;
    state: string;
  };

  if (!body.name || !body.city || !body.state) {
    return NextResponse.json({ error: "Name, city, and state are required" }, { status: 400 });
  }

  const env = getCloudflareEnv();
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Google Maps API key is not configured." }, { status: 500 });
  }

  const result = await lookupPlace(body.name, body.city, body.state, apiKey);
  if (!result) {
    return NextResponse.json({ error: "No matching place found on Google." }, { status: 404 });
  }

  return NextResponse.json(result);
});
