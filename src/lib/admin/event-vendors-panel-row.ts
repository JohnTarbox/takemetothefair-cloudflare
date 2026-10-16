/**
 * OPE-1397 (EXP2) — the exact shape `EventVendorsPanel` (a client component)
 * renders. Props to a client component are serialized into the RSC payload,
 * so the admin dashboard used to ship full `events` rows — `suggester_email`,
 * submitter/user ids and the rest — to the browser. Project to an allow-list:
 * a new events column can never leak here by default.
 */
export interface EventVendorsPanelRow {
  id: string;
  name: string;
  slug: string;
  startDate: Date | null;
  endDate: Date | null;
  venue: { city: string | null; state: string | null } | null;
  vendorCount: number;
}

export function toEventVendorsPanelRow(
  event: {
    id: string;
    name: string;
    slug: string;
    startDate: Date | null;
    endDate: Date | null;
  },
  venue: { city: string | null; state: string | null } | null,
  vendorCount: number
): EventVendorsPanelRow {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: venue ? { city: venue.city, state: venue.state } : null,
    vendorCount,
  };
}
