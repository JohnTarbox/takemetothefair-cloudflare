import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { newsletterSubscribers } from "@/lib/db/schema";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { logError } from "@/lib/logger";

export const runtime = "edge";

const schema = z.object({
  email: z.string().email(),
  source: z.string().max(40).optional(),
});

export async function POST(request: NextRequest) {
  const rl = await checkRateLimit(request, "newsletter-subscribe");
  if (!rl.allowed) return rateLimitResponse(rl);

  const db = getCloudflareDb();
  // Enumeration-safe: always return success-shaped responses so the form
  // doesn't leak whether an email is already in the list.
  const GENERIC_OK = NextResponse.json({ ok: true });

  try {
    const body = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) return GENERIC_OK;

    const email = parsed.data.email.toLowerCase().trim();
    const source = parsed.data.source?.slice(0, 40) ?? "footer";

    const existing = await db.query.newsletterSubscribers.findFirst({
      where: eq(newsletterSubscribers.email, email),
    });

    if (existing) {
      if (existing.unsubscribed) {
        await db
          .update(newsletterSubscribers)
          .set({ unsubscribed: false })
          .where(eq(newsletterSubscribers.email, email));
      }
      return GENERIC_OK;
    }

    await db.insert(newsletterSubscribers).values({
      email,
      source,
    });

    return GENERIC_OK;
  } catch (error) {
    await logError(db, {
      message: "Newsletter signup error",
      error,
      source: "api/newsletter/subscribe",
      request,
    });
    return GENERIC_OK;
  }
}
