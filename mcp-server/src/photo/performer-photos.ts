/**
 * OPE-969 — a photo of an ACT, checked against the event's roster FIRST.
 *
 * The specimen that makes the order matter (Waterford, 2026-07-21): a photo of
 * the Axe Women Loggers of Maine truck was linked to the event by hand, and the
 * hand-made link DUPLICATED an appearance — Axe Women were already HEADLINER ×3
 * on that event from the official schedule. So:
 *
 *   named act → performer row (name or alias) → appearances on THIS event?
 *     yes → "confirmed": the photo belongs to a known appearance. Nothing is
 *           created; the pipeline puts the photo in the event gallery.
 *     no  → staged for review. Never an auto-link.
 *
 * ── The roster check does not trust the model's KIND ──────────────────────
 * Measured on the Waterford photos themselves (2026-09-13): the Axe Women truck
 * came back `kind:"booth"`, name "AxeWomen", confidence 1 — on a prompt that
 * lists "an act's own truck" as a performer. So the pipeline runs
 * `matchRosterPerformer` on EVERY named photo, booth or performer, before any
 * booth disposition. It is looser than the global match (compacted names, one
 * may prefix the other) and that is safe only because the candidates are this
 * one event's lineup — the same asymmetry OPE-378's clustering rests on.
 *
 * This module READS only. Every write is the pipeline's, after its dry-run
 * boundary, so a replay can report a performer outcome without touching data.
 *
 * ── Faces ─────────────────────────────────────────────────────────────────
 * Youth squads, school groups and 4-H acts are common performers at these
 * fairs; the first performer photo in the corpus is a cheer squad of ~25 girls.
 * A confirmed photo is NOT attached when a child may be identifiable (`true`
 * or unanswered) — it stages with that reason instead. No path here sets a hero.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { normalizeString } from "@takemetothefair/utils";
import { containsCI, eventPerformers, performers } from "../schema.js";
import type { Db } from "../db.js";
import type { BoothIdentification, StageKind } from "./vision.js";

export type PerformerPhotoResolution =
  | {
      outcome: "confirmed";
      performerId: string;
      performerName: string;
      appearancesOnEvent: number;
    }
  | {
      outcome: "stage";
      stageKind: Extract<
        StageKind,
        "performer_unmatched" | "performer_not_on_roster" | "performer_identifiable_minor"
      >;
      reason: string;
      performerId: string | null;
      performerName: string | null;
      appearancesOnEvent: number;
    };

/** Letters and digits only: "AxeWomen" and "Axe Women" are the same key. */
function compact(s: string): string {
  return normalizeString(s).replace(/ /g, "");
}

/** Shorter side of a roster prefix match must be at least this long. */
export const ROSTER_PREFIX_MIN = 6;

/**
 * A printed name → a performer ALREADY on this event's lineup, or null.
 *
 * Equal compacted names, or one a prefix of the other with the shorter at least
 * ROSTER_PREFIX_MIN characters ("axewomen" ⊂ "axewomenloggersofmaine"). Alias
 * rows pointing at a rostered performer count under their own name. More than
 * one distinct rostered performer matching is ambiguity: null.
 */
export async function matchRosterPerformer(
  db: Db,
  eventId: string,
  printedName: string
): Promise<{ id: string; name: string; appearancesOnEvent: number } | null> {
  const key = compact(printedName);
  if (key.length < ROSTER_PREFIX_MIN) return null;

  const roster = await db
    .select({ id: performers.id, name: performers.name, n: sql<number>`count(*)` })
    .from(eventPerformers)
    .innerJoin(performers, eq(performers.id, eventPerformers.performerId))
    .where(eq(eventPerformers.eventId, eventId))
    .groupBy(performers.id, performers.name);
  if (roster.length === 0) return null;

  const aliases = await db
    .select({ name: performers.name, canonical: performers.aliasOfPerformerId })
    .from(performers)
    .where(sql`${performers.aliasOfPerformerId} IN ${roster.map((r) => r.id)}`);

  const names = [
    ...roster.map((r) => ({ id: r.id, name: r.name })),
    ...aliases.filter((a) => a.canonical).map((a) => ({ id: a.canonical!, name: a.name })),
  ];
  const hits = new Set<string>();
  for (const { id, name } of names) {
    const c = compact(name);
    const [short, long] = c.length <= key.length ? [c, key] : [key, c];
    if (c === key || (short.length >= ROSTER_PREFIX_MIN && long.startsWith(short))) hits.add(id);
  }
  if (hits.size !== 1) return null;
  const [id] = [...hits];
  const row = roster.find((r) => r.id === id)!;
  return { id: row.id, name: row.name, appearancesOnEvent: Number(row.n) };
}

/** First token long enough to narrow the candidate read. */
function narrowingToken(name: string): string | null {
  return (
    normalizeString(name)
      .split(" ")
      .filter((t) => t.length >= 3)
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/**
 * Resolve a printed act name to ONE canonical performer, or null.
 *
 * Exact on the normalized name (case, punctuation, whitespace), including alias
 * rows — `set_performer_alias` soft-deletes the alias and points it at the
 * canonical row, and a photo of a banner can carry either name. Two distinct
 * canonical matches is ambiguity, not a match: null.
 */
export async function matchPerformerByName(
  db: Db,
  printedName: string
): Promise<{ id: string; name: string } | null> {
  const key = normalizeString(printedName);
  const token = narrowingToken(printedName);
  if (!key || !token) return null;

  const rows = await db
    .select({
      id: performers.id,
      name: performers.name,
      aliasOf: performers.aliasOfPerformerId,
      redirectTo: performers.redirectToPerformerId,
      deletedAt: performers.deletedAt,
    })
    .from(performers)
    .where(containsCI(performers.name, token))
    .limit(200);

  const canonical = new Set<string>();
  for (const r of rows) {
    if (normalizeString(r.name) !== key) continue;
    const target = r.aliasOf ?? r.redirectTo ?? (r.deletedAt ? null : r.id);
    if (target) canonical.add(target);
  }
  if (canonical.size !== 1) return null;

  const [id] = [...canonical];
  const [row] = await db
    .select({ id: performers.id, name: performers.name })
    .from(performers)
    .where(and(eq(performers.id, id), isNull(performers.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function resolvePerformerPhoto(
  db: Db,
  eventId: string,
  id: BoothIdentification
): Promise<PerformerPhotoResolution> {
  const printed = id.performerName ?? id.businessName ?? "";
  // Roster FIRST — the whole point of the path (see module doc).
  const onRoster = printed ? await matchRosterPerformer(db, eventId, printed) : null;
  if (onRoster) {
    if (id.identifiableMinor !== false) {
      return {
        outcome: "stage",
        stageKind: "performer_identifiable_minor",
        reason:
          id.identifiableMinor === true
            ? `${onRoster.name} is on the lineup, but an identifiable child appears — not attached`
            : `${onRoster.name} is on the lineup, but the child check was not answered — not attached`,
        performerId: onRoster.id,
        performerName: onRoster.name,
        appearancesOnEvent: onRoster.appearancesOnEvent,
      };
    }
    return {
      outcome: "confirmed",
      performerId: onRoster.id,
      performerName: onRoster.name,
      appearancesOnEvent: onRoster.appearancesOnEvent,
    };
  }

  const match = printed ? await matchPerformerByName(db, printed) : null;
  if (!match) {
    return {
      outcome: "stage",
      stageKind: "performer_unmatched",
      reason: `no performer on file is named "${printed}"`,
      performerId: null,
      performerName: null,
      appearancesOnEvent: 0,
    };
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(eventPerformers)
    .where(and(eq(eventPerformers.eventId, eventId), eq(eventPerformers.performerId, match.id)));
  const appearancesOnEvent = Number(n);

  if (appearancesOnEvent === 0) {
    return {
      outcome: "stage",
      stageKind: "performer_not_on_roster",
      reason: `${match.name} is not on this event's lineup — propose a link, never auto-link`,
      performerId: match.id,
      performerName: match.name,
      appearancesOnEvent,
    };
  }
  if (id.identifiableMinor !== false) {
    return {
      outcome: "stage",
      stageKind: "performer_identifiable_minor",
      reason:
        id.identifiableMinor === true
          ? `${match.name} is on the lineup, but an identifiable child appears — not attached`
          : `${match.name} is on the lineup, but the child check was not answered — not attached`,
      performerId: match.id,
      performerName: match.name,
      appearancesOnEvent,
    };
  }
  return {
    outcome: "confirmed",
    performerId: match.id,
    performerName: match.name,
    appearancesOnEvent,
  };
}
