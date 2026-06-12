// SYN1 Phase 2 — per-subscriber auth for the SYN2 reconcile endpoint.
//
// Lets a registered consumer authenticate with their OWN credential
// (`Authorization: Bearer <signing_secret>`) instead of MMATF's internal
// cross-Worker key — keeping the MMATF ↔ consumer business-separation boundary
// intact. The same secret already signs the push webhooks, so the consumer
// holds exactly one credential.
import { getCloudflareDb } from "@/lib/cloudflare";
import { syndicationSubscribers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { timingSafeEqualString } from "@takemetothefair/utils";

/**
 * Resolve a `Authorization: Bearer <token>` header to an ACTIVE subscriber by
 * constant-time-comparing the token against each active subscriber's
 * signing_secret. Returns the subscriber id, or null when the header is
 * missing/malformed or no secret matches.
 *
 * The loop compares against EVERY active subscriber (no early return) so a
 * mismatch can't leak — via timing — which subscriber a token nearly matched.
 * Subscriber count is tiny (one per partner site), so the full scan is cheap.
 */
export async function resolveSyndicationSubscriber(
  request: Request
): Promise<{ id: string } | null> {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;

  const db = getCloudflareDb();
  const subs = await db
    .select({
      id: syndicationSubscribers.id,
      signingSecret: syndicationSubscribers.signingSecret,
    })
    .from(syndicationSubscribers)
    .where(eq(syndicationSubscribers.active, true));

  let matchedId: string | null = null;
  for (const s of subs) {
    if (await timingSafeEqualString(token, s.signingSecret)) matchedId = s.id;
  }
  return matchedId ? { id: matchedId } : null;
}
