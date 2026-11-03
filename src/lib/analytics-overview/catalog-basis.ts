/**
 * OPE-1347 #2 — ONE counting basis per catalog noun, used by every admin card.
 *
 * The 2026-10-13 re-audit found three bases for the same nouns, none labelled:
 * Overview counted APPROVED-only events (dropping 296 public TENTATIVE) and
 * vendors including soft-deleted ones; the sitemap tile counted every event row;
 * /admin/coverage counted active venues while Overview counted all. Each was a
 * defensible number for a DIFFERENT question, shown under the same word.
 *
 *   public events  = what a visitor can see (`publicEventWhere`: APPROVED +
 *                    TENTATIVE, lifecycle not cancelled / no-show)
 *   active venues  = `status = 'ACTIVE'`
 *   live vendors   = not soft-deleted
 *
 * Every card that shows these counts renders CATALOG_BASIS_NOTE beneath them.
 */
import { eq, isNull } from "drizzle-orm";
import { vendors, venues } from "@/lib/db/schema";
import { publicEventWhere } from "@/lib/event-lifecycle";

export const publicEventsBasis = () => publicEventWhere();
export const activeVenuesBasis = () => eq(venues.status, "ACTIVE");
export const liveVendorsBasis = () => isNull(vendors.deletedAt);

export const CATALOG_BASIS_NOTE =
  "public events (approved + tentative, not cancelled) · active venues · live vendors (not deleted)";
