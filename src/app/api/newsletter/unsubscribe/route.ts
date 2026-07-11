export const dynamic = "force-dynamic";
/**
 * OPE-169 — one-click newsletter unsubscribe. The unsubscribe link in every
 * broadcast points here as a GET (works from any mail client, no login). Flips
 * newsletter_subscribers.unsubscribed=1 for the signed email, then 303-redirects
 * to /newsletter/unsubscribed with a status the page renders.
 *
 * Token semantics: src/lib/email/newsletter-unsubscribe-token.ts (stateless
 * HMAC over the email — no per-row column). Idempotent: re-clicking, or an
 * address not on the list, both resolve to a benign "done" state (we never
 * reveal whether an address was subscribed).
 */
import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { newsletterSubscribers } from "@/lib/db/schema";
import {
  verifyUnsubscribeToken,
  resolveUnsubscribeSecret,
} from "@/lib/email/newsletter-unsubscribe-token";
import { getSiteUrl } from "@/lib/email/send";
import { logError } from "@/lib/logger";
import { eq } from "drizzle-orm";

function redirectTo(status: string) {
  return NextResponse.redirect(`${getSiteUrl()}/newsletter/unsubscribed?status=${status}`, {
    status: 303,
  });
}

export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!token) return redirectTo("missing_token");

  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
  const secret = resolveUnsubscribeSecret(env);
  const db = getCloudflareDb();

  if (!secret) {
    await logError(db, {
      message: "Newsletter unsubscribe: no signing secret configured",
      source: "api/newsletter/unsubscribe",
    });
    return redirectTo("server_error");
  }

  try {
    const email = await verifyUnsubscribeToken(token, secret);
    if (!email) return redirectTo("invalid");
    // Idempotent — affects 0 rows if the address isn't on the list; still "ok"
    // so we never reveal subscription status.
    await db
      .update(newsletterSubscribers)
      .set({ unsubscribed: true })
      .where(eq(newsletterSubscribers.email, email));
    return redirectTo("ok");
  } catch (e) {
    await logError(db, {
      message: "Newsletter unsubscribe endpoint threw",
      error: e,
      source: "api/newsletter/unsubscribe",
    });
    return redirectTo("server_error");
  }
}
