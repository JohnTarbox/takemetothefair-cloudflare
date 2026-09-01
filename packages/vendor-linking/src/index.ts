/**
 * @takemetothefair/vendor-linking — the ONE copy of the create-or-link-vendor
 * write tail.
 *
 * WHY THIS PACKAGE EXISTS: the dedup → create-if-needed → link-to-event → audit
 * logic used to live only in the MCP `create_or_link_vendor` tool. OPE-205's
 * booth-photo review needs the same write from the main app, and a second copy
 * of ~250 lines of vendor create/link/dedup rules is exactly the drift class
 * this repo has been bitten by (slug divergence #120; the geocode force/paging
 * bugs). So the logic lives here, and both the MCP tool and the app route are
 * thin adapters over `createOrLinkVendor`.
 *
 * PURE OF RUNTIME COUPLING: it imports only shared packages (utils / constants /
 * db-schema) and takes its two DB-integrity side-effects — completeness recompute
 * and enrichment logging — as injected deps, because each runtime already has its
 * own. The COSMETIC side-effects (IndexNow ping, post-create enrichment enqueue)
 * are deliberately NOT here: the core returns the flags a caller needs
 * (`wasCreated`, `linkIsPublic`, `vendorSlug`, `eventSlug`) and each adapter fires
 * those its own way. The core's job is the data, not the notifications.
 */
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@takemetothefair/db-schema";
import { containsCI } from "@takemetothefair/db-schema";
import {
  appendSlugSegment,
  createSlug,
  sanitizeProse,
  combinedSimilarity,
  getVendorComparisonString,
  normalizeVendorName,
  VENDOR_FORM_WORDS,
  type Slug,
} from "@takemetothefair/utils";
import {
  SITE_URL,
  PUBLIC_VENDOR_STATUSES,
  VENDOR_STATUS_TRANSITIONS,
  type EventVendorStatus,
  type PaymentStatus,
  type ParticipationType,
} from "@takemetothefair/constants";

const {
  adminActions,
  eventDays,
  eventVendors,
  events,
  users,
  vendorEnrichmentCandidates,
  vendors,
} = schema;

/** Both runtimes' Db satisfy this (the app's adds `$client`, still assignable). */
export type VendorLinkDb = DrizzleD1Database<typeof schema>;

const PUBLIC_VENDOR_SET = new Set<string>(PUBLIC_VENDOR_STATUSES);
const FUZZY_THRESHOLD = 0.92;
const FUZZY_CANDIDATE_CAP = 200;
const REDIRECT_CHAIN_MAX_DEPTH = 5;

export const DEDUP_STRATEGY_VALUES = ["strict", "fuzzy", "skip"] as const;
export type DedupStrategy = (typeof DEDUP_STRATEGY_VALUES)[number];

/** "City, ST" → {city, state}. Splits on the LAST comma. */
export function parseLocation(location: string): { city: string | null; state: string | null } {
  const lastComma = location.lastIndexOf(",");
  if (lastComma === -1) return { city: location.trim() || null, state: null };
  const city = location.slice(0, lastComma).trim() || null;
  const state = location.slice(lastComma + 1).trim() || null;
  return { city, state };
}

/** Raw input — the adapter passes user/tool values; the core sanitizes. */
export interface CreateOrLinkVendorInput {
  eventId: string;
  businessName: string;
  type?: string | null;
  status?: EventVendorStatus;
  description?: string | null;
  products?: string[] | null;
  location?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  logoUrl?: string | null;
  dedupStrategy?: DedupStrategy;
  boothInfo?: string | null;
  paymentStatus?: PaymentStatus;
  participationType?: ParticipationType;
  /** K18 — per-occurrence scoping. null/omitted → series-wide. */
  eventDayId?: string | null;
  /** OPE-316 — false when participation is recorded but must not render
   *  publicly (the LeafFilter case). Defaults true. */
  publicVisible?: boolean;
}

/** DB-integrity side-effects each runtime supplies its own implementation of. */
export interface CreateOrLinkVendorDeps {
  /** The acting admin, or null for internal/system writes. */
  actorUserId: string | null;
  recomputeVendorCompleteness: (db: VendorLinkDb, vendorId: string) => Promise<unknown>;
  logEnrichment: (
    db: VendorLinkDb,
    entry: {
      targetType: "vendor";
      targetId: string;
      source: "mcp_create";
      status: "success";
      actorUserId?: string | null;
      notes?: string;
    }
  ) => Promise<void>;
}

export interface CreateOrLinkVendorSuccess {
  ok: true;
  vendorId: string;
  vendorSlug: Slug;
  eventSlug: string;
  eventVendorRowId: string;
  wasCreated: boolean;
  wasLinked: boolean;
  wasAlreadyLinked: boolean;
  statusChanged: boolean;
  matchedExisting: { name: string; similarity_score: number | null } | null;
  /** True when the link is in a public status — the adapter decides whether to
   *  ping IndexNow for the event. */
  linkIsPublic: boolean;
}

export interface CreateOrLinkVendorFailure {
  ok: false;
  error: string;
}

export type CreateOrLinkVendorResult = CreateOrLinkVendorSuccess | CreateOrLinkVendorFailure;

type VendorRow = {
  id: string;
  businessName: string;
  vendorType: string | null;
  redirectToVendorId: string | null;
  slug: Slug;
};

/** Resolve a vendor through its redirect_to_vendor_id chain to the canonical row. */
async function resolveRedirectChain(db: VendorLinkDb, startRow: VendorRow): Promise<VendorRow> {
  let current = startRow;
  const visited = new Set<string>([current.id]);
  for (let depth = 0; depth < REDIRECT_CHAIN_MAX_DEPTH; depth++) {
    if (!current.redirectToVendorId) return current;
    if (visited.has(current.redirectToVendorId)) {
      throw new Error(`alias_cycle_detected: vendor ${current.id} → ${current.redirectToVendorId}`);
    }
    visited.add(current.redirectToVendorId);
    const next = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        vendorType: vendors.vendorType,
        redirectToVendorId: vendors.redirectToVendorId,
        slug: vendors.slug,
      })
      .from(vendors)
      .where(eq(vendors.id, current.redirectToVendorId))
      .limit(1);
    if (next.length === 0) return current; // dangling pointer → treat as canonical
    current = next[0];
  }
  throw new Error(
    `alias_cycle_detected: redirect chain exceeded max depth ${REDIRECT_CHAIN_MAX_DEPTH}`
  );
}

/**
 * `strict` — "case-insensitive exact match", which is what the tool has always
 * documented and, until OPE-451, not what it did.
 *
 * It was `eq(vendors.businessName, businessName)`: a raw, case-SENSITIVE,
 * byte-for-byte comparison. Live on 2026-08-17 a roster page printed "Time to
 * Be Candle Company" while the row held "Time To Be Candle Company"; one
 * capital letter produced a duplicate vendor. `strict` is the strategy callers
 * are told to fall back to when `fuzzy` misbehaves, so its failing quietly is
 * the worst possible place for this.
 *
 * Two passes, both cheap:
 *
 *  1. `lower(business_name) = lower(?)` — the literal documented contract, and
 *     the one that fixes the reported case.
 *  2. A stem-narrowed scan compared on `normalizeVendorName`, which folds HTML
 *     entities, the Unicode dash family, `&`↔`and`, and trailing legal forms
 *     (`LLC`, `Inc.`, `Co`). This is OPE-451 scope 4: the normalizer already
 *     existed for `fuzzy` (DQ6/OPE-13) and strict simply never used it, so
 *     "Center Street Soap Co." and "Center Street Soap Company" were two rows.
 *
 * Still EXACT after normalization — no similarity threshold — so `strict`
 * keeps meaning "the same name", not "a similar name".
 */
export async function findStrictMatch(
  db: VendorLinkDb,
  businessName: string
): Promise<VendorRow | null> {
  const caseInsensitive = await db
    .select({
      id: vendors.id,
      businessName: vendors.businessName,
      vendorType: vendors.vendorType,
      redirectToVendorId: vendors.redirectToVendorId,
      slug: vendors.slug,
    })
    .from(vendors)
    .where(
      and(sql`lower(${vendors.businessName}) = lower(${businessName})`, isNull(vendors.deletedAt))
    )
    .limit(1);
  if (caseInsensitive.length > 0) return caseInsensitive[0];

  const normalizedTarget = normalizeVendorName(businessName);
  if (!normalizedTarget) return null;

  const candidates = await selectStemCandidates(db, businessName);
  // Deterministic on ties: lowest id wins, so a repeated backfill links the
  // same row every time instead of alternating between two duplicates.
  let bestId: VendorRow | null = null;
  for (const candidate of candidates) {
    if (normalizeVendorName(candidate.businessName) !== normalizedTarget) continue;
    if (!bestId || candidate.id < bestId.id) bestId = candidate;
  }
  return bestId;
}

/**
 * The token this repo's `slug` column synthesizes but a raw business name need
 * not contain. `createSlug` (and `normalizeVendorName`) both expand `&` to
 * "and", so "and" is present in the slug of a row whose stored name has only
 * an ampersand — and absent from the name itself. It is therefore never a
 * distinctive stem, and never a safe one.
 */
/**
 * Tokens too common to narrow on.
 *
 * `and` is here because the slugifier SYNTHESIZES it from `&` (OPE-712), so it
 * may be absent from a stored raw name.
 *
 * `the` is here for a different and sharper reason (OPE-715): it is not
 * distinctive. Measured against prod 2026-09-01 — **439 of 6,805 live vendors
 * contain "the"**, against a `FUZZY_CANDIDATE_CAP` of **200**. So a stem of
 * "the" fetches an arbitrary 200 of 439 and the true match is crowded out
 * roughly half the time.
 *
 * That is not hypothetical. All SEVEN duplicate vendor rows minted after
 * OPE-451 closed the type-veto defect begin with "The ": The Knotty Cod, The
 * Sea by Me (x3), The Savage Light (x2), The Wine Slushie Guy. 176 live vendors
 * start with "The ", and the drains kept minting second copies of them.
 */
const LOW_SELECTIVITY_TOKENS = new Set(["and", "the"]);

/**
 * Tokens that are unsafe to narrow on because NORMALIZATION CHANGES THEM.
 *
 * The rule underneath both sets: a stem is a raw-text filter, but equality is
 * judged on the NORMALIZED string, so any token normalization can add or remove
 * is a stem that can delete the very row it should find.
 *
 *  - `and`  — normalize ADDS it, from `&` (OPE-712).
 *  - `the`  — not added or removed, but matches 439 of 6,805 vendors against a
 *             200-row cap, so it fails the same way for a different reason
 *             (OPE-715).
 *  - legal forms — normalize REMOVES them, so "Soap Company" narrowing on
 *             `%company%` cannot find the stored "Soap Co." This is caught by
 *             OPE-451's "folds a trailing legal form" test, which failed the
 *             first time this selector was changed to prefer the longest token.
 */
function isUnsafeStem(token: string): boolean {
  return LOW_SELECTIVITY_TOKENS.has(token) || VENDOR_FORM_WORDS.has(token);
}

/**
 * The slug-space stem: the LONGEST token of the incoming name's slug form,
 * ignoring the synthesized "and".
 *
 * Longest rather than first, deliberately. The first token of
 * "m-and-d-fine-jewelry" that clears 3 characters is "and" — and `LIKE '%and%'`
 * matches "candle", "island", "grand", "handmade"…, which on 6,567 rows would
 * fill the 200-row cap with noise and could push the true match out of it. The
 * longest token is the most distinctive one, which is what a narrowing filter
 * wants.
 */
function slugStem(businessName: string): string | undefined {
  const slug = createSlug(businessName) as string;
  if (!slug) return undefined;
  let best: string | undefined;
  for (const token of slug.split("-")) {
    if (token.length < 3 || isUnsafeStem(token)) continue;
    if (!best || token.length > best.length) best = token;
  }
  return best;
}

async function fetchCandidates(db: VendorLinkDb, narrowing?: SQL): Promise<VendorRow[]> {
  const filters = [isNull(vendors.deletedAt)];
  if (narrowing) filters.push(narrowing);

  return db
    .select({
      id: vendors.id,
      businessName: vendors.businessName,
      vendorType: vendors.vendorType,
      redirectToVendorId: vendors.redirectToVendorId,
      slug: vendors.slug,
    })
    .from(vendors)
    .where(and(...filters))
    .limit(FUZZY_CANDIDATE_CAP);
}

/**
 * Shared LIKE-stem narrowing used by both dedup strategies. Caps the in-memory
 * set to bound CPU on large tables.
 *
 * ── OPE-712: narrowing on RAW text while judging on NORMALIZED text ───────
 *
 * The scorer compares `getVendorComparisonString`, i.e. `normalizeVendorName`,
 * which folds `&`↔"and". The narrowing below compares the raw stored
 * `business_name`. Those two disagree, and the disagreement DELETES candidates
 * before they are ever scored — so the miss is invisible to every test that
 * exercises the scorer.
 *
 * Measured instance, prod, 2026-08-31: a roster pass wrote "M and D Fine
 * Jewelry" while "M & D Fine Jewelry" (created 2026-07-27) already existed.
 * The stem rule takes the first token of ≥3 characters, which for "M and D
 * Fine Jewelry" is literally **"and"** — and `LIKE '%and%'` does not match
 * "M & D Fine Jewelry". The existing row was never fetched, so it was never
 * scored. Scoring was never the problem: both names normalize to
 * "m and d fine jewelry" and score **1.0**, comfortably over the 0.92 gate.
 *
 * It is also ASYMMETRIC, which is why it hid. Writing "M & D Fine Jewelry"
 * against a stored "M and D Fine Jewelry" picks the stem "fine" and matches
 * fine. Only the "and"-spelled direction fails, and only when the ampersand
 * follows a token too short to be a stem (`M & D`, `B & B`) — so "Lemon &
 * Maisey" and 189 other ampersand writes in the same run were unaffected and
 * the rails looked healthy.
 *
 * The fix adds a SECOND narrowing over the `slug` column, whose stored value
 * already went through `createSlug` — the same `&`→"and" fold. Both sides then
 * meet in one space. It SUPPLEMENTS rather than replaces the name clause,
 * because a slug is SEO-stable: renaming a vendor deliberately does not move
 * its slug, so the two columns legitimately drift and neither alone is
 * sufficient.
 *
 * Two capped queries, merged — not one query with `OR`. Under a single
 * `LIMIT 200` the noisy clause can crowd the precise one out of the result
 * set, which would reintroduce the same silent miss with extra steps.
 *
 * Both passes use `containsCI` (`instr(lower(col), ?) > 0`) rather than `LIKE`.
 * The stem is derived from a caller-supplied business name, and D1 throws
 * `LIKE or GLOB pattern too complex` once the PATTERN exceeds 50 characters
 * while local SQLite allows 50,000 — so a long single-token name would have
 * failed only in production, and only for the writer unlucky enough to have
 * one. `instr` is exactly equivalent for a substring test, has no pattern-length
 * limit, and needs no metacharacter escaping. See `packages/db-schema/src/contains-ci.ts`.
 *
 * ⚠️ NOT closed by this: `VENDOR_ABBREVIATION_MAP` is the same shape of hole
 * ("Assn Of X" vs "Association Of X" — `assn` is not a substring of
 * `association`, and `createSlug` does not expand abbreviations either). No
 * instance of it has been measured in prod, so it is filed rather than fixed
 * on speculation.
 */
/**
 * The raw-name stem: the LONGEST token of >= 3 characters, skipping the
 * low-selectivity set.
 *
 * OPE-715 — this used to take the FIRST token of >= 3 characters, which for any
 * name beginning "The " is "the". `LIKE '%the%'` matches 439 of 6,805 live
 * vendors against a 200-row cap, so the true match was crowded out about half
 * the time and a second row was minted. Every duplicate created after OPE-451
 * closed the previous cause begins with "The ".
 *
 * Longest rather than first, because the longest token is the most distinctive
 * one — which is the entire job of a narrowing filter. "The Wine Slushie Guy"
 * now stems on "slushie" instead of "the".
 */
function rawNameStem(businessName: string): string | undefined {
  const tokens = businessName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !isUnsafeStem(t));
  let best: string | undefined;
  for (const t of tokens) if (!best || t.length > best.length) best = t;
  // Fall back to the old rule when EVERY token is low-selectivity ("The And"),
  // so a name made only of stopwords still narrows on something rather than
  // scanning the cap unfiltered.
  if (best) return best;
  return businessName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3)[0];
}

async function selectStemCandidates(db: VendorLinkDb, businessName: string): Promise<VendorRow[]> {
  const stem = rawNameStem(businessName);

  const byName = await fetchCandidates(
    db,
    stem ? containsCI(vendors.businessName, stem) : undefined
  );

  const slugToken = slugStem(businessName);
  // No stem at all already means "scan the cap unfiltered"; a second pass over
  // the same unfiltered set would add nothing.
  if (!slugToken || !stem) return byName;

  const bySlug = await fetchCandidates(db, containsCI(vendors.slug, slugToken));

  const seen = new Set(byName.map((r) => r.id));
  const merged = byName.slice();
  for (const row of bySlug) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

/**
 * Fuzzy candidate scan: narrow via a LIKE stem, then rank with combinedSimilarity.
 * Caps the in-memory set to bound CPU on large tables.
 */
export async function findFuzzyMatch(
  db: VendorLinkDb,
  businessName: string,
  vendorType: string | null | undefined
): Promise<{ row: VendorRow; score: number } | null> {
  const candidates = await selectStemCandidates(db, businessName);
  if (candidates.length === 0) return null;

  const target = getVendorComparisonString({ businessName, vendorType: vendorType ?? null });
  let best: { row: VendorRow; score: number } | null = null;

  for (const candidate of candidates) {
    const candidateStr = getVendorComparisonString({
      businessName: candidate.businessName,
      vendorType: candidate.vendorType,
    });
    const score = combinedSimilarity(target, candidateStr, 0.6, FUZZY_THRESHOLD);
    if (score < FUZZY_THRESHOLD) continue;
    if (!best || score > best.score) {
      best = { row: candidate, score };
      continue;
    }
    if (score === best.score) {
      const candidateExact = candidate.businessName.toLowerCase() === businessName.toLowerCase();
      const bestExact = best.row.businessName.toLowerCase() === businessName.toLowerCase();
      if (candidateExact && !bestExact) {
        best = { row: candidate, score };
        continue;
      }
      if (candidate.id < best.row.id) best = { row: candidate, score };
    }
  }

  return best;
}

/**
 * Dedup-search, create-if-needed, and link a vendor to an event in one call.
 * The single source of truth for this write; the MCP tool and the app route are
 * thin adapters. Never throws for expected failures — returns `{ok:false,error}`.
 */
export async function createOrLinkVendor(
  db: VendorLinkDb,
  input: CreateOrLinkVendorInput,
  deps: CreateOrLinkVendorDeps
): Promise<CreateOrLinkVendorResult> {
  const businessName = sanitizeProse(input.businessName ?? "");
  const vendorType = input.type != null ? sanitizeProse(input.type) : null;
  const description = input.description != null ? sanitizeProse(input.description) : null;
  const productsClean = Array.isArray(input.products)
    ? input.products.map((p) => sanitizeProse(p))
    : null;
  const status: EventVendorStatus = input.status ?? "CONFIRMED";
  const paymentStatus: PaymentStatus = input.paymentStatus ?? "NOT_REQUIRED";
  const participationType: ParticipationType = input.participationType ?? "EXHIBITOR";
  const dedupStrategy: DedupStrategy = input.dedupStrategy ?? "fuzzy";

  if (businessName.length === 0) {
    return { ok: false, error: "business_name is empty after sanitization." };
  }

  // 1. Event resolve
  const eventRows = await db
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      // OPE-714 — the roster page the caller read, when we have it. It is the
      // honest source for a type disagreement raised off that page.
      sourceUrl: events.sourceUrl,
    })
    .from(events)
    .where(eq(events.id, input.eventId))
    .limit(1);
  if (eventRows.length === 0) {
    return { ok: false, error: `Event not found: ${input.eventId}` };
  }
  const event = eventRows[0];

  // 2. Dedup
  let matched: { row: VendorRow; score: number | null } | null = null;
  if (dedupStrategy !== "skip") {
    if (dedupStrategy === "strict") {
      const strictRow = await findStrictMatch(db, businessName);
      if (strictRow) matched = { row: strictRow, score: 1 };
    } else {
      const found = await findFuzzyMatch(db, businessName, vendorType);
      if (found) matched = { row: found.row, score: found.score };
    }

    if (matched) {
      try {
        const canonical = await resolveRedirectChain(db, matched.row);
        matched = { row: canonical, score: matched.score };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  // ── OPE-714: a discarded `type` leaves a receipt ─────────────────────────
  //
  // `type` is applied ONLY on create. On a dedup match the caller's value is
  // dropped and the tool returns ok — and the caller has just read the vendor's
  // own category off the organizer's page, the best evidence available.
  //
  // Not overwriting is the right DEFAULT: a link call must not be able to
  // clobber a curated field merely by mentioning a vendor. The defect is that
  // there was no other path, so the rail with the evidence could not write it
  // and no rail that could write it had the evidence. Six live rows were met
  // and re-discarded in a single 2026-08-31 drain — `Fine Fettle` stored as
  // "Home Improvement" (a cannabis dispensary), `Cutco` as "RV Accessories".
  //
  // So the value is preserved as a PENDING proposal rather than applied. The
  // silent loss becomes a reviewable one; nothing is overwritten; a reviewer can
  // drain or ignore the queue. `vendor_enrichment_candidates` already carries a
  // partial unique on (vendor, field) WHERE decision='pending', so the fiftieth
  // drain to meet Cutco does not create a fiftieth row.
  if (matched && vendorType && matched.row.vendorType !== vendorType) {
    try {
      await db
        .insert(vendorEnrichmentCandidates)
        .values({
          vendorId: matched.row.id,
          jobRunId: `roster-link-${crypto.randomUUID()}`,
          proposedField: "vendor_type",
          currentValue: matched.row.vendorType ?? null,
          proposedValue: vendorType,
          // The organizer's page when the event has one; otherwise our own event
          // record, which is where the claim demonstrably came from. Never a
          // fabricated URL — the column is how a reviewer retraces the claim.
          sourceUrl: event.sourceUrl ?? `${SITE_URL}/events/${event.slug}`,
          extractionMethod: "roster-link",
          confidence: 0,
          flags: JSON.stringify(["type_disagreement"]),
          createdAt: new Date(),
        })
        // A pending proposal for this (vendor, field) already exists. That is
        // the normal case on a re-drain and is not an error.
        .onConflictDoNothing();
    } catch {
      // Best-effort by design: the link is the caller's actual request, and a
      // receipt failing must not fail it. A dropped receipt returns us to
      // today's behaviour, which is the floor, not a regression.
    }
  }

  let vendorId: string;
  let vendorSlug: Slug;
  let wasCreated = false;
  const matchedExisting = matched
    ? { name: matched.row.businessName, similarity_score: matched.score }
    : null;

  // 3. Create new vendor if no match
  if (matched) {
    vendorId = matched.row.id;
    vendorSlug = matched.row.slug;
  } else {
    const baseSlug = createSlug(businessName);
    if (!baseSlug) {
      return { ok: false, error: "Could not generate a valid slug from the business name." };
    }

    let finalSlug: Slug = baseSlug;
    let suffix = 0;
    while (true) {
      const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
      const slugCheck = await db
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.slug, candidate))
        .limit(1);
      if (slugCheck.length === 0) {
        finalSlug = candidate;
        break;
      }
      suffix++;
      if (suffix > 20) {
        return { ok: false, error: "Too many slug collisions. Try a more unique business name." };
      }
    }

    const placeholderEmail = `pending+${finalSlug}@meetmeatthefair.com`;
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      email: placeholderEmail,
      // OPE-292 — a placeholder OWNER row, not a registration.
      //
      // ⚠️ This is the writer the original fix MISSED. `create_vendor` and
      // `create_promoter` in mcp-server were both stamped in PR #900; this one
      // lives in a shared package and was not, so it kept defaulting to
      // `registration`. Between 2026-08-18 22:09 and 2026-08-20 00:20 it minted
      // **389** mislabelled rows — enough that `origin='registration'` read 64%
      // placeholder, making the column wrong in the exact way it was added to
      // prevent.
      //
      // The audit that accompanied #900 enumerated `from(users)` sites across
      // `src/` and `mcp-server/src/` and did not reach `packages/`. A fix wired
      // into one of two parallel paths is this repo's most repeated defect;
      // when stamping a field on creation, grep the WORKSPACE, not the app.
      //
      // The health-report invariant added alongside this makes a recurrence
      // visible instead of silent.
      origin: "ingestion",
      role: "VENDOR",
    });

    const loc = input.location ? parseLocation(input.location) : { city: null, state: null };

    vendorId = crypto.randomUUID();
    await db.insert(vendors).values({
      id: vendorId,
      userId,
      businessName,
      slug: finalSlug,
      vendorType,
      description,
      products: productsClean ? JSON.stringify(productsClean) : "[]",
      website: input.website ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      logoUrl: input.logoUrl ?? null,
      city: loc.city,
      state: loc.state,
    });

    await deps.recomputeVendorCompleteness(db, vendorId);
    await deps.logEnrichment(db, {
      targetType: "vendor",
      targetId: vendorId,
      source: "mcp_create",
      status: "success",
      actorUserId: deps.actorUserId,
      notes: "create_or_link_vendor (new vendor)",
    });

    vendorSlug = finalSlug;
    wasCreated = true;
  }

  // 4. UPSERT event_vendors (K18 — validate optional per-occurrence scoping first)
  const eventDayId = input.eventDayId ?? null;
  if (eventDayId !== null) {
    const dayRows = await db
      .select({ id: eventDays.id, eventId: eventDays.eventId })
      .from(eventDays)
      .where(eq(eventDays.id, eventDayId))
      .limit(1);
    if (dayRows.length === 0) {
      return { ok: false, error: `event_day_id not found: ${eventDayId}` };
    }
    if (dayRows[0].eventId !== input.eventId) {
      return {
        ok: false,
        error: `event_day_id ${eventDayId} belongs to event ${dayRows[0].eventId}, not ${input.eventId}. Cross-event scoping is not allowed.`,
      };
    }
  }

  const linkRows = await db
    .select({
      id: eventVendors.id,
      status: eventVendors.status,
      paymentStatus: eventVendors.paymentStatus,
      participationType: eventVendors.participationType,
    })
    .from(eventVendors)
    .where(
      and(
        eq(eventVendors.eventId, input.eventId),
        eq(eventVendors.vendorId, vendorId),
        eventDayId === null
          ? isNull(eventVendors.eventDayId)
          : eq(eventVendors.eventDayId, eventDayId)
      )
    )
    .limit(1);

  let wasLinked = false;
  let wasAlreadyLinked = false;
  let statusChanged = false;
  let eventVendorRowId: string;

  if (linkRows.length === 0) {
    eventVendorRowId = crypto.randomUUID();
    await db.insert(eventVendors).values({
      id: eventVendorRowId,
      eventId: input.eventId,
      vendorId,
      status,
      paymentStatus,
      participationType,
      boothInfo: input.boothInfo ?? null,
      eventDayId,
      // OPE-316 — defaults true; false records participation without showing it.
      publicVisible: input.publicVisible ?? true,
    });
    wasLinked = true;
  } else {
    const existing = linkRows[0];
    eventVendorRowId = existing.id;
    wasAlreadyLinked = true;

    const updates: Record<string, unknown> = {};
    if (status !== existing.status) {
      const allowed = VENDOR_STATUS_TRANSITIONS[existing.status as EventVendorStatus];
      if (!allowed || !allowed.includes(status)) {
        return {
          ok: false,
          error: `Invalid transition: ${existing.status} → ${status}. Allowed from ${existing.status}: ${(allowed || []).join(", ") || "none"}.`,
        };
      }
      updates.status = status;
      statusChanged = true;
    }
    // Only update payment/participation when EXPLICITLY provided and different,
    // so a no-op call doesn't generate a phantom UPDATE with a defaulted value.
    if (input.paymentStatus !== undefined && input.paymentStatus !== existing.paymentStatus) {
      updates.paymentStatus = input.paymentStatus;
    }
    if (
      input.participationType !== undefined &&
      input.participationType !== existing.participationType
    ) {
      updates.participationType = input.participationType;
    }
    if (input.boothInfo !== undefined) updates.boothInfo = input.boothInfo;

    if (Object.keys(updates).length > 0) {
      await db.update(eventVendors).set(updates).where(eq(eventVendors.id, existing.id));
    }
  }

  // 5. Audit log
  await db.insert(adminActions).values({
    action: "event_vendor.create_or_link",
    actorUserId: deps.actorUserId,
    targetType: "event_vendor",
    targetId: eventVendorRowId,
    payloadJson: JSON.stringify({
      event_id: input.eventId,
      vendor_id: vendorId,
      event_day_id: eventDayId,
      was_created: wasCreated,
      was_linked: wasLinked,
      was_already_linked: wasAlreadyLinked,
      status_changed: statusChanged,
      status,
      payment_status: paymentStatus,
      dedup_strategy: dedupStrategy,
      matched_existing: matchedExisting,
    }),
    createdAt: new Date(),
  });

  return {
    ok: true,
    vendorId,
    vendorSlug,
    eventSlug: event.slug,
    eventVendorRowId,
    wasCreated,
    wasLinked,
    wasAlreadyLinked,
    statusChanged,
    matchedExisting,
    linkIsPublic: (wasLinked || statusChanged) && PUBLIC_VENDOR_SET.has(status),
  };
}
