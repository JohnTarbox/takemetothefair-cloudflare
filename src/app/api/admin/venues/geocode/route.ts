export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { geocodeAddress } from "@/lib/google-maps";

export const POST = withAuth({ role: "ADMIN" }, async ({ request }) => {
  const body = (await request.json()) as {
    address: string;
    city: string;
    state: string;
    zip?: string;
  };

  if (!body.address || !body.city || !body.state) {
    return NextResponse.json({ error: "Address, city, and state are required" }, { status: 400 });
  }

  const env = getCloudflareEnv();
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Google Maps API key is not configured." }, { status: 500 });
  }
  const result = await geocodeAddress(body.address, body.city, body.state, body.zip, apiKey);
  if (!result) {
    return NextResponse.json(
      { error: "Could not geocode this address. Check the address and try again." },
      { status: 404 }
    );
  }

  return NextResponse.json(result);
});
