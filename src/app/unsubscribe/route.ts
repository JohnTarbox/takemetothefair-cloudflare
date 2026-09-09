export const dynamic = "force-dynamic";
/**
 * K36 — one-click unsubscribe, LEGACY query form (`/unsubscribe?e=&t=`).
 *
 * Superseded by the path form (`/unsubscribe/<b64url-email>/<token>`) for all
 * newly-generated links — see src/app/unsubscribe/[e]/[t]/route.ts for why
 * (quoted-printable corrupts `&t=<hex>`). Kept so any query-form link already
 * delivered still resolves. Shares the verify+suppress core.
 */
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { verifyUnsubscribeToken } from "@takemetothefair/utils";
import { handleUnsubscribe } from "@/lib/unsubscribe-page";
import { logError } from "@/lib/logger";
import { applyGlobalOptOut } from "@/lib/email/unsubscribe-stores";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const email = url.searchParams.get("e") ?? "";
  const token = url.searchParams.get("t") ?? "";

  const env = getCloudflareEnv() as unknown as {
    UNSUBSCRIBE_SECRET?: string;
    INTERNAL_API_KEY?: string;
  };
  const secret = env.UNSUBSCRIBE_SECRET || env.INTERNAL_API_KEY || "";
  const db = getCloudflareDb();

  return handleUnsubscribe({
    email,
    token,
    secret,
    verify: verifyUnsubscribeToken,
    // OPE-869 — one writer for a GLOBAL opt-out, across BOTH stores.
    //
    // This path used to insert an `email_suppression_list` row and nothing
    // else, while Path A set `newsletter_subscribers.unsubscribed` and closed
    // the list rows and never touched suppression. Two disjoint answers to
    // "did this person unsubscribe?", and which one honoured a click depended
    // only on which mail the person happened to receive.
    //
    // This link's scope is EVERYTHING and stays everything — that is what it
    // promised when it was sent, and OPE-864's migration rule applies here too.
    suppress: async (addr) => {
      try {
        await applyGlobalOptOut(db, addr, { source: "unsubscribe-link-query" });
      } catch (err) {
        // The click was valid; a transient write failure must not tell the
        // user they are still subscribed. Send-side checks are the durable
        // gate and clicks are idempotent.
        await logError(db, {
          source: "src/app/unsubscribe/route.ts",
          message: "Failed to record unsubscribe opt-out",
          error: err,
          context: { email: addr },
        });
      }
    },
  });
}
