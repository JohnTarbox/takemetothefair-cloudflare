/**
 * OPE-764 — work out who just wrote to us, using data we already hold.
 *
 * ── The finding this exists for ────────────────────────────────────────────
 * Five high-value correspondents were measured on 2026-09-02. **All five were
 * already entities in our own database at the moment they wrote, and not one
 * was recognised** — Jeremy Hall (CT DEEP), Paradise City Arts, David Lerner,
 * aéhkō, TIMEPROOFUSA. Every one got a generic acknowledgement, and two got
 * the same template twice. The join that identifies them costs 216ms and
 * nothing in the pipeline ran it.
 *
 * ── Three keys, because one is not enough ──────────────────────────────────
 * The ticket names the counter-example itself: Freedom Boat Club is a listed
 * vendor and `freedomboatclub.us` does NOT match its stored website, so a
 * domain join alone misses it. Conversely a domain join is the only key that
 * survives a sender restyling their signature. So:
 *
 *   (a) `contact-email` — exact, lowercased, on vendors / promoters / users.
 *   (b) `website-domain` — the sender's domain against stored websites and
 *       `events.source_url`.
 *   (c) `brand-name`   — signature/domain-derived name against entity names,
 *       via the OPE-604 `brandKey` machinery that already bridges
 *       "Time Proof USA" ↔ `TIMEPROOFUSA`.
 *
 * ── Every match is kept ────────────────────────────────────────────────────
 * `ct.gov` legitimately matches 2 vendors, 4 promoters and 4 events. Picking
 * one would be a fabrication dressed as an answer; the operator needs to see
 * that the domain is a *state government*, which is exactly what "ten matches
 * across three types" tells them and what "matched: Vendor X" hides.
 *
 * ── This module RESOLVES. It does not answer, and it does not act ──────────
 * No prose, no routing, no send decision, no trust change. OPE-764 scope 5 is
 * explicit, and the reason is in the neighbouring tickets: 90.7% of live
 * events claim confirmed dates with no citation, so an auto-responder quoting
 * a matched record would sound authoritative while being wrong — strictly
 * worse than the dumb acknowledgement it replaced.
 */
import { and, isNull, sql } from "drizzle-orm";
import { events, promoters, users, vendors } from "@takemetothefair/db-schema";
import type { Db } from "../db.js";
import { brandKey, senderNameVariants } from "./vendor-inquiry-briefing.js";

export type SenderMatchBasis = "contact-email" | "website-domain" | "brand-name";
export type SenderEntityType = "vendor" | "promoter" | "user" | "event";

export interface SenderMatch {
  entityType: SenderEntityType;
  entityId: string;
  /** Human label, so an operator does not have to look the id up. */
  name: string;
  slug: string | null;
  basis: SenderMatchBasis;
  /** The string that produced the hit — the operator's means of disagreeing. */
  matchedOn: string;
  confidence: number;
}

export interface SenderIdentity {
  matches: SenderMatch[];
  /** Highest-confidence match, or null. Convenience only — `matches` is the answer. */
  best: SenderMatch | null;
  /** Distinct entity types present, for a one-glance read. */
  matchedTypes: SenderEntityType[];
}

/**
 * Confidence is ORDINAL, not probabilistic, and the numbers are chosen so the
 * ordering is the meaning: an address we hold on the entity record outranks a
 * shared domain, which outranks a name that merely normalises the same.
 *
 * Deliberately NOT tuned to look like probabilities. `0.55` on a brand-name
 * hit would invite someone to treat it as "55% likely", and it is not that —
 * it is "third-best kind of evidence". A number that implies a calibration
 * nobody performed is how a stored record starts getting quoted at customers.
 */
const CONFIDENCE: Record<SenderMatchBasis, number> = {
  "contact-email": 1,
  "website-domain": 0.7,
  "brand-name": 0.4,
};

/** Bare registrable-ish domain: lowercased, `www.`/`mail.`/`smtp.` stripped. */
export function senderDomain(fromAddress: string): string | null {
  const at = (fromAddress ?? "").indexOf("@");
  if (at < 0) return null;
  const d = fromAddress
    .slice(at + 1)
    .toLowerCase()
    .trim()
    .replace(/^(www|mail|smtp)\./, "");
  return d.includes(".") ? d : null;
}

/**
 * Is `domain` present in a stored URL, as a HOST rather than as a substring?
 *
 * ⚠️ Two things this must not be, both of which I wrote first and had to
 * correct:
 *
 * 1. **Not a bare `%domain%` LIKE.** `%ct.gov%` also matches
 *    `connect.government-example.com`, and a false "this correspondent is the
 *    State of Connecticut" is a worse answer than no answer at all. The host
 *    boundaries are part of the match: the domain must follow `//` or `.` and
 *    be followed by `/` or the end of the string, which also rejects the
 *    `https://ct.gov.evil.example` shape.
 *
 * 2. **Not `LIKE` at all.** D1 caps LIKE patterns at 50 characters and throws
 *    over it (OPE-565/OPE-630 — 293 production errors from exactly this), and
 *    every pattern here would be built from the SENDER'S OWN DOMAIN. A
 *    253-character domain is a legal domain, so a LIKE version of this
 *    function is a remotely-triggerable ingest failure. `instr()` has no such
 *    ceiling, which is why `containsCI` in the shared package uses it.
 */
function urlHasDomain(col: unknown, domain: string) {
  const slashHost = `//${domain}`;
  const dotHost = `.${domain}`;
  return sql`(
    instr(lower(${col}), ${slashHost + "/"}) > 0
    OR instr(lower(${col}), ${dotHost + "/"}) > 0
    OR substr(lower(${col}), -${slashHost.length}) = ${slashHost}
    OR substr(lower(${col}), -${dotHost.length}) = ${dotHost}
  )`;
}

const MAX_MATCHES_PER_KEY = 25;

export async function resolveSenderIdentity(
  db: Db,
  args: { fromAddress: string; bodyText?: string | null; signatureName?: string | null }
): Promise<SenderIdentity> {
  const from = (args.fromAddress ?? "").toLowerCase().trim();
  const matches: SenderMatch[] = [];
  const seen = new Set<string>();

  const add = (m: SenderMatch) => {
    // Same entity found by two keys keeps the STRONGER one. Reporting an
    // entity twice would make "10 matches" mean two different things
    // depending on how many keys happened to fire.
    const k = `${m.entityType}:${m.entityId}`;
    const prior = matches.findIndex((x) => `${x.entityType}:${x.entityId}` === k);
    if (prior >= 0) {
      if (m.confidence > matches[prior].confidence) matches[prior] = m;
      return;
    }
    if (seen.has(k)) return;
    seen.add(k);
    matches.push(m);
  };

  if (!from.includes("@")) return { matches: [], best: null, matchedTypes: [] };

  // ── (a) contact-email ────────────────────────────────────────────────────
  // Compared lowercased on BOTH sides. `users.email` uniqueness is
  // case-sensitive in this schema, so `Jeremy.Hall@ct.gov` and
  // `jeremy.hall@ct.gov` can both exist; a case-sensitive compare here would
  // miss the row that is actually there.
  const [vendorEmail, promoterEmail, userEmail] = await Promise.all([
    db
      .select({ id: vendors.id, name: vendors.businessName, slug: vendors.slug })
      .from(vendors)
      .where(and(isNull(vendors.deletedAt), sql`lower(${vendors.contactEmail}) = ${from}`))
      .limit(MAX_MATCHES_PER_KEY),
    db
      .select({ id: promoters.id, name: promoters.companyName, slug: promoters.slug })
      .from(promoters)
      .where(sql`lower(${promoters.contactEmail}) = ${from}`)
      .limit(MAX_MATCHES_PER_KEY),
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(sql`lower(${users.email}) = ${from}`)
      .limit(MAX_MATCHES_PER_KEY),
  ]);

  for (const r of vendorEmail)
    add({
      entityType: "vendor",
      entityId: r.id,
      name: r.name,
      slug: r.slug,
      basis: "contact-email",
      matchedOn: from,
      confidence: CONFIDENCE["contact-email"],
    });
  for (const r of promoterEmail)
    add({
      entityType: "promoter",
      entityId: r.id,
      name: r.name,
      slug: r.slug,
      basis: "contact-email",
      matchedOn: from,
      confidence: CONFIDENCE["contact-email"],
    });
  for (const r of userEmail)
    add({
      entityType: "user",
      entityId: r.id,
      name: r.name ?? r.email ?? "(unnamed user)",
      slug: null,
      basis: "contact-email",
      matchedOn: from,
      confidence: CONFIDENCE["contact-email"],
    });

  // ── (b) website-domain ───────────────────────────────────────────────────
  const domain = senderDomain(from);
  if (domain) {
    const [vw, pw, ev] = await Promise.all([
      db
        .select({ id: vendors.id, name: vendors.businessName, slug: vendors.slug })
        .from(vendors)
        .where(and(isNull(vendors.deletedAt), urlHasDomain(vendors.website, domain)))
        .limit(MAX_MATCHES_PER_KEY),
      db
        .select({ id: promoters.id, name: promoters.companyName, slug: promoters.slug })
        .from(promoters)
        .where(urlHasDomain(promoters.website, domain))
        .limit(MAX_MATCHES_PER_KEY),
      db
        .select({ id: events.id, name: events.name, slug: events.slug })
        .from(events)
        .where(and(isNull(events.mergedInto), urlHasDomain(events.sourceUrl, domain)))
        .limit(MAX_MATCHES_PER_KEY),
    ]);
    for (const r of vw)
      add({
        entityType: "vendor",
        entityId: r.id,
        name: r.name,
        slug: r.slug,
        basis: "website-domain",
        matchedOn: domain,
        confidence: CONFIDENCE["website-domain"],
      });
    for (const r of pw)
      add({
        entityType: "promoter",
        entityId: r.id,
        name: r.name,
        slug: r.slug,
        basis: "website-domain",
        matchedOn: domain,
        confidence: CONFIDENCE["website-domain"],
      });
    for (const r of ev)
      add({
        entityType: "event",
        entityId: r.id,
        name: r.name,
        slug: r.slug,
        basis: "website-domain",
        matchedOn: domain,
        confidence: CONFIDENCE["website-domain"],
      });
  }

  // ── (c) brand-name ───────────────────────────────────────────────────────
  // The Freedom Boat Club case: `freedomboatclub.us` is not the stored
  // website, so (b) misses, but the domain label normalises to the same brand
  // key as the vendor's name. Reuses OPE-604's `brandKey`, which strips to
  // alphanumerics on BOTH sides — that is what bridges "Time Proof USA" and
  // `TIMEPROOFUSA`, and it folds diacritics' punctuation out of `aéhkō` too.
  const variants = senderNameVariants(from, args.signatureName ?? signatureNameFrom(args.bodyText));
  for (const variant of variants) {
    const key = brandKey(variant);
    // Three characters is the floor OPE-604 already uses. Below it, a
    // "fragment match" is a coincidence with a confidence score attached.
    if (key.length < 4) continue;

    const [vn, pn] = await Promise.all([
      db
        .select({ id: vendors.id, name: vendors.businessName, slug: vendors.slug })
        .from(vendors)
        .where(and(isNull(vendors.deletedAt), brandKeyEquals(vendors.businessName, key)))
        .limit(MAX_MATCHES_PER_KEY),
      db
        .select({ id: promoters.id, name: promoters.companyName, slug: promoters.slug })
        .from(promoters)
        .where(brandKeyEquals(promoters.companyName, key))
        .limit(MAX_MATCHES_PER_KEY),
    ]);
    for (const r of vn)
      add({
        entityType: "vendor",
        entityId: r.id,
        name: r.name,
        slug: r.slug,
        basis: "brand-name",
        matchedOn: variant,
        confidence: CONFIDENCE["brand-name"],
      });
    for (const r of pn)
      add({
        entityType: "promoter",
        entityId: r.id,
        name: r.name,
        slug: r.slug,
        basis: "brand-name",
        matchedOn: variant,
        confidence: CONFIDENCE["brand-name"],
      });
  }

  matches.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  return {
    matches,
    best: matches[0] ?? null,
    matchedTypes: [...new Set(matches.map((m) => m.entityType))],
  };
}

/**
 * Brand-key equality in SQL.
 *
 * SQLite has no regex, so the alphanumeric strip is nested `replace()` calls
 * over the characters that actually occur in these names. Pulling 6,566 vendor
 * rows into JS to compare them would be worse on an ingest path — OPE-604
 * measured the same shape at 30ms against prod.
 *
 * ⚠️ This is a strip, not a transliteration: `aéhkō` keeps its accented
 * letters, so it matches an `aéhkō` row and NOT an `aehko` one. That is
 * OPE-647's separate problem (vendor search is diacritic-blind) and widening
 * it here would silently change what "matched" means on a path OPE-647 is
 * still deciding.
 */
function brandKeyEquals(col: unknown, key: string) {
  const stripped = sql`lower(replace(replace(replace(replace(replace(replace(replace(replace(
    ${col}, ' ', ''), '-', ''), '.', ''), ',', ''), '&', ''), '''', ''), '/', ''), '_', ''))`;
  return sql`${stripped} = ${key}`;
}

/**
 * Best-effort organisation name from a signature block.
 *
 * Reads the LAST few non-empty lines, because a signature lives at the bottom
 * and the first line of a message is a greeting. Deliberately crude: a wrong
 * guess here costs one extra `brandKey` lookup that finds nothing, whereas a
 * clever parser would be a second thing to maintain for a marginal gain.
 * Returns null rather than a guess when nothing looks like a name.
 */
export function signatureNameFrom(bodyText: string | null | undefined): string | null {
  if (!bodyText) return null;
  const lines = bodyText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-8);
  for (const line of tail) {
    // A name line: no URL, no email, no sentence punctuation, short enough to
    // be a name rather than a paragraph.
    if (line.length < 3 || line.length > 60) continue;
    if (/https?:|@|\||^\d/.test(line)) continue;
    if (/[.!?]\s/.test(line)) continue;
    if (brandKey(line).length >= 4) return line;
  }
  return null;
}
