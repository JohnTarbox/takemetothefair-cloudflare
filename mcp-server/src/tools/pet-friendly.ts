/**
 * OPE-1061 — the MCP write side of the four-state `pet_friendly` field.
 *
 * Shared by `update_event` and `update_venue` so the two writers cannot
 * disagree about what a YES needs. The rules themselves (and why each exists)
 * live in `@takemetothefair/utils` pet-policy.ts; this file only turns them
 * into a zod shape and a citation row.
 *
 * Evidence travels with the value in the SAME call. A separate "now cite it"
 * step is the one an agent forgets, and a YES with nothing behind it is the
 * `dates_confirmed DEFAULT true` mistake in a field that fails by stranding a
 * person at a gate (OPE-433).
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import {
  PET_FRIENDLY_VALUES,
  petFriendlyCitationNotes,
  type PetFriendly,
  type PetFriendlyEvidence,
} from "@takemetothefair/utils";
import { citationSupersedeScope } from "@takemetothefair/db-schema";
import { entityDataCitations, eventDataCitations } from "../schema.js";
import { decodeHtmlEntities } from "../helpers.js";
import type { Db } from "../db.js";

export const PET_FRIENDLY_PARAM = z
  .enum(PET_FRIENDLY_VALUES)
  .optional()
  .describe(
    "OPE-1061: UNSET (nobody has looked) | YES (organizer publishes pets allowed) | NO (organizer publishes no pets — renders as 'Service animals only') | NOT_PUBLISHED (you looked, they publish nothing). YES/NO/NOT_PUBLISHED require pet_friendly_evidence. NEVER derive it from event type, category, indoor/outdoor, the venue, a sibling fair or last year — only from this row's own source."
  );

export const PET_FRIENDLY_EVIDENCE_PARAM = z
  .object({
    source_url: z
      .string()
      .url()
      .describe("The page that says it (or, for NOT_PUBLISHED, the page you checked)."),
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
      .max(1000)
      .transform(decodeHtmlEntities)
      .optional()
      .describe(
        'YES/NO: the organizer\'s own words, VERBATIM — e.g. "With the exception of service animals, pets are not allowed".'
      ),
    checked: z
      .string()
      .max(1000)
      .transform(decodeHtmlEntities)
      .optional()
      .describe(
        "NOT_PUBLISHED: what you looked at and found silent (pages, FAQ, rules), so the next pass can skip it."
      ),
  })
  .optional()
  .describe("OPE-1061: evidence for pet_friendly, written as a citation in the same call.");

type Evidence = NonNullable<z.infer<typeof PET_FRIENDLY_EVIDENCE_PARAM>>;

function asEvidence(e: Evidence): PetFriendlyEvidence {
  return {
    source_url: e.source_url,
    source_type: e.source_type,
    source_name: e.source_name ?? null,
    excerpt: e.excerpt ?? null,
    checked: e.checked ?? null,
  };
}

/**
 * Record the evidence for an EVENT's pet_friendly value, retiring the prior
 * active pet_friendly citation. Returns the new citation id, or null for UNSET
 * (a reset needs no evidence and writes none).
 */
export async function writeEventPetCitation(
  db: Db,
  args: {
    eventId: string;
    value: PetFriendly;
    evidence: Evidence | undefined;
    userId: string | null;
  }
): Promise<string | null> {
  if (args.value === "UNSET" || !args.evidence) return null;
  const ev = asEvidence(args.evidence);
  const prior = await db
    .select({ id: eventDataCitations.id })
    .from(eventDataCitations)
    .where(
      and(
        citationSupersedeScope(args.eventId, "pet_friendly", null),
        eq(eventDataCitations.state, "active")
      )
    );
  if (prior.length > 0) {
    await db
      .update(eventDataCitations)
      .set({ state: "superseded", updatedAt: new Date() })
      .where(
        inArray(
          eventDataCitations.id,
          prior.map((r) => r.id)
        )
      );
  }
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(eventDataCitations).values({
    id,
    eventId: args.eventId,
    fieldName: "pet_friendly",
    value: args.value,
    year: null,
    sourceUrl: ev.source_url,
    sourceName: ev.source_name ?? null,
    sourceType: ev.source_type,
    confidence: null,
    state: "active",
    notes: petFriendlyCitationNotes(args.value, ev),
    // The verbatim words get their own column on this table (OPE-692), and
    // `source_fetched_at` is stamped only when words were actually captured —
    // a timestamp with no excerpt would assert a read nothing evidences.
    sourceExcerpt: args.value === "NOT_PUBLISHED" ? null : (ev.excerpt ?? null),
    sourceFetchedAt: args.value !== "NOT_PUBLISHED" && ev.excerpt ? now : null,
    supersedesCitationId: prior[0]?.id ?? null,
    createdBy: args.userId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** The venue twin. `entity_data_citations` has no excerpt column, so the
 *  verbatim words travel in `notes` (petFriendlyCitationNotes puts them there
 *  for both tables, so the two records read the same). */
export async function writeVenuePetCitation(
  db: Db,
  args: {
    venueId: string;
    value: PetFriendly;
    evidence: Evidence | undefined;
    userId: string | null;
  }
): Promise<string | null> {
  if (args.value === "UNSET" || !args.evidence) return null;
  const ev = asEvidence(args.evidence);
  await db
    .update(entityDataCitations)
    .set({ state: "superseded" })
    .where(
      and(
        eq(entityDataCitations.entityType, "VENUE"),
        eq(entityDataCitations.entityId, args.venueId),
        eq(entityDataCitations.fieldName, "pet_friendly"),
        eq(entityDataCitations.state, "active")
      )
    );
  const id = crypto.randomUUID();
  await db.insert(entityDataCitations).values({
    id,
    entityType: "VENUE",
    entityId: args.venueId,
    fieldName: "pet_friendly",
    value: args.value,
    sourceUrl: ev.source_url,
    sourceName: ev.source_name ?? null,
    sourceType: ev.source_type,
    confidence: null,
    state: "active",
    notes: petFriendlyCitationNotes(args.value, ev),
    createdBy: args.userId,
    createdAt: new Date(),
  });
  return id;
}
