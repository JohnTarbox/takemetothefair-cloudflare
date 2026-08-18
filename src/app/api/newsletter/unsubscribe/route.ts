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

/**
 * The actual unsubscribe. Shared by GET (a human clicking the footer link) and
 * POST (RFC 8058 one-click, fired by the mail client with no human present),
 * so the two can never drift into disagreeing about what unsubscribing means.
 *
 * Returns the status string; each caller shapes its own response, because the
 * two protocols want very different ones — see POST below.
 */
async function performUnsubscribe(token: string): Promise<string> {
  if (!token) return "missing_token";

  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
  const secret = resolveUnsubscribeSecret(env);
  const db = getCloudflareDb();

  if (!secret) {
    await logError(db, {
      message: "Newsletter unsubscribe: no signing secret configured",
      source: "api/newsletter/unsubscribe",
    });
    return "server_error";
  }

  try {
    const email = await verifyUnsubscribeToken(token, secret);
    if (!email) return "invalid";
    // Idempotent — affects 0 rows if the address isn't on the list; still "ok"
    // so we never reveal subscription status.
    await db
      .update(newsletterSubscribers)
      // OPE-389 — one of TWO unsubscribe writers; the other is the inbound-email
      // handler (mcp-server/src/email-handlers/unsubscribe.ts). Both stamp the
      // time, or the column would be silently right only half the time.
      // OPE-466 — and both stamp the EVIDENCE, for the same reason. This path
      // needs no phrase matching: arriving here means a signed link was
      // followed, which is the least ambiguous request there is.
      .set({
        unsubscribed: true,
        unsubscribedAt: new Date(),
        unsubscribeEvidence: "signed-unsubscribe-link",
      })
      .where(eq(newsletterSubscribers.email, email));
    return "ok";
  } catch (e) {
    await logError(db, {
      message: "Newsletter unsubscribe endpoint threw",
      error: e,
      source: "api/newsletter/unsubscribe",
    });
    return "server_error";
  }
}

export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return redirectTo(await performUnsubscribe(token));
}

/**
 * OPE-385 — RFC 8058 one-click unsubscribe.
 *
 * Gmail and Yahoo POST here directly when the user hits the "Unsubscribe"
 * affordance the mail client renders from our `List-Unsubscribe` header. The
 * body is `List-Unsubscribe=One-Click`.
 *
 * This route was GET-only until now. Advertising `List-Unsubscribe-Post`
 * against a GET-only handler would have made every one-click attempt 405 —
 * strictly worse than shipping no header, because the mail provider records
 * the failure against our sending reputation and the user's unsubscribe simply
 * does not happen.
 *
 * Three deliberate differences from GET:
 *
 *  - NO REDIRECT. There is no browser to follow a 303; RFC 8058 wants a plain
 *    2xx. The status is returned as a short body for log-readability only.
 *  - NO CONFIRMATION STEP, by design and by spec. "One-click" means the POST
 *    itself is the confirmation.
 *  - 200 EVEN ON A BAD TOKEN. A 4xx would make a mail provider retry or flag
 *    the endpoint as broken, and an expired/garbled token is not something the
 *    recipient can fix. The one case that DOES return 500 is `server_error`,
 *    because a missing signing secret is ours to fix and should be retried.
 */
export async function POST(request: NextRequest) {
  // Token travels in the query string — the URL we put in the header carries
  // it, and RFC 8058 reserves the POST BODY for `List-Unsubscribe=One-Click`.
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const status = await performUnsubscribe(token);

  return new NextResponse(status, {
    status: status === "server_error" ? 500 : 200,
    headers: { "Content-Type": "text/plain" },
  });
}
