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
import { emailSuppressionList } from "@/lib/db/schema";
import { verifyUnsubscribeToken } from "@takemetothefair/utils";
import { handleUnsubscribe } from "@/lib/unsubscribe-page";
import { logError } from "@/lib/logger";

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
        await logError(db, {
          source: "app/unsubscribe",
          message: "Failed to record unsubscribe suppression",
          error: err,
          context: { email: addr },
        });
      }
    },
  });
}
