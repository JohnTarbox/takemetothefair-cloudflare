/**
 * OPE-1481 (a) — the MCP write side of `events.parking_notes` /
 * `events.accessibility_notes`: what the ORGANIZER publishes about parking and
 * accessibility at this event, shown as the organizer line in the event page's
 * "Visiting" box (OPE-1479).
 *
 * Same rule as `pet_friendly` (OPE-1061), approved by John 2026-10-17: no
 * citation, no value. Evidence travels with the value in the SAME call — a
 * separate "now cite it" step is the one an agent forgets — and it must quote
 * the organizer VERBATIM. A value with nothing behind it tells a wheelchair
 * user there is an accessible entrance on the strength of nobody's word.
 *
 * Clearing a note (null) needs no evidence and retires the active citation.
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { citationSupersedeScope } from "@takemetothefair/db-schema";
import { eventDataCitations } from "../schema.js";
import { decodeHtmlEntities } from "../helpers.js";
import type { Db } from "../db.js";

export const VISITOR_NOTE_FIELDS = ["parking_notes", "accessibility_notes"] as const;
export type VisitorNoteField = (typeof VISITOR_NOTE_FIELDS)[number];

/** Public visitor copy, so short: one or two sentences. */
export const VISITOR_NOTE_MAX = 300;

const noteParam = (what: string) =>
  z
    .string()
    .min(1)
    .max(VISITOR_NOTE_MAX)
    .transform(decodeHtmlEntities)
    .nullable()
    .optional()
    .describe(
      `OPE-1481: what the ORGANIZER publishes about ${what} at THIS event — public visitor copy, ≤${VISITOR_NOTE_MAX} chars, shown in the event page's Visiting box as the organizer's. Requires ${what === "parking" ? "parking_notes_evidence" : "accessibility_notes_evidence"} with a verbatim excerpt. null clears it. NEVER from the venue's Google data, the event type/category, a sibling fair or last year.`
    );

export const PARKING_NOTES_PARAM = noteParam("parking");
export const ACCESSIBILITY_NOTES_PARAM = noteParam("accessibility");

export const VISITOR_NOTE_EVIDENCE_PARAM = z
  .object({
    source_url: z.string().url().describe("The organizer/venue page that says it."),
    source_type: z.enum([
      "official_website",
      "news_article",
      "press_release",
      "social_media",
      "user_submitted",
      "other",
    ]),
    source_name: z.string().max(200).transform(decodeHtmlEntities).optional(),
    excerpt: z
      .string()
      .min(1)
      .max(1000)
      .transform(decodeHtmlEntities)
      .describe("The organizer's own words, VERBATIM — not a summary."),
  })
  .optional()
  .describe("OPE-1481: evidence for the note, written as a citation in the same call.");

type Evidence = NonNullable<z.infer<typeof VISITOR_NOTE_EVIDENCE_PARAM>>;

/**
 * Why a write must be refused, or null when it may proceed. Called BEFORE any
 * row is touched, so a refusal leaves nothing half-written. Evidence with no
 * value is refused too: silently dropping it would read as "recorded".
 */
export function visitorNoteParamError(
  field: VisitorNoteField,
  value: string | null | undefined,
  evidence: Evidence | undefined
): string | null {
  if (value === undefined) {
    return evidence
      ? `${field}_evidence was given without ${field} — say which note it supports.`
      : null;
  }
  if (value === null) return null;
  if (!evidence?.source_url || !evidence.excerpt?.trim()) {
    return `${field} needs ${field}_evidence with the source_url and a verbatim excerpt of the organizer's own words. A visitor note with nothing behind it is published as the organizer's statement.`;
  }
  return null;
}

/**
 * Record the evidence for one note, retiring the prior active citation for that
 * field. Returns the new citation id, or null for a clear (null), which writes
 * no evidence but still retires the old row so nothing cites a removed value.
 */
export async function writeEventVisitorNoteCitation(
  db: Db,
  args: {
    eventId: string;
    field: VisitorNoteField;
    value: string | null;
    evidence: Evidence | undefined;
    userId: string | null;
  }
): Promise<string | null> {
  // Retire by SCOPE in one UPDATE — no id list, so no D1 bound-parameter cap
  // to trip (OPE-241). The newest retired row is read first only to link it.
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
      .set({ state: "superseded", updatedAt: new Date() })
      .where(scope);
  }
  if (args.value === null || !args.evidence) return null;
  const ev = args.evidence;
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(eventDataCitations).values({
    id,
    eventId: args.eventId,
    fieldName: args.field,
    value: args.value,
    year: null,
    sourceUrl: ev.source_url,
    sourceName: ev.source_name ?? null,
    sourceType: ev.source_type,
    confidence: null,
    state: "active",
    notes: `Verbatim: "${ev.excerpt}"`,
    sourceExcerpt: ev.excerpt,
    sourceFetchedAt: now,
    supersedesCitationId: prior?.id ?? null,
    createdBy: args.userId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
