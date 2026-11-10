/**
 * OPE-1613 — field-level provenance and pins for feed-tracked event fields.
 *
 * Provenance lives on `event_data_citations`: the ACTIVE citation for
 * (event, field) says where the current value came from, and its
 * `provenance_kind` says which authority rung it sits on. A pin
 * (`event_field_pins`) is a validated contact's answer holding a field above
 * the feed, with the feed's then-wrong value kept beside it so a later read
 * can tell the three cases apart (John's table, 2026-11-10):
 *
 *   feed shows the same wrong value  → keep the contact's value; don't ask again
 *   feed shows the contact's value   → release the pin (feed fixed)
 *   feed shows a third value         → keep the pin; open a NEW discrepancy
 *
 * The feed never writes a pinned field. In this slice the feed writes NO
 * tracked field at all: every disagreement is asked of the contact (the
 * ruling's "batch them; don't auto-correct"). Only a validated contact's answer
 * writes, and only to the date/time fields — venue and status answers are
 * pinned and cited but applied by an operator, because a venue is an FK
 * choice and a cancellation is a lifecycle transition with its own path.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  eventDataCitations,
  eventDays,
  eventFieldPins,
  events,
  venues,
  type CitationProvenanceKind,
} from "../schema.js";
import { citationSupersedeScope } from "@takemetothefair/db-schema";
import { createSlug, normalizeEventDate } from "@takemetothefair/utils";
import type { Db } from "../db.js";
import type { FeedEvent } from "./tec.js";

export const FEED_FIELDS = [
  "start_date",
  "end_date",
  "start_time",
  "end_time",
  "venue",
  "status",
] as const;
export type FeedField = (typeof FEED_FIELDS)[number];

/** The discrepancy `field_class` each tracked field files under. */
export const FIELD_CLASS: Record<FeedField, "date" | "hours" | "venue" | "status"> = {
  start_date: "date",
  end_date: "date",
  start_time: "hours",
  end_time: "hours",
  venue: "venue",
  status: "status",
};

/** Fields a validated contact's answer writes straight to the event. */
export const DIRECTLY_APPLIED: ReadonlySet<FeedField> = new Set([
  "start_date",
  "end_date",
  "start_time",
  "end_time",
]);

export type FieldValues = Record<FeedField, string | null>;

const ymd = (d: Date | null | undefined): string | null =>
  d instanceof Date && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;

/** Venue text compared loosely: lowercased, punctuation and spaces collapsed. */
export function normalizeVenueText(v: string | null): string | null {
  if (!v) return null;
  // createSlug (not an inline regex — #120): "&" → "and", accents folded.
  const s = createSlug(v).replace(/-/g, " ").trim();
  return s || null;
}

export function feedVenueText(ev: FeedEvent): string | null {
  const v = ev.venue;
  if (!v) return null;
  const parts = [v.name, v.city, v.state].filter((x): x is string => !!x);
  return parts.length ? parts.join(", ") : null;
}

export function feedFieldValues(ev: FeedEvent): FieldValues {
  return {
    start_date: ev.startDate,
    end_date: ev.endDate ?? ev.startDate,
    start_time: ev.startTime,
    end_time: ev.endTime,
    venue: feedVenueText(ev),
    status: ev.statusCancelled ? "cancelled" : "scheduled",
  };
}

/** Values compare equal under the field's own normalization. */
export function sameValue(field: FeedField, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (field === "venue") return normalizeVenueText(a) === normalizeVenueText(b);
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function readEventFieldValues(db: Db, eventId: string): Promise<FieldValues | null> {
  const [ev] = await db
    .select({
      startDate: events.startDate,
      endDate: events.endDate,
      lifecycleStatus: events.lifecycleStatus,
      venueName: venues.name,
      venueCity: venues.city,
      venueState: venues.state,
    })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(eq(events.id, eventId))
    .limit(1);
  if (!ev) return null;
  const startDate = ymd(ev.startDate);
  const endDate = ymd(ev.endDate) ?? startDate;
  const days = await db
    .select({ date: eventDays.date, open: eventDays.openTime, close: eventDays.closeTime })
    .from(eventDays)
    .where(eq(eventDays.eventId, eventId));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const venueParts = [ev.venueName, ev.venueCity, ev.venueState].filter((x): x is string => !!x);
  return {
    start_date: startDate,
    end_date: endDate,
    start_time: (startDate && byDate.get(startDate)?.open) || null,
    end_time: (endDate && byDate.get(endDate)?.close) || null,
    venue: venueParts.length ? venueParts.join(", ") : null,
    status: ev.lifecycleStatus === "CANCELLED" ? "cancelled" : "scheduled",
  };
}

/** Normalize a contact's free-text answer into the field's stored form. */
export function normalizeAnswer(field: FeedField, raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (field === "start_time" || field === "end_time") {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i.exec(s);
    if (m) {
      let h = Number(m[1]) % 12;
      if (m[3].toLowerCase() === "p") h += 12;
      return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
    }
    const h24 = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
    return h24 ? `${h24[1].padStart(2, "0")}:${h24[2]}` : null;
  }
  if (field === "start_date" || field === "end_date") {
    const d = normalizeEventDate(s);
    return ymd(d);
  }
  if (field === "status") {
    if (/cancel/i.test(s)) return "cancelled";
    if (/(on|scheduled|happening|going ahead|still)/i.test(s)) return "scheduled";
    return null;
  }
  return s;
}

export type PinVerdict = "same_wrong" | "fixed" | "third_value" | "no_feed_value";

export function evaluatePin(
  field: FeedField,
  pin: { pinnedValue: string; feedValueAtPin: string | null },
  feedValue: string | null
): PinVerdict {
  if (feedValue === null) return "no_feed_value";
  if (sameValue(field, feedValue, pin.pinnedValue)) return "fixed";
  if (sameValue(field, feedValue, pin.feedValueAtPin)) return "same_wrong";
  return "third_value";
}

export async function getActivePin(db: Db, eventId: string, field: string) {
  const [pin] = await db
    .select()
    .from(eventFieldPins)
    .where(
      and(
        eq(eventFieldPins.eventId, eventId),
        eq(eventFieldPins.fieldName, field),
        eq(eventFieldPins.status, "active")
      )
    )
    .limit(1);
  return pin ?? null;
}

export async function releasePin(
  db: Db,
  pinId: string,
  reason: "feed_fixed" | "operator" | "superseded",
  now: Date
): Promise<void> {
  await db
    .update(eventFieldPins)
    .set({ status: "released", releasedAt: now, releaseReason: reason, updatedAt: now })
    .where(and(eq(eventFieldPins.id, pinId), eq(eventFieldPins.status, "active")));
}

/** Insert an active citation, superseding the prior active one for (event, field). */
export async function writeProvenanceCitation(
  db: Db,
  args: {
    eventId: string;
    field: string;
    value: string;
    sourceUrl: string;
    sourceName: string;
    sourceType: "official_website" | "user_submitted" | "other";
    provenanceKind: CitationProvenanceKind;
    notes: string;
    now: Date;
  }
): Promise<string> {
  const scope = and(
    citationSupersedeScope(args.eventId, args.field, null),
    eq(eventDataCitations.state, "active")
  );
  const [prior] = await db
    .select({ id: eventDataCitations.id })
    .from(eventDataCitations)
    .where(scope)
    .orderBy(desc(eventDataCitations.createdAt))
    .limit(1);
  if (prior) {
    await db
      .update(eventDataCitations)
      .set({ state: "superseded", updatedAt: args.now })
      .where(scope);
  }
  const id = crypto.randomUUID();
  await db.insert(eventDataCitations).values({
    id,
    eventId: args.eventId,
    fieldName: args.field,
    value: args.value,
    year: null,
    sourceUrl: args.sourceUrl,
    sourceName: args.sourceName,
    sourceType: args.sourceType,
    provenanceKind: args.provenanceKind,
    confidence: null,
    state: "active",
    notes: args.notes,
    supersedesCitationId: prior?.id ?? null,
    createdBy: null,
    createdAt: args.now,
    updatedAt: args.now,
  });
  return id;
}

/**
 * Write a validated contact's value to the event. Date/time fields only;
 * returns `applied: false` with the reason otherwise. Every write is a
 * compare-free targeted UPDATE whose RETURNING proves it landed.
 */
export async function applyFieldValue(
  db: Db,
  eventId: string,
  field: FeedField,
  value: string
): Promise<{ applied: boolean; reason: string }> {
  if (!DIRECTLY_APPLIED.has(field)) {
    return { applied: false, reason: `${field} is applied by an operator, not automatically` };
  }
  if (field === "start_date" || field === "end_date") {
    const d = normalizeEventDate(value);
    if (!d) return { applied: false, reason: `"${value}" is not a date` };
    const rows = await db
      .update(events)
      .set(field === "start_date" ? { startDate: d } : { endDate: d })
      .where(eq(events.id, eventId))
      .returning({ id: events.id });
    return rows.length
      ? { applied: true, reason: "events row updated" }
      : { applied: false, reason: "event not found" };
  }
  const current = await readEventFieldValues(db, eventId);
  const date = field === "start_time" ? current?.start_date : current?.end_date;
  if (!date) return { applied: false, reason: "event has no date to attach a time to" };
  // AUDIT-EXEMPT: the only caller, recordContactAnswer (contact-answer.ts), writes
  // admin_actions `feed.answer_pinned` for this same change, plus a
  // validated_contact citation and the pin — the write is accounted for there.
  const rows = await db
    .update(eventDays)
    .set(field === "start_time" ? { openTime: value } : { closeTime: value })
    .where(and(eq(eventDays.eventId, eventId), eq(eventDays.date, date)))
    .returning({ id: eventDays.id });
  return rows.length
    ? { applied: true, reason: `event_days ${date} updated` }
    : { applied: false, reason: `no event_days row for ${date}; an operator adds it` };
}

export interface FieldProvenance {
  field: string;
  current_value: string | null;
  /** The active citation's rung; `unclassified` = a pre-0406 citation; `none` = uncited. */
  provenance: CitationProvenanceKind | "unclassified" | "none";
  citation: {
    id: string;
    value: string;
    source_type: string;
    source_url: string;
    source_name: string | null;
    created_at: string | null;
  } | null;
  pin: {
    id: string;
    pinned_value: string;
    feed_value_at_pin: string | null;
    contact_id: string | null;
    inbound_email_id: string | null;
    created_at: string | null;
  } | null;
}

/** Every tracked field plus any other cited field, with its provenance and pin. */
export async function getEventFieldProvenance(
  db: Db,
  eventId: string
): Promise<FieldProvenance[] | null> {
  const values = await readEventFieldValues(db, eventId);
  if (!values) return null;
  const cites = await db
    .select()
    .from(eventDataCitations)
    .where(and(eq(eventDataCitations.eventId, eventId), eq(eventDataCitations.state, "active")))
    .orderBy(desc(eventDataCitations.createdAt));
  const pins = await db
    .select()
    .from(eventFieldPins)
    .where(and(eq(eventFieldPins.eventId, eventId), eq(eventFieldPins.status, "active")));
  const citeBy = new Map<string, (typeof cites)[number]>();
  for (const c of cites) if (!citeBy.has(c.fieldName)) citeBy.set(c.fieldName, c);
  const pinBy = new Map(pins.map((p) => [p.fieldName, p]));
  const names = [
    ...FEED_FIELDS,
    ...[...citeBy.keys()].filter((k) => !FEED_FIELDS.includes(k as FeedField)),
  ];
  const iso = (d: Date | null | undefined) => (d instanceof Date ? d.toISOString() : null);
  return names.map((field) => {
    const c = citeBy.get(field);
    const p = pinBy.get(field);
    return {
      field,
      current_value: (values as Record<string, string | null>)[field] ?? c?.value ?? null,
      provenance: c ? (c.provenanceKind ?? "unclassified") : "none",
      citation: c
        ? {
            id: c.id,
            value: c.value,
            source_type: c.sourceType,
            source_url: c.sourceUrl,
            source_name: c.sourceName,
            created_at: iso(c.createdAt),
          }
        : null,
      pin: p
        ? {
            id: p.id,
            pinned_value: p.pinnedValue,
            feed_value_at_pin: p.feedValueAtPin,
            contact_id: p.contactId,
            inbound_email_id: p.inboundEmailId,
            created_at: iso(p.createdAt),
          }
        : null,
    };
  });
}
