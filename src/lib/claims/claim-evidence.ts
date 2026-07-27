/**
 * OPE-237 — persistence + corroboration for the vendor realness screen.
 *
 * Pairs with the pure scoring in `./realness.ts`. This module owns the two
 * impure halves: writing the evidence row, and turning a declared website into
 * a `CorroborationClass`.
 *
 * ## Why the trigger is REGISTRATION, not a claim
 *
 * The ticket assumed claims arrive through `claim/direct` / `claim/confirm`.
 * Verified against prod D1 on 2026-07-27 before wiring anything (the ticket
 * explicitly asks for this check):
 *
 *   entity_claims rows                  1
 *   admin_actions matching '%claim%'    0     <- those endpoints have NEVER fired
 *   vendors.claimed = 1                14
 *     ...created in the SAME SECOND as the claiming user's account   13
 *
 * Those 13 are the register route's `else if (businessName)` branch minting a
 * listing for a registrant. Hooking the zero-traffic claim endpoints would have
 * shipped a writer that never runs — the exact "shipped but silently not
 * executing" class OPE-246 exists to catch.
 *
 * ## What is NOT implemented, and why
 *
 * Ticket §2 asks for a web-corroboration SEARCH — query the open web for the
 * business name + claimant name and find a presence the registrant did not
 * declare. **There is no general web-search API available to either Worker.**
 * `BING_WEBMASTER_API_KEY` is Bing *Webmaster Tools* (our own site's crawl
 * data), a different product from the Bing *Search* API; no Brave / Google CSE
 * / SerpAPI credential exists. So discovery-by-search is deferred pending a key
 * (see the OPE-237 receipt).
 *
 * What IS implemented is corroboration of a website the vendor DECLARES, which
 * needs no search key and yields exactly the ticket's three-way classification
 * — including the dead-presence caution case it calls out by name.
 */
import { eq } from "drizzle-orm";
import { vendorClaimEvidence } from "@/lib/db/schema";
import type { Db } from "@/lib/analytics-overview/shared";
import {
  assessRealness,
  computeCoherenceSignals,
  scoreRealness,
  splitTokens,
  type CoherenceInput,
  type CorroborationClass,
} from "./realness";

/**
 * The app's Drizzle client. Tests pass a hand-rolled stub with `as never` — a
 * bespoke structural type here looks tidier but silently drifts from the real
 * client's signature, which is how a "typechecked" helper ends up uncallable
 * from production code.
 */
type EvidenceDb = Db;

export interface RecordEvidenceArgs extends CoherenceInput {
  vendorId: string;
  userId: string | null;
}

/**
 * Write the signup-time evidence row.
 *
 * Runs INLINE in the register route rather than on a queue: the whole coherence
 * pass is string comparison with no network, so the latency is negligible and
 * an inline write cannot be lost to a queue binding that isn't bound. The
 * network half (corroboration) is what defers.
 *
 * Idempotent via the unique index on vendor_id — a retried registration cannot
 * produce a second row.
 *
 * Fail-soft: a registration must NEVER fail because the realness screen threw.
 * The caller wraps this; the heartbeat probe (`vendor-claim-evidence`) is what
 * makes a persistent failure visible rather than silent.
 */
export async function recordClaimEvidence(
  db: EvidenceDb,
  args: RecordEvidenceArgs,
  now: Date = new Date()
): Promise<{ score: number; band: string }> {
  // No website is collected at registration today, so corroboration starts
  // UNAVAILABLE — "not checked", never "clean". It resolves if/when the vendor
  // adds a website and the re-assessment runs.
  const result = assessRealness(args, "UNAVAILABLE");

  await db
    .insert(vendorClaimEvidence)
    .values({
      id: crypto.randomUUID(),
      vendorId: args.vendorId,
      userId: args.userId,
      claimantName: args.claimantName ?? null,
      claimantEmail: args.email,
      businessName: args.businessName,
      declaredWebsite: args.website ?? null,
      signals: JSON.stringify(result.signals),
      corroboration: result.corroboration,
      score: result.score,
      band: result.band,
      reasons: JSON.stringify(result.reasons),
      createdAt: now,
    })
    .onConflictDoNothing();

  return { score: result.score, band: result.band };
}

/**
 * Classify a declared web presence.
 *
 * The ticket's three-way split, with the dead case treated as CAUTION:
 *  - fetch succeeds AND the page references the business  -> STRONG
 *  - fetch succeeds but the page never names the business -> WEAK
 *      (a parked domain / unrelated squatter reads as "live" to a naive check)
 *  - fetch fails (404, unreachable, blocked)              -> WEAK
 *  - nothing declared                                     -> NONE
 *
 * `fetchHtml` is injected so the classifier stays pure-ish and testable; the
 * caller supplies the A5 `fetchVendorSite` escalation path in production.
 */
export async function classifyDeclaredPresence(
  website: string | null | undefined,
  businessName: string,
  fetchHtml: (url: string) => Promise<{ ok: boolean; html: string | null; failReason?: string }>
): Promise<{ corroboration: CorroborationClass; detail: string }> {
  const url = (website ?? "").trim();
  if (!url) return { corroboration: "NONE", detail: "No website declared at signup" };

  let res: { ok: boolean; html: string | null; failReason?: string };
  try {
    res = await fetchHtml(url);
  } catch (err) {
    return {
      corroboration: "WEAK",
      detail: `Declared site threw on fetch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok || !res.html) {
    return {
      corroboration: "WEAK",
      detail: `Declared site did not resolve (${res.failReason ?? "unreachable"}) — indexed-but-dead is caution, not corroboration`,
    };
  }

  if (pageReferencesBusiness(res.html, businessName)) {
    return { corroboration: "STRONG", detail: `Declared site is live and names the business` };
  }

  return {
    corroboration: "WEAK",
    detail:
      "Declared site is live but never names the business — possible parked domain or unrelated site",
  };
}

/**
 * Does the fetched page actually name the business?
 *
 * Token-based rather than exact-substring: "CD Ceramics and Florals" will
 * appear on the real site as "CD Ceramics & Florals", "CD Ceramics", etc. We
 * require a MAJORITY of the distinctive tokens so a single common word ("farm")
 * can't manufacture a STRONG on an unrelated page.
 */
export function pageReferencesBusiness(html: string, businessName: string): boolean {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .toLowerCase();

  const tokens = Array.from(new Set(splitTokens(businessName).filter((t) => t.length >= 4)));
  if (tokens.length === 0) {
    // Very short name (e.g. "Douse") — fall back to a whole-name search.
    const compact = businessName.toLowerCase().replace(/[^a-z0-9]/g, "");
    return compact.length > 0 && text.replace(/[^a-z0-9]/g, "").includes(compact);
  }

  const hits = tokens.filter((t) => text.includes(t)).length;
  return hits / tokens.length >= 0.5;
}

/**
 * Re-score an existing evidence row against current state.
 *
 * Called when something that feeds the score changes — today that is email
 * verification completing (worth 25 points, and it lands minutes-to-hours after
 * signup, so the signup-time score is always pessimistic) or a vendor adding a
 * website after the fact.
 */
export async function reassessClaimEvidence(
  db: EvidenceDb,
  args: {
    vendorId: string;
    input: CoherenceInput;
    corroboration: CorroborationClass;
    corroborationDetail?: string | null;
  },
  now: Date = new Date()
): Promise<{ score: number; band: string }> {
  const signals = computeCoherenceSignals(args.input);
  const result = scoreRealness(signals, args.corroboration);

  await db
    .update(vendorClaimEvidence)
    .set({
      signals: JSON.stringify(result.signals),
      corroboration: result.corroboration,
      corroborationDetail: args.corroborationDetail ?? null,
      declaredWebsite: args.input.website ?? null,
      score: result.score,
      band: result.band,
      reasons: JSON.stringify(result.reasons),
      assessedAt: now,
    })
    .where(eq(vendorClaimEvidence.vendorId, args.vendorId));

  return { score: result.score, band: result.band };
}

/**
 * Re-score every evidence row belonging to a freshly-verified email address.
 *
 * Called from the email-verification path. Email verification is worth 25
 * points and always lands AFTER signup, so without this the signup-time score
 * is permanently stale-pessimistic and the queue over-reports NEEDS_REVIEW.
 *
 * Coherence only — deliberately does NOT fetch. Corroboration is a separate,
 * admin-triggered pass; a user-facing verification click must not block on
 * someone else's web server.
 */
export async function rescoreEvidenceAfterVerification(
  // Loose type: this is called with the app's full drizzle client.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  email: string,
  now: Date = new Date()
): Promise<number> {
  const rows = await db
    .select({
      vendorId: vendorClaimEvidence.vendorId,
      claimantName: vendorClaimEvidence.claimantName,
      businessName: vendorClaimEvidence.businessName,
      claimantEmail: vendorClaimEvidence.claimantEmail,
      declaredWebsite: vendorClaimEvidence.declaredWebsite,
      corroboration: vendorClaimEvidence.corroboration,
      corroborationDetail: vendorClaimEvidence.corroborationDetail,
    })
    .from(vendorClaimEvidence)
    .where(eq(vendorClaimEvidence.claimantEmail, email));

  for (const row of rows) {
    const result = scoreRealness(
      computeCoherenceSignals({
        claimantName: row.claimantName,
        businessName: row.businessName,
        email: row.claimantEmail ?? email,
        emailVerified: true,
        website: row.declaredWebsite,
      }),
      // Preserve whatever the corroboration pass has (or hasn't) established.
      (row.corroboration ?? "UNAVAILABLE") as CorroborationClass
    );

    await db
      .update(vendorClaimEvidence)
      .set({
        signals: JSON.stringify(result.signals),
        score: result.score,
        band: result.band,
        reasons: JSON.stringify(result.reasons),
        assessedAt: now,
      })
      .where(eq(vendorClaimEvidence.vendorId, row.vendorId));
  }

  return rows.length;
}
