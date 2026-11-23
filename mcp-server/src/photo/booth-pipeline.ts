/**
 * OPE-204 (Milestone A) — booth-photo → vendor IDENTIFICATION + staging.
 *
 * For each photo on a fair-resolved `photos@` email, ask the vision model whose
 * booth it is, then stage the answer for operator review. Emits one
 * `admin_actions` row per identified booth and flags the inbound row.
 *
 * ── What this milestone deliberately does NOT do ──────────────────────────
 * It does not create vendors, link them to events, or set hero images. That
 * auto-write tail is Milestone B, and it is held back on purpose:
 *
 *   1. OPE-6 / customer-facing. Writing here publishes a real business as a
 *      CONFIRMED exhibitor at a real fair, from an email. John's standing
 *      instruction (2026-07-15) is "build gated OFF, decide later".
 *   2. Nobody has measured this vision model's accuracy on real booth photos
 *      yet. Wiring a public write to an unmeasured classifier is backwards —
 *      the staged rows ARE the measurement. Once John has seen a few real
 *      batches, Milestone B turns on with a known false-positive rate.
 *
 * The whole stage is additionally gated behind PHOTO_VISION_ENABLED, so it
 * costs zero AI spend until explicitly switched on (the EMAIL_REPLY_ENABLED
 * `=== "true"` default-OFF precedent).
 *
 * ── Staging mechanism ─────────────────────────────────────────────────────
 * `admin_actions` + `flagged_for_review=1`, exactly the OPE-176 roster
 * stage-for-review pattern (`inbound-email.ts:790-827`). Deliberately NOT
 * `vendor_enrichment_candidates`: that table is field-level enrichment of an
 * EXISTING vendor (`vendor_id` NOT NULL, one `proposed_field`), which cannot
 * express "maybe a new vendor, maybe existing X, link to event Y".
 */
import { adminActions, inboundEmails } from "../schema.js";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import {
  identifyBooth,
  checkBoothPresence,
  applyPresenceGate,
  disposition,
  unidentified,
  type BoothIdentification,
  type Disposition,
  type StageKind,
  type VisionAi,
} from "./vision.js";
import { attachGeneralPhotos } from "./general-photos.js";
import { autoWriteBooths, type AutoWriteOutcome } from "./auto-write.js";
import { matchRosterPerformer, resolvePerformerPhoto } from "./performer-photos.js";
import { hasIndependentProducts } from "./sign-words.js";
import {
  applyCardPlan,
  cardDomainCandidates,
  cardNameProblem,
  planCardFields,
  readBusinessCard,
  type CardApplyResult,
  type CardFieldPlan,
  type CardReading,
  type CardStageKind,
} from "./business-card.js";
import {
  cardRowsForEmail,
  laterCardRows,
  pairCardRow,
  pairWindowMs,
  shotAt,
  type PairingOutcome,
} from "./card-pairing.js";
import { createVendorFromCard, linkCardVendorToEvent } from "./card-vendor.js";
import { vendors } from "../schema.js";
import {
  extractSignDomain,
  findFuzzyMatch,
  findStrictMatch,
  resolveVendorBySignDomain,
  type DomainVendorMatch,
  type VendorLinkDb,
} from "@takemetothefair/vendor-linking";

/** Audit action for a staged booth identification. */
export const BOOTH_PROPOSED_ACTION = "vendor.photo_proposed";
/** OPE-969 — a performer photo held for review (unnamed, unmatched, off-roster, or a child). */
export const PERFORMER_PROPOSED_ACTION = "performer.photo_proposed";
/** OPE-969 — a performer photo matched to an appearance already on the lineup. Nothing created. */
export const PERFORMER_CONFIRMED_ACTION = "performer.photo_confirmed";
/**
 * OPE-978 — a scenery photo attached to the event gallery. Before this the
 * gallery path wrote no decision row, so a photo classified as scenery was
 * indistinguishable from one that vanished: two of the 2026-09-12 New Gloucester
 * emails read "0 proposals, 0 failures" while their photos sat in the gallery.
 */
export const GALLERY_ATTACHED_ACTION = "photo.gallery_attached";
/** OPE-969 — a sign whose owner is not the subject. Recorded; nothing else written. */
export const SIGNAGE_RECORDED_ACTION = "photo.signage_not_presence";
/**
 * OPE-1705 — a business card staged for a person (unreadable, generic, ambiguous,
 * or no vendor matched). Its OWN action, not `vendor.photo_proposed`: both booth
 * approve tails post the proposal's photo as a logo/gallery image and select on
 * that action string, so a card can never reach them.
 */
export const CARD_PROPOSED_ACTION = "vendor.card_proposed";
/** OPE-1705 — a card matched to an existing vendor; fields written/staged per business-card.ts. */
export const CARD_APPLIED_ACTION = "vendor.card_applied";

/**
 * Photos to run vision over in one email.
 *
 * The receive-time capture already caps at 5 attachments
 * (ATTACHMENT_MAX_COUNT), so this is a belt-and-braces bound on AI spend and
 * on the inbound workflow's time budget rather than a real limit.
 */
export const MAX_PHOTOS_PER_EMAIL = 5;

export interface PipelinePhoto {
  /** R2 key under inbound-attachments/... */
  key: string;
  name: string;
}

export interface BoothPipelineResult {
  /** Photos actually run through vision. */
  examined: number;
  /** BOOTH identifications staged for review (needs a human). */
  staged: number;
  /** OPE-969 — performer photos staged for review. Counted apart from booths so
   *  the reply's booth count means booths. */
  performerStaged: number;
  /** OPE-969 — performer photos matched to an appearance already on the event. */
  performersConfirmed: Array<{ performerId: string; performerName: string; photoName: string }>;
  /** OPE-969 — signage-not-presence outcomes recorded (no proposal, no write). */
  signageRecorded: number;
  /** General (non-booth) scenery — the input to the gallery attach below. */
  skipped: number;
  /** Business names staged OR auto-written, for the reply. */
  identifiedNames: string[];
  /** OPE-205 §3 — general photos attached to the event as gallery candidates. */
  galleryAttached: number;
  /** General photos we tried but couldn't attach. Reported, never swallowed. */
  galleryFailed: number;
  /**
   * OPE-1697 — gallery photos deliberately NOT attached because the fair was
   * not explicitly chosen and more than one same-day fair is nearby. Absent
   * (not 0) when no hold applied, so older readers see no change.
   */
  galleryHeld?: number;
  /** OPE-469 — true when nothing was written. Absent on a live run. */
  dryRun?: boolean;
  /**
   * OPE-469 — business names auto-write WOULD have created, had this not been a
   * dry run. Distinct from `identifiedNames`, which on a live run covers both
   * staged and auto-written; here the two are kept apart so a replay can say
   * which path each photo was heading for.
   */
  wouldAutoWrite?: string[];
  /**
   * OPE-1694 — dry run only: the would-writes that LINK an existing vendor
   * because the sign's domain is on it, rather than creating one.
   */
  wouldLinkByDomain?: Array<{
    businessName: string;
    domain: string;
    vendorId: string;
    vendorName: string;
  }>;
  /**
   * OPE-204 Milestone B — booths auto-written (created/linked as CONFIRMED
   * exhibitors) when PHOTO_AUTOWRITE_ENABLED is on. Empty in identify-only mode.
   * These are the itemized sets OPE-205 §1's reply consumes.
   */
  autoWritten: AutoWriteOutcome[];
  /** Set when the gate is off — reported so a silent no-op is impossible. */
  disabledReason?: string;
  /**
   * OPE-1705 — business cards. `applied` matched an existing vendor (fields
   * written and/or staged); `proposed` staged for a person. Absent when no card
   * was in the batch, so older readers see no change.
   */
  cards?: {
    applied: Array<{
      vendorId: string;
      vendorName: string;
      /** "created" = OPE-1705 slice 3: no vendor matched and "Add as vendor" was ticked. */
      matchBasis: "domain" | "name" | "created";
      written: string[];
      staged: string[];
      conflicts: string[];
      /** Slice 3 — the event the card's vendor was linked to (pinned fair / "Met them at…"). */
      linkedEventId?: string | null;
    }>;
    proposed: Array<{ businessName: string | null; stageKind: CardStageKind }>;
    /** Slice 3, dry run only — vendors a live run would create ("Add as vendor"). */
    wouldCreate?: string[];
  };
  /**
   * OPE-1705 slice 2 — cards paired with a booth shot just before them, by this
   * run (either side: this run's card looking back, or this run's booth finding
   * a card that finished first). Absent when nothing was paired.
   */
  cardPairings?: PairingOutcome[];
  /**
   * OPE-1705 slice 3 — cards that got a decision row (applied, created or
   * proposed). A card is a deliberate outcome, not a photo that "landed
   * nowhere": `describePhotoStorage` counts it, or a lone card snap at a fair
   * read as an unstored-photo defect and the OPE-403 sweep re-tried it.
   */
  cardsHandled?: number;
  /**
   * OPE-1705 slice 3 — an EVENT-LESS run (no fair: "No fair" mode, or the hold
   * path asking "is this only cards?") found this many photos that are NOT
   * cards. Nothing was written; the caller falls back to the ordinary path.
   */
  notCards?: number;
  /**
   * OPE-403 follow-up — per-photo vision failure reasons, when the model
   * produced nothing usable. Empty when every photo identified cleanly.
   *
   * The gate returning a `disabledReason` covers "vision never ran". This
   * covers the other half: vision ran and failed, which previously surfaced
   * only as `confidence: 0` with an unactionable rationale string.
   */
  visionFailures: string[];
}

export interface BoothPipelineEnv {
  AI?: VisionAi;
  VENDOR_ASSETS?: R2Bucket;
  /** OPE-6 gate. Must equal "true" or the pipeline no-ops. Default OFF. */
  PHOTO_VISION_ENABLED?: string;
  /**
   * OPE-204 Milestone B gate — INDEPENDENT of PHOTO_VISION_ENABLED. With vision
   * ON but this OFF, every booth (including high-confidence ones) is STAGED for
   * review — the identify-only measurement mode. Only when this is "true" do the
   * high-confidence booths auto-create vendors. Default OFF (customer-facing
   * writes; STOP-gated per OPE-6).
   */
  PHOTO_AUTOWRITE_ENABLED?: string;
  /** OPE-205 §3 — needed to hand general photos to the main app's pipeline. */
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
  /** OPE-1705 — minutes before a card its booth may have been shot (default 10). */
  CARD_PAIR_WINDOW_MINUTES?: string;
}

/**
 * Identify + stage the booths in one fair-resolved photo email.
 *
 * Fail-soft throughout: a photo that can't be read, or a model that errors, is
 * skipped rather than throwing. This runs inside the inbound-email workflow and
 * must never sink an email over a bad JPEG.
 */
export interface BoothPipelineOptions {
  /**
   * OPE-469 — classify without writing anything.
   *
   * Everything above the write points is already read-only: an R2 read and a
   * vision call per photo. `dryRun` stops the function there and reports what
   * the write half WOULD have done, so a stored attachment can be replayed as a
   * test without staging a booth, attaching a gallery photo, or flipping
   * `flagged_for_review` on a live row.
   *
   * It is a real exercise of the pipeline, not a simulation of one — the same
   * bytes, the same model, the same dispositions. Only the writes are withheld.
   */
  dryRun?: boolean;
  /**
   * OPE-1697 — the fair this upload is attributed to was NOT explicitly chosen
   * and its location is near more than one same-day fair. Every would-write is
   * STAGED instead (stage kind `event_choice_ambiguous`, carrying this reason),
   * whatever PHOTO_AUTOWRITE_ENABLED says: an auto-write here would put vendors
   * on a roster on the strength of a nearest-pin guess.
   */
  holdAutoWriteReason?: string | null;
  /**
   * OPE-1705 slice 3 — what the photographer said about a card. `addAsVendor`:
   * an unmatched, legibly-named card creates a vendor (still behind
   * PHOTO_AUTOWRITE_ENABLED and any hold). `metAtEventId`: "Met them at…", the
   * event an event-less card's vendor is linked to. Absent = unticked, no link.
   */
  cardIntent?: { addAsVendor: boolean; metAtEventId: string | null };
}

/**
 * `eventId` null = an EVENT-LESS run (OPE-1705 slice 3). Only business cards
 * are processed in one: if any photo is not a card, the run writes nothing and
 * returns `notCards`, and the caller takes the ordinary fair-resolving path.
 */
export async function runBoothPipeline(
  env: BoothPipelineEnv,
  db: Db,
  inboundEmailId: string,
  eventId: string | null,
  photos: PipelinePhoto[],
  options: BoothPipelineOptions = {}
): Promise<BoothPipelineResult> {
  const empty: BoothPipelineResult = {
    examined: 0,
    staged: 0,
    performerStaged: 0,
    performersConfirmed: [],
    signageRecorded: 0,
    skipped: 0,
    identifiedNames: [],
    galleryAttached: 0,
    galleryFailed: 0,
    autoWritten: [],
    visionFailures: [],
  };

  // OPE-6 gate — default OFF, and say so rather than no-op silently.
  if (env.PHOTO_VISION_ENABLED !== "true") {
    return {
      ...empty,
      disabledReason:
        'PHOTO_VISION_ENABLED is not "true" — booth identification is off. Nothing was examined.',
    };
  }
  if (!env.AI || !env.VENDOR_ASSETS) {
    return { ...empty, disabledReason: "AI or R2 binding unavailable" };
  }

  const bucket = env.VENDOR_ASSETS;
  const ai = env.AI;
  const results: Array<{ photo: PipelinePhoto; d: Disposition; card?: CardReading }> = [];

  for (const photo of photos.slice(0, MAX_PHOTOS_PER_EMAIL)) {
    // OPE-978 — a photo that cannot be read or identified still gets a
    // disposition: an `unclear` stage carrying WHY. Both branches below used to
    // `continue`, which dropped the photo with no row and no reason.
    try {
      const obj = await bucket.get(photo.key);
      if (!obj) {
        results.push({ photo, d: disposition(unidentified(`r2-object-missing key=${photo.key}`)) });
        continue;
      }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const id = await identifyBooth(ai, bytes);
      let d = disposition(id);
      // OPE-240 — booth / not-booth. Asked only of a photo that would publish,
      // so it costs one call per would-write and nothing on the rest.
      if (d.action === "write" && id.businessName) {
        d = applyPresenceGate(d, await checkBoothPresence(ai, bytes, id.businessName));
      }
      // OPE-1705 — a card's fields come from a second, focused read.
      if (d.action === "card") {
        results.push({ photo, d, card: await readBusinessCard(ai, bytes) });
        continue;
      }
      results.push({ photo, d });
    } catch (e) {
      // One unreadable photo must not sink the batch — and must not vanish.
      results.push({
        photo,
        d: disposition(
          unidentified(`pipeline-threw: ${e instanceof Error ? e.message : String(e)}`)
        ),
      });
    }
  }

  // OPE-1705 slice 3 — an event-less run handles cards only. Anything else
  // needs a fair, so nothing is written and the caller resolves one as usual.
  if (eventId === null) {
    const notCards = results.filter((r) => r.d.action !== "card").length;
    if (notCards > 0 || results.length === 0) {
      return {
        ...empty,
        examined: results.length,
        notCards,
        visionFailures: results
          .map((r) => r.d.identification.failureReason)
          .filter((f): f is string => Boolean(f)),
      };
    }
  }
  // Non-null wherever a booth, performer or gallery photo is handled: an
  // event-less run returned above unless every photo is a card.
  const fairId = eventId as string;

  // OPE-969 — resolve performer photos against the performer table and THIS
  // event's roster. Reads only, so it runs before the dry-run boundary and a
  // replay reports the same outcome a live run would act on.
  type Staged = {
    photo: PipelinePhoto;
    id: BoothIdentification;
    action: string;
    stageKind: StageKind | null;
    reason: string | null;
    wouldAutoWrite: boolean;
    performer?: { id: string | null; name: string | null; appearancesOnEvent: number };
    /** Set when the model said booth and the roster said performer. */
    reclassifiedFrom?: "booth";
    /** OPE-1694 — what the sign's domain matched, when it carried one. */
    domainMatch?: DomainVendorMatch;
  };
  const holdReason = options.holdAutoWriteReason ?? null;
  const autoWriteOn = env.PHOTO_AUTOWRITE_ENABLED === "true" && !holdReason;
  const staged: Staged[] = [];
  const confirmed: Array<{
    photo: PipelinePhoto;
    performerId: string;
    performerName: string;
    appearancesOnEvent: number;
    reclassifiedFrom?: "booth";
  }> = [];
  const toAutoWrite: typeof results = [];
  /** OPE-1694 — per photo key, the domain match of a booth whose sign carried one. */
  const domainMatches = new Map<string, DomainVendorMatch>();

  for (const r of results) {
    let d: Disposition = r.d;
    let reclassifiedFrom: "booth" | undefined;

    // OPE-969 — ROSTER FIRST, whatever the model called the photo. Measured on
    // the Waterford specimen itself: the Axe Women truck came back as a BOOTH
    // named "AxeWomen" at confidence 1, which is a vendor proposal today and a
    // created vendor once auto-write is on. A booth name that matches an act
    // already on this event's lineup is that act.
    const boothName = d.identification.kind === "booth" ? d.identification.businessName : null;
    // OPE-1339 — never for a salvaged read: it is staged as read, whatever it names.
    if (boothName && !d.identification.salvaged && (d.action === "write" || d.action === "stage")) {
      try {
        if (await matchRosterPerformer(db, fairId, boothName)) {
          d = {
            action: "performer",
            identification: {
              ...d.identification,
              kind: "performer",
              performerName: boothName,
              businessName: null,
              products: [],
            },
          };
          reclassifiedFrom = "booth";
        }
      } catch (e) {
        // The check that keeps an act out of the vendor table failed, so this
        // photo must not auto-write on the strength of not having been checked.
        if (d.action === "write") {
          d = {
            action: "stage",
            identification: d.identification,
            reason:
              `roster check failed — not auto-written: ${e instanceof Error ? e.message : String(e)}`.slice(
                0,
                200
              ),
            stageKind: "booth_roster_check_failed",
          };
        }
      }
    }

    // OPE-1694 — the sign's web address, checked against existing vendors. A
    // read, so it runs before the dry-run boundary. One owner: the write links
    // that vendor (createOrLinkVendor repeats this check and owns the link).
    // Several: a person picks, so a would-write stages instead.
    if (
      d.identification.kind === "booth" &&
      d.identification.businessName &&
      (d.action === "write" || d.action === "stage")
    ) {
      const sd = extractSignDomain(d.identification.businessName, d.identification.website);
      if (sd.domain) {
        try {
          const dm = await resolveVendorBySignDomain(db as unknown as VendorLinkDb, sd);
          domainMatches.set(r.photo.key, dm);
          if (dm.kind === "ambiguous" && d.action === "write") {
            d = {
              action: "stage",
              identification: d.identification,
              reason: `${dm.reason} — which one is this booth?`.slice(0, 200),
              stageKind: "booth_domain_ambiguous",
            };
          }
        } catch (e) {
          if (d.action === "write") {
            d = {
              action: "stage",
              identification: d.identification,
              reason:
                `domain check failed — not auto-written: ${e instanceof Error ? e.message : String(e)}`.slice(
                  0,
                  200
                ),
              stageKind: "booth_domain_check_failed",
            };
          }
        }
      }

      // OPE-1695 — a would-write that CREATES a vendor needs evidence beyond
      // the name: a web address, or products that are not an echo of it. A
      // link to an existing vendor (by domain or by name) is unaffected. The
      // name lookup is the same fuzzy match createOrLinkVendor will run, on the
      // same domain-cleaned name, so "would create" here means create there.
      if (d.action === "write" && domainMatches.get(r.photo.key)?.kind !== "one") {
        const id = d.identification;
        const name = sd.cleanedName ?? id.businessName ?? "";
        try {
          const existing = await findFuzzyMatch(db as unknown as VendorLinkDb, name, null);
          const corroborated =
            (sd.domain !== null && !sd.nonOwnable) || hasIndependentProducts(name, id.products);
          if (!existing && !corroborated) {
            d = {
              action: "stage",
              identification: id,
              reason: `would create new vendor "${name}" with nothing but its name to back it (no web address, no products)`,
              stageKind: "booth_new_vendor_uncorroborated",
            };
          }
        } catch (e) {
          d = {
            action: "stage",
            identification: id,
            reason:
              `vendor lookup failed — not auto-written: ${e instanceof Error ? e.message : String(e)}`.slice(
                0,
                200
              ),
            stageKind: "booth_vendor_check_failed",
          };
        }
      }
    }

    if (d.action === "write") {
      // Milestone B split: auto-written when the gate is on; otherwise staged
      // exactly as Milestone A did, marked as a would-have-written.
      if (autoWriteOn) toAutoWrite.push(r);
      else
        staged.push({
          photo: r.photo,
          id: d.identification,
          action: BOOTH_PROPOSED_ACTION,
          stageKind: holdReason ? "event_choice_ambiguous" : null,
          reason: holdReason,
          wouldAutoWrite: true,
          domainMatch: domainMatches.get(r.photo.key),
        });
    } else if (d.action === "stage") {
      staged.push({
        photo: r.photo,
        id: d.identification,
        action:
          d.identification.kind === "performer" ? PERFORMER_PROPOSED_ACTION : BOOTH_PROPOSED_ACTION,
        stageKind: d.stageKind,
        reason: d.reason,
        wouldAutoWrite: false,
        domainMatch: domainMatches.get(r.photo.key),
      });
    } else if (d.action === "performer") {
      try {
        const res = await resolvePerformerPhoto(db, fairId, d.identification);
        if (res.outcome === "confirmed") {
          confirmed.push({
            photo: r.photo,
            performerId: res.performerId,
            performerName: res.performerName,
            appearancesOnEvent: res.appearancesOnEvent,
            reclassifiedFrom,
          });
        } else {
          staged.push({
            photo: r.photo,
            id: d.identification,
            action: PERFORMER_PROPOSED_ACTION,
            stageKind: res.stageKind,
            reason: res.reason,
            wouldAutoWrite: false,
            performer: {
              id: res.performerId,
              name: res.performerName,
              appearancesOnEvent: res.appearancesOnEvent,
            },
            reclassifiedFrom,
          });
        }
      } catch (e) {
        // Fail-soft like every photo step: a lookup fault stages, never writes.
        staged.push({
          photo: r.photo,
          id: d.identification,
          action: PERFORMER_PROPOSED_ACTION,
          stageKind: "performer_unmatched",
          reason: `performer lookup failed: ${e instanceof Error ? e.message : String(e)}`.slice(
            0,
            200
          ),
          wouldAutoWrite: false,
        });
      }
    }
  }

  // OPE-1705 — resolve each card against existing vendors. Reads only, so it
  // runs before the dry-run boundary: a replay reports what a live run would do.
  type CardOutcome =
    | {
        kind: "match";
        photo: PipelinePhoto;
        card: CardReading;
        vendorId: string;
        vendorName: string;
        matchBasis: "domain" | "name";
        plans: CardFieldPlan[];
      }
    | {
        kind: "stage";
        photo: PipelinePhoto;
        card: CardReading;
        stageKind: CardStageKind;
        reason: string;
        domainCandidates?: Array<{ id: string; businessName: string }>;
      }
    | {
        /** Slice 3 — unmatched + legible + "Add as vendor" ticked + auto-write open. */
        kind: "create";
        photo: PipelinePhoto;
        card: CardReading;
        businessName: string;
      };
  const cardOutcomes: CardOutcome[] = [];
  const addAsVendor = options.cardIntent?.addAsVendor === true;
  // The event a card's vendor is linked to: the fair this run resolved, else
  // "Met them at…" (only an event-less card carries one).
  const metAtEventId = eventId === null ? (options.cardIntent?.metAtEventId ?? null) : null;
  const cardLinkEventId = eventId ?? metAtEventId;
  for (const r of results) {
    if (r.d.action !== "card") continue;
    const card = r.card ?? { failureReason: "card not read" };
    const stage = (
      stageKind: CardStageKind,
      reason: string,
      extra: Partial<Extract<CardOutcome, { kind: "stage" }>> = {}
    ) => cardOutcomes.push({ kind: "stage", photo: r.photo, card, stageKind, reason, ...extra });
    const problem = cardNameProblem(card);
    try {
      // Domain first (OPE-1694), even when the name is unreadable: a card's
      // website or email host names its vendor more reliably than its lettering.
      const domains = cardDomainCandidates(card);
      const sd = extractSignDomain(card.businessName?.value ?? "", domains[0] ?? null);
      const dm = await resolveVendorBySignDomain(db as unknown as VendorLinkDb, {
        domain: sd.domain,
        candidates: [...new Set([...sd.candidates, ...domains])],
      });
      let match: { id: string; name: string; basis: "domain" | "name" } | null = null;
      if (dm.kind === "one") match = { id: dm.vendorId, name: dm.businessName, basis: "domain" };
      else if (dm.kind === "ambiguous") {
        stage("card_domain_ambiguous", `${dm.reason} — which vendor is this card?`.slice(0, 200), {
          domainCandidates: dm.candidates,
        });
        continue;
      } else if (!problem && card.businessName) {
        const v = await findStrictMatch(db as unknown as VendorLinkDb, card.businessName.value);
        if (v) match = { id: v.id, name: v.businessName, basis: "name" };
      }
      if (!match) {
        if (problem) {
          stage(
            problem,
            problem === "card_name_generic"
              ? `generic text, not a business name: "${card.businessName?.value}"`
              : problem === "card_unreadable"
                ? `the card could not be read: ${card.failureReason ?? "no fields"}`.slice(0, 200)
                : "the business name on the card is not clearly legible"
          );
        } else if (addAsVendor && autoWriteOn && card.businessName) {
          // OPE-1705 slice 3 — John ticked "Add as vendor": his say-so is the
          // evidence OPE-1695 asks a new vendor for. Only this hold is lifted —
          // an unreadable or generic name staged above, before reaching here.
          cardOutcomes.push({
            kind: "create",
            photo: r.photo,
            card,
            businessName: card.businessName.value,
          });
        } else {
          stage(
            "card_unmatched",
            addAsVendor
              ? `no existing vendor matches "${card.businessName?.value}"; "Add as vendor" was ticked but nothing auto-writes here (${holdReason ?? "PHOTO_AUTOWRITE_ENABLED is off"}) — approve to create`.slice(
                  0,
                  300
                )
              : `no existing vendor matches "${card.businessName?.value}"`
          );
        }
        continue;
      }
      const [snap] = await db
        .select({
          website: vendors.website,
          socialLinks: vendors.socialLinks,
          address: vendors.address,
          city: vendors.city,
          state: vendors.state,
          zip: vendors.zip,
          contactEmail: vendors.contactEmail,
          contactPhone: vendors.contactPhone,
          contactName: vendors.contactName,
        })
        .from(vendors)
        .where(eq(vendors.id, match.id))
        .limit(1);
      if (!snap) {
        stage("card_match_check_failed", `matched vendor ${match.id} could not be read`);
        continue;
      }
      cardOutcomes.push({
        kind: "match",
        photo: r.photo,
        card,
        vendorId: match.id,
        vendorName: match.name,
        matchBasis: match.basis,
        plans: planCardFields(card, snap, { autoWrite: autoWriteOn }),
      });
    } catch (e) {
      stage(
        "card_match_check_failed",
        `vendor match failed — nothing written: ${e instanceof Error ? e.message : String(e)}`.slice(
          0,
          200
        )
      );
    }
  }
  /** Slice 3 — "Met them at…" links landed by the write half, per card photo key. */
  const linkedByMetAt = new Map<string, string>();
  /** Slice 3 — vendors created from a card this run, filled in by the write half. */
  const createdFromCards: NonNullable<BoothPipelineResult["cards"]>["applied"] = [];
  const cardsSummary = (applied: Map<string, CardApplyResult>, dry = false) =>
    cardOutcomes.length === 0
      ? {}
      : {
          cardsHandled: cardOutcomes.length,
          cards: {
            applied: [
              ...cardOutcomes.flatMap((c) =>
                c.kind !== "match"
                  ? []
                  : [
                      {
                        vendorId: c.vendorId,
                        vendorName: c.vendorName,
                        matchBasis: c.matchBasis,
                        // Dry run: the plan; live: what actually landed.
                        written:
                          applied.get(c.photo.key)?.written ??
                          c.plans.filter((p) => p.action === "write").map((p) => p.column),
                        staged:
                          applied.get(c.photo.key)?.staged ??
                          c.plans.filter((p) => p.action === "stage").map((p) => p.column),
                        conflicts:
                          applied.get(c.photo.key)?.conflicts ??
                          c.plans.filter((p) => p.action === "conflict").map((p) => p.column),
                        ...(linkedByMetAt.has(c.photo.key)
                          ? { linkedEventId: linkedByMetAt.get(c.photo.key) }
                          : {}),
                      },
                    ]
              ),
              ...createdFromCards,
            ],
            proposed: cardOutcomes.flatMap((c) =>
              c.kind === "stage"
                ? [{ businessName: c.card.businessName?.value ?? null, stageKind: c.stageKind }]
                : []
            ),
            // Slice 3 — a dry run names the vendors a live run would create.
            ...(dry && cardOutcomes.some((c) => c.kind === "create")
              ? {
                  wouldCreate: cardOutcomes.flatMap((c) =>
                    c.kind === "create" ? [c.businessName] : []
                  ),
                }
              : {}),
          },
        };

  const scenery = results.filter((r) => r.d.action === "skip");
  const signage = results.filter((r) => r.d.action === "record");
  const boothStaged = staged.filter((x) => x.action === BOOTH_PROPOSED_ACTION);
  const performerStaged = staged.length - boothStaged.length;
  const skipped = scenery.length;
  const galleryPhotos = [...scenery.map((r) => r.photo), ...confirmed.map((c) => c.photo)];
  const performersConfirmed = confirmed.map((c) => ({
    performerId: c.performerId,
    performerName: c.performerName,
    photoName: c.photo.name,
  }));
  const visionFailures = results
    .map((r) => r.d.identification.failureReason)
    .filter((f): f is string => Boolean(f));

  // OPE-469 — the dry-run boundary. Everything above this line reads (R2 +
  // vision + the performer lookup); everything below writes (auto-write,
  // admin_actions, flagged_for_review, gallery attach). Returning here is what
  // makes a replay safe to run against a live row.
  //
  // The counts reported are what the write half WOULD produce, derived from the
  // same buckets the writes use — not re-derived, so the report cannot drift
  // from the behaviour it predicts.
  if (options.dryRun) {
    return {
      examined: results.length,
      staged: boothStaged.length,
      performerStaged,
      performersConfirmed,
      signageRecorded: signage.length,
      skipped,
      identifiedNames: boothStaged
        .map((x) => x.id.businessName)
        .concat(toAutoWrite.map((r) => r.d.identification.businessName ?? ""))
        .filter((n): n is string => Boolean(n)),
      // Reported as "would attach". `attachGeneralPhotos` can still fail on a
      // real run, so this is an upper bound rather than a promise — which is
      // why a replay compares against the recorded outcome instead of asserting
      // equality with it.
      galleryAttached: galleryPhotos.length,
      galleryFailed: 0,
      autoWritten: [],
      visionFailures,
      dryRun: true,
      ...cardsSummary(new Map(), true),
      wouldAutoWrite: toAutoWrite
        .map((r) => r.d.identification.businessName)
        .filter((n): n is string => Boolean(n)),
      // Would-writes whether auto-write is on (toAutoWrite) or off (staged
      // with would_auto_write), so a replay answers the same either way.
      wouldLinkByDomain: [
        ...toAutoWrite.map((r) => ({ key: r.photo.key, id: r.d.identification })),
        ...staged.filter((x) => x.wouldAutoWrite).map((x) => ({ key: x.photo.key, id: x.id })),
      ].flatMap(({ key, id }) => {
        const dm = domainMatches.get(key);
        return dm?.kind === "one"
          ? [
              {
                businessName: id.businessName ?? "",
                domain: dm.domain,
                vendorId: dm.vendorId,
                vendorName: dm.businessName,
              },
            ]
          : [];
      }),
    };
  }

  // Auto-write first (sequential, idempotent) — see auto-write.ts. Fail-soft:
  // its failures land in the outcomes, never thrown, so staging still runs.
  let autoWritten: AutoWriteOutcome[] = [];
  if (toAutoWrite.length > 0) {
    try {
      autoWritten = await autoWriteBooths(
        env,
        db,
        inboundEmailId,
        fairId,
        toAutoWrite.map((r) => ({
          photoKey: r.photo.key,
          photoName: r.photo.name,
          id: r.d.identification,
        }))
      );
    } catch {
      autoWritten = [];
    }
  }

  const now = new Date();
  // OPE-969 — every audit row below is written once per (action, email, photo).
  // A replayed email re-classifies the same photo; it must not re-propose it.
  const record = async (action: string, photo: PipelinePhoto, payload: Record<string, unknown>) => {
    if (await alreadyLogged(db, action, inboundEmailId, photo.key)) return;
    await db.insert(adminActions).values({
      action,
      actorUserId: null,
      targetType: "inbound_email",
      targetId: inboundEmailId,
      payloadJson: JSON.stringify({
        event_id: eventId,
        photo_key: photo.key,
        photo_name: photo.name,
        ...payload,
      }),
      // admin_actions.createdAt is notNull with NO default — Drizzle won't fill
      // it. Matches the roster-detect precedent (inbound-email.ts:813).
      createdAt: now,
    } as never);
  };

  for (const x of staged) {
    const id = x.id;
    await record(x.action, x.photo, {
      // OPE-969 — what the photo IS, and a closed reason vocabulary, so "a
      // booth whose name is unreadable" and "not a booth" never share a label.
      photo_class: id.kind,
      stage_kind: x.stageKind,
      business_name: id.businessName,
      performer_name: id.performerName,
      ...(x.performer
        ? {
            performer_id: x.performer.id,
            matched_performer_name: x.performer.name,
            appearances_on_event: x.performer.appearancesOnEvent,
          }
        : {}),
      website: id.website,
      products: id.products,
      confidence: id.confidence,
      rationale: id.rationale,
      identifiable_minor: id.identifiableMinor,
      // OPE-240 — what the sign is on, when the presence check ran.
      sign_mounted_on: id.mountedOn ?? null,
      // OPE-403 follow-up — which of the five UNIDENTIFIED paths produced
      // this, when it was a failure. Absent on a successful identification.
      failure_reason: id.failureReason ?? null,
      // Milestone B WOULD have auto-written this one.
      would_auto_write: x.wouldAutoWrite,
      reclassified_from: x.reclassifiedFrom ?? null,
      stage_reason: x.reason,
      // OPE-1694 — the sign's domain and what it matched, so a reviewer sees
      // "this is Maine Cardworks Inc by its web address" rather than a new name.
      ...(x.domainMatch
        ? {
            matched_domain: x.domainMatch.domain,
            match_basis: x.domainMatch.kind === "one" ? "domain" : null,
            matched_vendor_id: x.domainMatch.kind === "one" ? x.domainMatch.vendorId : null,
            matched_vendor_name: x.domainMatch.kind === "one" ? x.domainMatch.businessName : null,
            domain_candidates:
              x.domainMatch.kind === "ambiguous" ? x.domainMatch.candidates : undefined,
          }
        : {}),
    });
  }

  for (const c of confirmed) {
    await record(PERFORMER_CONFIRMED_ACTION, c.photo, {
      photo_class: "performer",
      performer_id: c.performerId,
      performer_name: c.performerName,
      appearances_on_event: c.appearancesOnEvent,
      reclassified_from: c.reclassifiedFrom ?? null,
      // Recorded, never acted on: no path sets a hero from a photo.
      hero_candidate: true,
    });
  }

  for (const r of signage) {
    const id = r.d.identification;
    await record(SIGNAGE_RECORDED_ACTION, r.photo, {
      photo_class: "signage",
      sign_text: id.signText,
      confidence: id.confidence,
      rationale: id.rationale,
    });
  }

  // OPE-1705 — cards. A matched card's plan is applied (blank-fill + staged
  // candidates); everything else is a proposal for a person. No image is
  // written on this path at all.
  const cardApplied = new Map<string, CardApplyResult>();
  for (const c of cardOutcomes) {
    const fields = cardFieldsPayload(c.card);
    if (c.kind === "create") {
      if (await alreadyLogged(db, CARD_APPLIED_ACTION, inboundEmailId, c.photo.key)) continue;
      const made = await createVendorFromCard(db, {
        businessName: c.businessName,
        website: c.card.website?.value ?? null,
        linkEventId: cardLinkEventId,
      });
      if (!made.ok || !made.vendorId) {
        await record(CARD_PROPOSED_ACTION, c.photo, {
          photo_class: "business_card",
          stage_kind: "card_unmatched",
          stage_reason:
            `"Add as vendor" was ticked but the create failed — nothing written: ${made.error ?? "unknown"}`.slice(
              0,
              300
            ),
          business_name: c.businessName,
          website: c.card.website?.value ?? null,
          add_as_vendor: true,
          auto_write: autoWriteOn,
          card: fields,
        });
        continue;
      }
      // The new row's columns are what the create stored (name, website), so
      // the card's remaining fields plan against the row as it now is — the
      // same blank-fill + private-staging rule a matched card gets.
      let res: CardApplyResult = { written: [], staged: [], conflicts: [], alreadyPending: [] };
      let applyError: string | null = null;
      try {
        const [snap] = await db
          .select({
            website: vendors.website,
            socialLinks: vendors.socialLinks,
            address: vendors.address,
            city: vendors.city,
            state: vendors.state,
            zip: vendors.zip,
            contactEmail: vendors.contactEmail,
            contactPhone: vendors.contactPhone,
            contactName: vendors.contactName,
          })
          .from(vendors)
          .where(eq(vendors.id, made.vendorId))
          .limit(1);
        if (snap) {
          res = await applyCardPlan(
            db,
            made.vendorId,
            planCardFields(c.card, snap, { autoWrite: autoWriteOn }),
            {
              sourceRef: `inbound-email:${inboundEmailId}#${c.photo.key}`,
              jobRunId: `card-${inboundEmailId}`,
            }
          );
        }
      } catch (e) {
        applyError = `fields not applied: ${e instanceof Error ? e.message : String(e)}`.slice(
          0,
          200
        );
      }
      cardApplied.set(c.photo.key, res);
      createdFromCards.push({
        vendorId: made.vendorId,
        vendorName: made.vendorName,
        matchBasis: "created",
        written: res.written,
        staged: res.staged,
        conflicts: res.conflicts,
        linkedEventId: made.linkedEventId,
      });
      await record(CARD_APPLIED_ACTION, c.photo, {
        photo_class: "business_card",
        vendor_id: made.vendorId,
        vendor_name: made.vendorName,
        match_basis: "created",
        created: made.created,
        linked_event_id: made.linkedEventId,
        written: res.written,
        staged: res.staged,
        conflicts: res.conflicts,
        already_pending: res.alreadyPending,
        ...(applyError ? { apply_error: applyError } : {}),
        add_as_vendor: true,
        auto_write: autoWriteOn,
        card: fields,
      });
      continue;
    }
    if (c.kind === "match") {
      if (await alreadyLogged(db, CARD_APPLIED_ACTION, inboundEmailId, c.photo.key)) continue;
      let res: CardApplyResult;
      try {
        res = await applyCardPlan(db, c.vendorId, c.plans, {
          sourceRef: `inbound-email:${inboundEmailId}#${c.photo.key}`,
          jobRunId: `card-${inboundEmailId}`,
        });
      } catch (e) {
        await record(CARD_PROPOSED_ACTION, c.photo, {
          photo_class: "business_card",
          stage_kind: "card_match_check_failed",
          stage_reason: `apply failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
          business_name: c.card.businessName?.value ?? null,
          matched_vendor_id: c.vendorId,
          card: fields,
        });
        continue;
      }
      cardApplied.set(c.photo.key, res);
      // Slice 3 — "Met them at…" on an event-less card links its vendor. Same
      // gate as every other write in this lane.
      let metAt: { linked_event_id: string | null; link_error?: string } | null = null;
      if (metAtEventId) {
        if (autoWriteOn) {
          const l = await linkCardVendorToEvent(db, {
            vendorId: c.vendorId,
            vendorName: c.vendorName,
            eventId: metAtEventId,
          });
          metAt = l.ok
            ? { linked_event_id: metAtEventId }
            : { linked_event_id: null, link_error: l.error };
          if (l.ok) linkedByMetAt.set(c.photo.key, metAtEventId);
        } else {
          metAt = { linked_event_id: null, link_error: "auto-write is off; not linked" };
        }
      }
      await record(CARD_APPLIED_ACTION, c.photo, {
        photo_class: "business_card",
        vendor_id: c.vendorId,
        vendor_name: c.vendorName,
        match_basis: c.matchBasis,
        ...(metAt ? { met_at_event_id: metAtEventId, ...metAt } : {}),
        add_as_vendor: addAsVendor,
        written: res.written,
        staged: res.staged,
        conflicts: res.conflicts,
        already_pending: res.alreadyPending,
        auto_write: autoWriteOn,
        card: fields,
      });
    } else {
      await record(CARD_PROPOSED_ACTION, c.photo, {
        photo_class: "business_card",
        stage_kind: c.stageKind,
        stage_reason: c.reason,
        business_name: c.card.businessName?.value ?? null,
        website: c.card.website?.value ?? null,
        failure_reason: c.card.failureReason ?? null,
        // Slice 3 — John's intent, shown to the reviewer.
        add_as_vendor: addAsVendor,
        ...(metAtEventId ? { met_at_event_id: metAtEventId } : {}),
        // Slice 2 — a later pairing writes only when the card's run could.
        auto_write: autoWriteOn,
        ...(c.domainCandidates ? { domain_candidates: c.domainCandidates } : {}),
        card: fields,
      });
    }
  }
  // OPE-1705 slice 2 — pair cards with booths. The booth side looks FORWARD
  // for cards that finished first; the card side looks BACK. Both go through
  // the one idempotent pairCardRow, so whichever run is second pairs them.
  const cardPairings: PairingOutcome[] = [];
  try {
    const boothsHere = boothStaged.length + autoWritten.filter((a) => a.vendorId).length;
    if (boothsHere > 0 && eventId) {
      const [me] = await db
        .select({
          fromAddress: inboundEmails.fromAddress,
          receivedAt: inboundEmails.receivedAt,
          captureMeta: inboundEmails.captureMeta,
        })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, inboundEmailId))
        .limit(1);
      if (me?.fromAddress) {
        const later = await laterCardRows(db, {
          uploader: me.fromAddress,
          eventId,
          boothAt: shotAt(me.captureMeta, me.receivedAt),
          windowMs: pairWindowMs(env),
        });
        for (const id of later) {
          const o = await pairCardRow(env, db, id, now);
          if (o) cardPairings.push(o);
        }
      }
    }
    // An event-less card has no booth to pair with (pairing is same-event).
    if (cardOutcomes.length > 0 && eventId) {
      for (const id of await cardRowsForEmail(db, inboundEmailId)) {
        const o = await pairCardRow(env, db, id, now);
        if (o) cardPairings.push(o);
      }
    }
  } catch (e) {
    // Fail-soft: a pairing fault must not cost the email its staging.
    cardPairings.push({
      cardPhotoKey: "",
      boothEmailId: "",
      boothPhotoKey: "",
      boothBusinessName: null,
      pairing: "order_only",
      basis: null,
      effect: "recorded",
      vendorId: null,
      error: `pairing failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
    });
  }

  const cardNeedsReview =
    cardOutcomes.some((c) => c.kind === "stage") ||
    [...cardApplied.values()].some(
      (r) => r.staged.length + r.conflicts.length + r.alreadyPending.length > 0
    );

  if (staged.length > 0 || cardNeedsReview) {
    await db
      .update(inboundEmails)
      .set({ flaggedForReview: 1 })
      .where(eq(inboundEmails.id, inboundEmailId));
  }

  // OPE-205 §3 — scenery, plus OPE-969's confirmed performer photos, go to the
  // resolved event's gallery. Re-attaching the same bytes converges on the
  // existing row (OPE-686 content digest), so a replay does not duplicate it.
  // Fail-soft: this must never cost us the staging or the fair match.
  const gallery = { attached: 0, failed: 0, held: 0 };
  const confirmedKeys = new Set(confirmed.map((c) => c.photo.key));
  for (const p of galleryPhotos) {
    // One photo at a time so each gets its own outcome (≤5 per email).
    let one: { attached: number; failed: number; failures?: string[]; disabledReason?: string };
    if (holdReason) {
      // OPE-1697 — a public gallery photo on a guessed fair is the same harm
      // as a guessed vendor link. Recorded, not attached.
      gallery.held += 1;
      if (!confirmedKeys.has(p.key)) {
        await record(GALLERY_ATTACHED_ACTION, p, {
          photo_class: "scenery",
          attached: false,
          failure: `held: ${holdReason}`,
        });
      }
      continue;
    }
    try {
      one = await attachGeneralPhotos(env, fairId, [p]);
    } catch (e) {
      one = {
        attached: 0,
        failed: 1,
        failures: [`threw:${e instanceof Error ? e.message : String(e)}`],
      };
    }
    gallery.attached += one.attached;
    gallery.failed += one.failed;
    // OPE-978 — scenery's decision row. A confirmed performer photo already has
    // its own (performer.photo_confirmed), so it is not recorded twice.
    if (!confirmedKeys.has(p.key)) {
      await record(GALLERY_ATTACHED_ACTION, p, {
        photo_class: "scenery",
        attached: one.attached > 0,
        failure: one.failures?.[0] ?? one.disabledReason ?? null,
      });
    }
  }

  return {
    examined: results.length,
    staged: boothStaged.length,
    performerStaged,
    performersConfirmed,
    signageRecorded: signage.length,
    skipped,
    identifiedNames: [
      ...boothStaged.map((x) => x.id.businessName),
      ...autoWritten.map((a) => a.businessName),
    ].filter((n): n is string => Boolean(n)),
    galleryAttached: gallery.attached,
    galleryFailed: gallery.failed,
    ...(holdReason ? { galleryHeld: gallery.held } : {}),
    autoWritten,
    ...cardsSummary(cardApplied),
    ...(cardPairings.length ? { cardPairings } : {}),
    // Named per photo so one bad frame in a batch is distinguishable from a
    // systemic failure (e.g. every photo returning `ai-run-threw`).
    visionFailures,
  };
}

/**
 * OPE-1705 — the card as read, for the audit row a reviewer works from. Private
 * (admin_actions is admin-only); this is where the contact values live until a
 * person approves the matching enrichment candidate.
 */
function cardFieldsPayload(card: CardReading): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(card)) {
    if (k === "failureReason" || !f || typeof f !== "object") continue;
    const field = f as { value: unknown; confidence: number };
    out[k] = { value: field.value, confidence: field.confidence };
  }
  return out;
}

/** OPE-969 — has this exact (action, email, photo) already been recorded? */
async function alreadyLogged(
  db: Db,
  action: string,
  inboundEmailId: string,
  photoKey: string
): Promise<boolean> {
  const rows = await db
    .select({ id: adminActions.id })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, action),
        eq(adminActions.targetId, inboundEmailId),
        sql`json_extract(${adminActions.payloadJson}, '$.photo_key') = ${photoKey}`
      )
    )
    .limit(1);
  return rows.length > 0;
}
