import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { promoters } from "@/lib/db/schema";

/**
 * OPE-986 — the promoter fields the vendor CTA needs that the shared event
 * projection (`eventJoinProjection`) does NOT carry: `claimed`, and the
 * organizer contact (already public on /promoters/[slug]).
 *
 * ⚠️ Read them from here, never from `event.promoter`. The event page casts the
 * lite projection to the full promoter row type, so `event.promoter.claimed`
 * type-checks and is `undefined` at runtime — every promoter would read as
 * unclaimed and B2 would hide the in-app path everywhere, silently.
 */
export async function getPromoterVendorContact(
  db: Database,
  promoterId: string | null | undefined
): Promise<{ claimed: boolean; contactEmail: string | null; contactPhone: string | null } | null> {
  if (!promoterId) return null;
  const [row] = await db
    .select({
      claimed: promoters.claimed,
      contactEmail: promoters.contactEmail,
      contactPhone: promoters.contactPhone,
    })
    .from(promoters)
    .where(eq(promoters.id, promoterId))
    .limit(1);
  return row ?? null;
}
