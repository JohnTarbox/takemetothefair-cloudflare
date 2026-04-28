import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { trackServerEvent } from "@/lib/server-analytics";

const MAX_BODY_BYTES = 4_000;
const MAX_PROPERTY_BYTES = 2_000;

// Allowlist of event names accepted from the client beacon.
// Anything outside this set is rejected with 400, preventing free-form spam.
// Add new names here when wiring new instrumentation.
const ALLOWED_EVENT_NAMES = [
  "outbound_application_click",
  "outbound_ticket_click",
  "filter_applied",
  "internal_search_performed",
] as const;

const trackSchema = z.object({
  name: z.enum(ALLOWED_EVENT_NAMES),
  category: z.enum(["funnel", "engagement", "conversion"]),
  properties: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const rateLimitResult = await checkRateLimit(request, "analytics-track");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = trackSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Cap properties size to bound storage cost.
  const propertiesJson = parsed.data.properties
    ? JSON.stringify(parsed.data.properties)
    : undefined;
  if (propertiesJson && propertiesJson.length > MAX_PROPERTY_BYTES) {
    return NextResponse.json({ error: "Properties too large" }, { status: 400 });
  }

  const session = await auth();
  const userId = session?.user?.id;

  const db = getCloudflareDb();
  await trackServerEvent(db, {
    eventName: parsed.data.name,
    eventCategory: parsed.data.category,
    properties: parsed.data.properties,
    userId,
    source: "client_beacon",
  });

  return new NextResponse(null, { status: 204 });
}
