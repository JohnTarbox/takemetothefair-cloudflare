/**
 * OPE-1084 — the columns of an `event_days` row that must never leave the
 * server.
 *
 * `internal_notes` (OPE-572) holds hours provenance: source URLs, fetch dates,
 * submitter details. The event page hands day rows to client components, and
 * every prop a client component receives is serialized into the RSC payload —
 * so a full-row select served 309 private notes on 150 public event pages.
 *
 * Nulled rather than omitted so the row keeps its `EventDay` shape for every
 * existing consumer. Add any future private day column here.
 */
export function stripPrivateDayFields<T extends { internalNotes?: string | null }>(
  day: T
): Omit<T, "internalNotes"> & { internalNotes: null } {
  return { ...day, internalNotes: null };
}
