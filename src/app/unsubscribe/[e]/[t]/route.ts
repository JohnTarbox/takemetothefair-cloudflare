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
import { emailSuppressionList } from "@/lib/db/schema";
import { base64UrlDecode, verifyUnsubscribeToken } from "@takemetothefair/utils";
import { handleUnsubscribe, unsubscribePage } from "@/lib/unsubscribe-page";
import { logError } from "@/lib/logger";

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
    suppress: async (addr) => {
      try {
        await db
          .insert(emailSuppressionList)
          .values({
            email: addr,
            reason: "unsubscribe",
            source: "unsubscribe-link",
            createdAt: new Date(),
          })
          .onConflictDoNothing({ target: emailSuppressionList.email });
      } catch (err) {
        // Click was valid; a transient write failure shouldn't tell the user
        // they're still subscribed. Send-side check is the durable gate; clicks
        // are idempotent.
        await logError(db, {
          source: "app/unsubscribe/[e]/[t]",
          message: "Failed to record unsubscribe suppression",
          error: err,
          context: { email: addr },
        });
      }
    },
  });
}
