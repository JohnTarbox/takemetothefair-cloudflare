/**
 * OPE-1512 item 4 — what the public "Vendors wanted" card shows, or null when it
 * shows nothing. John approved the card on 2026-11-10.
 *
 * It renders only for the event's whole-lane `commercial_vendor` row, while that
 * row is positively OPEN and its closing day has not passed. UNKNOWN, WAITLIST,
 * FULL, CLOSED and a past deadline all show nothing new. Lines with no data are
 * omitted, so the card never fills a gap with a guess.
 */
import { formatDateMedium, VENUE_TZ } from "@takemetothefair/datetime";
import { isVendorCallCurrent, parseVendorCategories, safeHref } from "@takemetothefair/utils";

export interface VendorCallSource {
  department: string | null;
  url: string | null;
  closesAt: Date | null;
  capacityStatus: string | null;
  capacityAsOf: Date | null;
  categoriesWanted: string | null;
  categoriesFull: string | null;
  categoriesAsOf: Date | null;
}

export interface VendorCallEventFields {
  applicationUrl: string | null;
  vendorFeeMinCents: number | null;
  vendorFeeMaxCents: number | null;
  vendorFeeNotes: string | null;
}

export interface VendorCallView {
  closesOn: string | null;
  fee: string | null;
  feeNotes: string | null;
  lookingFor: string[];
  full: string[];
  applyHref: string | null;
  asOf: string | null;
}

/** "$75", "$75–$120", or null. Whole dollars print without cents. */
export function formatBoothFee(min: number | null, max: number | null): string | null {
  const money = (cents: number) =>
    `$${Number.isInteger(cents / 100) ? cents / 100 : (cents / 100).toFixed(2)}`;
  if (min == null && max == null) return null;
  if (min == null || max == null || min === max) return money((min ?? max) as number);
  return `${money(min)}–${money(max)}`;
}

/** "Sun, Nov 1, 2026", in the zone the closing day is defined in. */
function formatClosingDay(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: VENUE_TZ,
  }).format(d);
}

export function buildVendorCall(
  row: VendorCallSource | null | undefined,
  event: VendorCallEventFields,
  now: Date
): VendorCallView | null {
  if (!row || row.department !== null || !isVendorCallCurrent(row, now)) return null;
  const asOf = row.categoriesAsOf ?? row.capacityAsOf;
  return {
    closesOn: row.closesAt ? formatClosingDay(row.closesAt) : null,
    fee: formatBoothFee(event.vendorFeeMinCents, event.vendorFeeMaxCents),
    feeNotes: event.vendorFeeNotes?.trim() || null,
    lookingFor: parseVendorCategories(row.categoriesWanted),
    full: parseVendorCategories(row.categoriesFull),
    applyHref: safeHref(row.url ?? event.applicationUrl, { allowMailto: true }) ?? null,
    asOf: asOf ? formatDateMedium(asOf) : null,
  };
}
