export const dynamic = "force-dynamic";
/**
 * K36 — one-click unsubscribe, PATH form (`/unsubscribe/<b64url-email>/<token>`).
 *
 * Replaces the query form (`/unsubscribe?e=&t=`) for all newly-generated links.
 * Why: the outbound MIME body is quoted-printable encoded, and a literal `=`
 * followed by hex digits (`&t=2c…`) is mis-decoded as a QP escape on delivery —
 * which corrupted the hex token on every send (found live 2026-06-25). Path
 * segments carry no `=`, sidestepping QP entirely. The legacy query route is
 * kept for any link already in the wild.
 */
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { base64UrlDecode, verifyUnsubscribeToken } from "@takemetothefair/utils";
import { handleUnsubscribe, unsubscribePage } from "@/lib/unsubscribe-page";
import { logError } from "@/lib/logger";
import { applyGlobalOptOut } from "@/lib/email/unsubscribe-stores";

interface Params {
  params: Promise<{ e: string; t: string }>;
}

export async function GET(request: Request, { params }: Params) {
  const { e, t } = await params;

  let email = "";
  try {
    email = base64UrlDecode(e);
  } catch {
    return unsubscribePage(
      "Invalid unsubscribe link",
      "This link is malformed. Please use the link from the email exactly as it appears.",
      400
    );
  }

  const env = getCloudflareEnv() as unknown as {
    UNSUBSCRIBE_SECRET?: string;
    INTERNAL_API_KEY?: string;
  };
  const secret = env.UNSUBSCRIBE_SECRET || env.INTERNAL_API_KEY || "";
  const db = getCloudflareDb();

  return handleUnsubscribe({
    email,
    token: t,
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
        await applyGlobalOptOut(db, addr, { source: "unsubscribe-link-path" });
      } catch (err) {
        // The click was valid; a transient write failure must not tell the
        // user they are still subscribed. Send-side checks are the durable
        // gate and clicks are idempotent.
        await logError(db, {
          source: "src/app/unsubscribe/[e]/[t]/route.ts",
          message: "Failed to record unsubscribe opt-out",
          error: err,
          context: { email: addr },
        });
      }
    },
  });
}
