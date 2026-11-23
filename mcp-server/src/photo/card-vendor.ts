/**
 * OPE-1705 slice 3 — making and linking a vendor FROM a business card.
 *
 * Two writes, both through the shared vendor-linking tail (no second insert):
 *
 *   - `createVendorFromCard` — the "Add as vendor" box was ticked and no
 *     existing vendor matched. With an event to link (the pinned fair, or
 *     "Met them at…"), `createOrLinkVendor` creates AND links in one call; with
 *     none (a card shot at home), `createVendorRow` creates the bare vendor —
 *     the exact create branch `createOrLinkVendor` runs, extracted for this.
 *   - `linkCardVendorToEvent` — "Met them at…" on a card that matched an
 *     existing vendor: link that vendor (OPE-1704's `vendorId` path, which never
 *     creates and never re-matches) as a CONFIRMED exhibitor.
 *
 * What is deliberately NOT here: the card's other fields. The caller applies
 * them through `applyCardPlan` exactly as for a matched card, so a created
 * vendor gets the same blank-fill (identity) + private staging (contacts) rule
 * — John's ruling (a) — rather than a create that writes contacts directly.
 *
 * The card image is never passed to either write: no hero, no logo, no gallery.
 */
import {
  createOrLinkVendor,
  createVendorRow,
  type VendorLinkDb,
} from "@takemetothefair/vendor-linking";
import { recomputeVendorCompleteness, logEnrichment } from "../helpers.js";
import type { Db } from "../db.js";

export interface CardVendorWrite {
  ok: boolean;
  vendorId: string | null;
  vendorName: string;
  created: boolean;
  /** The event the vendor was linked to, when one was asked for and the link landed. */
  linkedEventId: string | null;
  error?: string;
}

const deps = { actorUserId: null, recomputeVendorCompleteness, logEnrichment };

export async function createVendorFromCard(
  db: Db,
  input: { businessName: string; website: string | null; linkEventId: string | null }
): Promise<CardVendorWrite> {
  const businessName = input.businessName.trim();
  // A card prints a bare host ("fernhollow.com"); store it the way the shared
  // tail stores a sign's domain on create (`https://<domain>`).
  const website =
    input.website && !/^https?:\/\//i.test(input.website)
      ? `https://${input.website}`
      : input.website;
  const fail = (error: string): CardVendorWrite => ({
    ok: false,
    vendorId: null,
    vendorName: businessName,
    created: false,
    linkedEventId: null,
    error: error.slice(0, 200),
  });
  if (!businessName) return fail("the card has no business name");
  try {
    if (input.linkEventId) {
      const r = await createOrLinkVendor(
        db as unknown as VendorLinkDb,
        {
          eventId: input.linkEventId,
          businessName,
          website,
          status: "CONFIRMED",
          participationType: "EXHIBITOR",
          // The caller already matched domain-first then strict name and found
          // nothing; strict here means a vendor created between that read and
          // this write is linked, not duplicated — and a fuzzy near-miss is not
          // silently merged into a card John vouched for by name.
          matchByDomain: true,
          dedupStrategy: "strict",
        },
        deps
      );
      if (!r.ok) return fail(r.error);
      return {
        ok: true,
        vendorId: r.vendorId,
        vendorName: businessName,
        created: r.wasCreated,
        linkedEventId: input.linkEventId,
      };
    }
    const r = await createVendorRow(
      db as unknown as VendorLinkDb,
      {
        businessName,
        vendorType: null,
        sellsCategory: null,
        businessSector: null,
        vendorIdentity: null,
        description: null,
        productsJson: "[]",
        website,
        enrichmentNote: "business card (OPE-1705): Add as vendor, no event",
      },
      deps
    );
    if (!r.ok) return fail(r.error);
    return {
      ok: true,
      vendorId: r.vendorId,
      vendorName: businessName,
      created: true,
      linkedEventId: null,
    };
  } catch (e) {
    return fail(`vendor create failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** "Met them at…" for a card that matched an existing vendor. Never creates. */
export async function linkCardVendorToEvent(
  db: Db,
  input: { vendorId: string; vendorName: string; eventId: string }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await createOrLinkVendor(
      db as unknown as VendorLinkDb,
      {
        eventId: input.eventId,
        vendorId: input.vendorId,
        businessName: input.vendorName,
        status: "CONFIRMED",
        participationType: "EXHIBITOR",
      },
      deps
    );
    return r.ok ? { ok: true } : { ok: false, error: r.error.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
