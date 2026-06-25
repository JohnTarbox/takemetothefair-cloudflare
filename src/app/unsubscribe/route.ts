export const dynamic = "force-dynamic";
/**
 * K36 (2026-06-25) — one-click unsubscribe (CAN-SPAM).
 *
 * The unsubscribe link in every outbound vendor/promoter/venue + K41 free-form
 * footer points here with `?e=<email>&t=<hmac>`. The token is HMAC-SHA256 of
 * the lowercased email keyed by the shared secret (UNSUBSCRIBE_SECRET, else
 * INTERNAL_API_KEY — the same value the MCP Worker used to render the link). On
 * a valid token we add the address to `email_suppression_list` (idempotent) so
 * future solicited sends skip it, and render a plain confirmation page.
 *
 * GET (one-click): clicking the link suppresses immediately — no extra confirm
 * step, per the CAN-SPAM 2008 one-click expectation.
 */
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { emailSuppressionList } from "@/lib/db/schema";
import { verifyUnsubscribeToken } from "@takemetothefair/utils";
import { logError } from "@/lib/logger";

function page(title: string, message: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem;color:#1f2937;line-height:1.6}h1{font-size:1.4rem}a{color:#b45309}</style></head><body><h1>${title}</h1><p>${message}</p><p><a href="https://meetmeatthefair.com">Return to Meet Me at the Fair</a></p></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const email = (url.searchParams.get("e") ?? "").trim().toLowerCase();
  const token = url.searchParams.get("t") ?? "";

  if (!email || !token) {
    return page(
      "Invalid unsubscribe link",
      "This link is missing information. Please use the link from the email exactly as it appears.",
      400
    );
  }

  const env = getCloudflareEnv() as unknown as {
    UNSUBSCRIBE_SECRET?: string;
    INTERNAL_API_KEY?: string;
  };
  const secret = env.UNSUBSCRIBE_SECRET || env.INTERNAL_API_KEY || "";

  const valid = await verifyUnsubscribeToken(secret, email, token);
  if (!valid) {
    return page(
      "Invalid unsubscribe link",
      "We couldn't verify this unsubscribe link. It may be malformed — please use the link from the email exactly as it appears.",
      400
    );
  }

  const db = getCloudflareDb();
  try {
    await db
      .insert(emailSuppressionList)
      .values({ email, reason: "unsubscribe", source: "unsubscribe-link", createdAt: new Date() })
      .onConflictDoNothing({ target: emailSuppressionList.email });
  } catch (e) {
    await logError(db, {
      source: "app/unsubscribe",
      message: "Failed to record unsubscribe suppression",
      error: e,
      context: { email },
    });
    // Still show success — the click was valid; a transient write failure
    // shouldn't tell the user they're still subscribed. The send-side check is
    // the durable gate and re-clicks are idempotent.
  }

  return page(
    "You've been unsubscribed",
    "You won't receive further outreach emails from Meet Me at the Fair at this address. If this was a mistake, just reply to any prior email and we'll help.",
    200
  );
}
