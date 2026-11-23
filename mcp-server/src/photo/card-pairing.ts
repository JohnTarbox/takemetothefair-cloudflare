/**
 * OPE-1705 slice 2 — pair a business card with the booth shot just before it.
 *
 * John shoots a booth, then that vendor's card, then moves on. Each Snap shot is
 * its OWN `inbound_emails` row with its own Workflow run, so "the booth before
 * this card" is a question across rows, and the two runs can finish in either
 * order (an offline queue flushing both at once is the usual case at a
 * fairground). So pairing is ONE idempotent function, `pairCardRow`, called by:
 *   - the card's run, looking BACK for its booth; and
 *   - the booth's run, looking FORWARD for cards that finished first.
 * Whichever finishes second makes the pairing. A `vendor.card_paired` row
 * (target = the card's inbound row, which is indexed) stops it happening twice,
 * and a booth already paired to one card is never paired to another.
 *
 * ── Which booth ───────────────────────────────────────────────────────────
 * Same uploader (`inbound_emails.from_address` — the admin account for a snap,
 * the sender for email), same event, shot within the window BEFORE the card
 * (default 10 min, `CARD_PAIR_WINDOW_MINUTES`). The nearest one wins. Shot time
 * is the phone's `capture_meta.captured_at`, falling back to `received_at`;
 * inside one email, attachment order decides.
 *
 * ── What a pairing does ───────────────────────────────────────────────────
 *  - `confirmed` — the card's name, domain or matched vendor agrees with the
 *    booth's. The card's fields go to the booth's vendor (the same blank-fill +
 *    staging plan as slice 1, ruling (a)). A booth that staged ONLY for lack of
 *    corroboration (OPE-1695) is written now: the card's own web address is the
 *    evidence that rule asks for. Same shared write tail as every auto-write.
 *  - `unreadable_booth` — the booth staged as `booth_name_unreadable`; the
 *    card's legible name identifies it. The booth stays staged for a person, but
 *    is now named, and `review_photo_proposal` approves it under that name.
 *  - `order_only` — timing fits, nothing agrees. Recorded; nothing is written on
 *    the strength of the pairing (a card's OWN domain/name match still applies).
 *  - no booth in the window — nothing is recorded; the card is "card only".
 *
 * Never on a dry run: a replay classifies; it does not pair.
 */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { extractSignDomain } from "@takemetothefair/vendor-linking";
import { adminActions, inboundEmails, vendors } from "../schema.js";
import type { Db } from "../db.js";
import { parseCaptureMeta } from "./snap-intake.js";
import {
  CARD_FIELD_CONFIDENCE,
  applyCardPlan,
  cardDomainCandidates,
  cardFromPayload,
  cardNameProblem,
  planCardFields,
  type CardApplyResult,
  type CardReading,
} from "./business-card.js";
import { BOOTH_AUTOWRITTEN_ACTION, autoWriteBooths, type AutoWriteEnv } from "./auto-write.js";

export const CARD_PAIRED_ACTION = "vendor.card_paired";
/**
 * Mirrored, NOT imported: booth-pipeline imports this module, and repoint.ts
 * imports booth-pipeline and builds top-level values from its constants — so an
 * import of either here closes a cycle that leaves repoint's constants
 * undefined (measured: 3 repoint tests failed when this file imported repoint).
 * A test pins each mirror to its source.
 */
const PHOTO_RESOLVED_ACTION = "vendor.photo_resolved";
const BOOTH_PROPOSED = "vendor.photo_proposed";
const CARD_APPLIED = "vendor.card_applied";
const CARD_PROPOSED = "vendor.card_proposed";

export const DEFAULT_CARD_PAIR_WINDOW_MINUTES = 10;

export interface CardPairingEnv extends AutoWriteEnv {
  PHOTO_AUTOWRITE_ENABLED?: string;
  /** Minutes before a card that its booth may have been shot. 1–120; default 10. */
  CARD_PAIR_WINDOW_MINUTES?: string;
}

export function pairWindowMs(env: Pick<CardPairingEnv, "CARD_PAIR_WINDOW_MINUTES">): number {
  const n = Number(env.CARD_PAIR_WINDOW_MINUTES);
  const min =
    Number.isFinite(n) && n >= 1 && n <= 120 ? Math.floor(n) : DEFAULT_CARD_PAIR_WINDOW_MINUTES;
  return min * 60_000;
}

export type PairingKind = "confirmed" | "order_only" | "unreadable_booth";
export type PairingBasis = "vendor" | "domain" | "name" | null;

export interface BoothRef {
  actionId: string;
  action: string;
  emailId: string;
  photoKey: string;
  photoName: string;
  businessName: string | null;
  website: string | null;
  products: string[];
  stageKind: string | null;
  /** The booth's vendor: auto-written, approved, or domain-matched. */
  vendorId: string | null;
  at: number;
  index: number;
}

export interface CardRef {
  actionId: string;
  action: string;
  emailId: string;
  photoKey: string;
  eventId: string;
  uploader: string;
  card: CardReading;
  /** The vendor the card matched on its own (slice 1), if any. */
  vendorId: string | null;
  /** Was auto-write open for the card's run (gate on, no fair-choice hold)? */
  autoWrite: boolean;
  at: number;
  index: number;
}

/** Attachment index from `inbound-attachments/<row>/<i>-name`, or 0. */
export function photoIndex(key: string): number {
  const m = key.match(/\/(\d+)-[^/]*$/);
  return m ? Number(m[1]) : 0;
}

/** When the shot was taken: the phone's capture time, else when it arrived. */
export function shotAt(captureMeta: string | null, receivedAt: Date | number | null): number {
  const cap = parseCaptureMeta(captureMeta)?.captured_at;
  const ms = cap ? Date.parse(cap) : NaN;
  if (Number.isFinite(ms)) return ms;
  if (receivedAt instanceof Date) return receivedAt.getTime();
  return typeof receivedAt === "number" ? receivedAt * 1000 : 0;
}

/** Lower-cased letters and digits only, "&" read as "and". */
export function pairName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function host(v: string | null | undefined): string | null {
  if (!v) return null;
  const h = v
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
  return h || null;
}

/** Does the card agree with the booth? Pure. */
export function classifyPairing(
  card: Pick<CardRef, "card" | "vendorId">,
  booth: Pick<BoothRef, "businessName" | "website" | "stageKind" | "vendorId">
): { kind: PairingKind; basis: PairingBasis } {
  if (card.vendorId && booth.vendorId && card.vendorId === booth.vendorId) {
    return { kind: "confirmed", basis: "vendor" };
  }
  const bh = host(booth.website) ?? host(extractSignDomain(booth.businessName, null).domain);
  if (bh && cardDomainCandidates(card.card).some((d) => host(d) === bh)) {
    return { kind: "confirmed", basis: "domain" };
  }
  const bn = pairName(booth.businessName);
  if (bn && bn === pairName(card.card.businessName?.value)) {
    return { kind: "confirmed", basis: "name" };
  }
  if (
    !booth.businessName &&
    booth.stageKind === "booth_name_unreadable" &&
    cardNameProblem(card.card) === null
  ) {
    return { kind: "unreadable_booth", basis: null };
  }
  return { kind: "order_only", basis: null };
}

function parse(raw: string | null): Record<string, unknown> {
  try {
    const p = JSON.parse(raw ?? "{}") as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Booth audit rows already taken by a card, among `boothActionIds`. */
async function pairedBoothIds(db: Db, boothActionIds: string[], since: Date): Promise<Set<string>> {
  if (boothActionIds.length === 0) return new Set();
  const rows = await db
    .select({ payloadJson: adminActions.payloadJson })
    .from(adminActions)
    .where(and(eq(adminActions.action, CARD_PAIRED_ACTION), gte(adminActions.createdAt, since)));
  const want = new Set(boothActionIds);
  const out = new Set<string>();
  for (const r of rows) {
    const id = s(parse(r.payloadJson).booth_action_id);
    if (id && want.has(id)) out.add(id);
  }
  return out;
}

/** The nearest unpaired booth shot within the window before `card`. */
export async function findBoothForCard(
  db: Db,
  card: CardRef,
  windowMs: number
): Promise<BoothRef | null> {
  // received_at bounds are loose (a phone can upload late); the shot time is
  // checked exactly below.
  const lo = new Date(card.at - windowMs - 6 * 3_600_000);
  const hi = new Date(card.at + 6 * 3_600_000);
  const rows = await db
    .select({
      id: adminActions.id,
      action: adminActions.action,
      emailId: adminActions.targetId,
      payloadJson: adminActions.payloadJson,
      receivedAt: inboundEmails.receivedAt,
      captureMeta: inboundEmails.captureMeta,
    })
    .from(adminActions)
    .innerJoin(inboundEmails, eq(inboundEmails.id, adminActions.targetId))
    .where(
      and(
        eq(adminActions.targetType, "inbound_email"),
        inArray(adminActions.action, [BOOTH_PROPOSED, BOOTH_AUTOWRITTEN_ACTION]),
        eq(inboundEmails.fromAddress, card.uploader),
        gte(inboundEmails.receivedAt, lo),
        lte(inboundEmails.receivedAt, hi),
        sql`json_extract(${adminActions.payloadJson}, '$.event_id') = ${card.eventId}`
      )
    );

  const booths: BoothRef[] = [];
  for (const r of rows) {
    const p = parse(r.payloadJson);
    if (r.action === BOOTH_PROPOSED && p.photo_class !== "booth") continue;
    const photoKey = s(p.photo_key);
    if (!photoKey || !r.emailId) continue;
    const at = shotAt(r.captureMeta, r.receivedAt);
    const index = photoIndex(photoKey);
    if (r.emailId === card.emailId) {
      if (index >= card.index) continue; // same email: only an EARLIER attachment
    } else if (at > card.at || at < card.at - windowMs) continue;
    booths.push({
      actionId: r.id,
      action: r.action,
      emailId: r.emailId,
      photoKey,
      photoName: s(p.photo_name) ?? photoKey.split("/").pop() ?? photoKey,
      businessName: s(p.business_name),
      website: s(p.website) ?? s(p.matched_domain),
      products: Array.isArray(p.products) ? p.products.filter((x) => typeof x === "string") : [],
      stageKind: s(p.stage_kind),
      vendorId: s(p.vendor_id) ?? s(p.matched_vendor_id),
      at,
      index,
    });
  }
  if (booths.length === 0) return null;

  const taken = await pairedBoothIds(
    db,
    booths.map((b) => b.actionId),
    new Date(card.at - windowMs - 24 * 3_600_000)
  );
  const free = booths
    .filter((b) => !taken.has(b.actionId))
    .sort((a, b) => b.at - a.at || b.index - a.index);
  const booth = free[0] ?? null;

  // A booth a person already approved has a vendor: its resolution names it.
  if (booth && !booth.vendorId && booth.action === BOOTH_PROPOSED) {
    const [res] = await db
      .select({ payloadJson: adminActions.payloadJson })
      .from(adminActions)
      .where(
        and(
          eq(adminActions.action, PHOTO_RESOLVED_ACTION),
          eq(adminActions.targetType, "admin_action"),
          eq(adminActions.targetId, booth.actionId)
        )
      )
      .limit(1);
    if (res) booth.vendorId = s(parse(res.payloadJson).vendor_id);
  }
  return booth;
}

/** Load a card audit row as a CardRef. Null when it is not a card or has no uploader. */
export async function loadCardRef(
  db: Db,
  cardActionId: string,
  env: Pick<CardPairingEnv, "PHOTO_AUTOWRITE_ENABLED">
): Promise<CardRef | null> {
  const [r] = await db
    .select({
      id: adminActions.id,
      action: adminActions.action,
      emailId: adminActions.targetId,
      payloadJson: adminActions.payloadJson,
      uploader: inboundEmails.fromAddress,
      receivedAt: inboundEmails.receivedAt,
      captureMeta: inboundEmails.captureMeta,
    })
    .from(adminActions)
    .innerJoin(inboundEmails, eq(inboundEmails.id, adminActions.targetId))
    .where(eq(adminActions.id, cardActionId))
    .limit(1);
  if (!r || !r.emailId || (r.action !== CARD_APPLIED && r.action !== CARD_PROPOSED)) return null;
  const p = parse(r.payloadJson);
  const photoKey = s(p.photo_key);
  const eventId = s(p.event_id);
  if (!photoKey || !eventId || !r.uploader) return null;
  return {
    actionId: r.id,
    action: r.action,
    emailId: r.emailId,
    photoKey,
    eventId,
    uploader: r.uploader,
    card: cardFromPayload(p.card),
    vendorId: r.action === CARD_APPLIED ? s(p.vendor_id) : null,
    // Rows written before slice 2 carry no auto_write on a proposal: read as off.
    autoWrite: env.PHOTO_AUTOWRITE_ENABLED === "true" && p.auto_write === true,
    at: shotAt(r.captureMeta, r.receivedAt),
    index: photoIndex(photoKey),
  };
}

export type PairingEffect =
  /** The card's fields went to the booth's vendor. */
  | "card_applied_to_booth_vendor"
  /** The booth staged only for lack of corroboration; the card corroborated it and it was written. */
  | "booth_written_from_card"
  /** The booth's unreadable name is now the card's. Still staged for a person. */
  | "booth_identified"
  /** Recorded; nothing written on the strength of the pairing. */
  | "recorded";

export interface PairingOutcome {
  cardPhotoKey: string;
  boothEmailId: string;
  boothPhotoKey: string;
  boothBusinessName: string | null;
  pairing: PairingKind;
  basis: PairingBasis;
  effect: PairingEffect;
  vendorId: string | null;
  card?: CardApplyResult;
  error?: string;
}

async function alreadyPaired(db: Db, card: CardRef): Promise<boolean> {
  const rows = await db
    .select({ payloadJson: adminActions.payloadJson })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, CARD_PAIRED_ACTION),
        eq(adminActions.targetType, "inbound_email"),
        eq(adminActions.targetId, card.emailId)
      )
    );
  return rows.some((r) => parse(r.payloadJson).card_photo_key === card.photoKey);
}

async function applyToVendor(db: Db, card: CardRef, vendorId: string, autoWrite: boolean) {
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
    .where(eq(vendors.id, vendorId))
    .limit(1);
  if (!snap) throw new Error(`vendor ${vendorId} not found`);
  return applyCardPlan(db, vendorId, planCardFields(card.card, snap, { autoWrite }), {
    sourceRef: `inbound-email:${card.emailId}#${card.photoKey}`,
    jobRunId: `card-${card.emailId}`,
  });
}

/**
 * Pair one card audit row with its booth, once. Returns null when there is
 * nothing to do (already paired, not a card, no uploader, or no booth in the
 * window). Fail-soft: an error lands in the outcome, never thrown.
 */
export async function pairCardRow(
  env: CardPairingEnv,
  db: Db,
  cardActionId: string,
  now: Date = new Date()
): Promise<PairingOutcome | null> {
  const card = await loadCardRef(db, cardActionId, env);
  if (!card || (await alreadyPaired(db, card))) return null;
  const windowMs = pairWindowMs(env);
  const booth = await findBoothForCard(db, card, windowMs);
  if (!booth) return null;

  const { kind, basis } = classifyPairing(card, booth);
  // A booth held on an ambiguous fair (OPE-1697) is a guess; never write from it.
  const autoWrite = card.autoWrite && booth.stageKind !== "event_choice_ambiguous";
  const out: PairingOutcome = {
    cardPhotoKey: card.photoKey,
    boothEmailId: booth.emailId,
    boothPhotoKey: booth.photoKey,
    boothBusinessName: booth.businessName,
    pairing: kind,
    basis,
    effect: kind === "unreadable_booth" ? "booth_identified" : "recorded",
    vendorId: booth.vendorId,
  };

  try {
    if (kind === "confirmed" && booth.vendorId && !card.vendorId) {
      out.card = await applyToVendor(db, card, booth.vendorId, autoWrite);
      out.effect = "card_applied_to_booth_vendor";
    } else if (
      kind === "confirmed" &&
      !booth.vendorId &&
      booth.action === BOOTH_PROPOSED &&
      booth.stageKind === "booth_new_vendor_uncorroborated" &&
      autoWrite &&
      booth.businessName &&
      card.card.website &&
      card.card.website.confidence >= CARD_FIELD_CONFIDENCE &&
      !extractSignDomain(null, card.card.website.value).nonOwnable
    ) {
      // OPE-1695 asked for evidence beyond the name; the card's own web
      // address, agreeing with the booth, is that evidence.
      const [w] = await autoWriteBooths(env, db, booth.emailId, card.eventId, [
        {
          photoKey: booth.photoKey,
          photoName: booth.photoName,
          id: {
            kind: "booth",
            businessName: booth.businessName,
            performerName: null,
            signText: null,
            website: card.card.website.value,
            products: booth.products,
            confidence: 1,
            rationale: "corroborated by the vendor's business card (OPE-1705)",
            identifiableMinor: false,
          },
        },
      ]);
      if (w?.vendorId) {
        out.vendorId = w.vendorId;
        out.effect = "booth_written_from_card";
        await db.insert(adminActions).values({
          action: PHOTO_RESOLVED_ACTION,
          actorUserId: null,
          targetType: "admin_action",
          targetId: booth.actionId,
          payloadJson: JSON.stringify({
            resolution: "approved",
            email_id: booth.emailId,
            event_id: card.eventId,
            vendor_id: w.vendorId,
            business_name: booth.businessName,
            hero_set: w.heroSet,
            was_created: w.wasCreated,
            via: "card_pairing",
            card_email_id: card.emailId,
            card_photo_key: card.photoKey,
          }),
          createdAt: now,
        } as never);
        if (!card.vendorId) out.card = await applyToVendor(db, card, w.vendorId, autoWrite);
      } else if (w?.error) {
        out.error = `booth write failed: ${w.error}`.slice(0, 200);
      }
    }
  } catch (e) {
    out.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }

  await db.insert(adminActions).values({
    action: CARD_PAIRED_ACTION,
    actorUserId: null,
    targetType: "inbound_email",
    targetId: card.emailId,
    payloadJson: JSON.stringify({
      event_id: card.eventId,
      photo_key: card.photoKey,
      card_photo_key: card.photoKey,
      card_action_id: card.actionId,
      card_email_id: card.emailId,
      booth_action_id: booth.actionId,
      booth_email_id: booth.emailId,
      booth_photo_key: booth.photoKey,
      booth_business_name: booth.businessName,
      booth_stage_kind: booth.stageKind,
      pairing: kind,
      basis,
      effect: out.effect,
      vendor_id: out.vendorId,
      // The name a person approves an unreadable booth under.
      resolved_business_name:
        kind === "unreadable_booth" ? (card.card.businessName?.value ?? null) : null,
      card_written: out.card?.written ?? [],
      card_staged: out.card?.staged ?? [],
      card_conflicts: out.card?.conflicts ?? [],
      window_minutes: windowMs / 60_000,
      ...(out.error ? { error: out.error } : {}),
    }),
    createdAt: now,
  } as never);
  return out;
}

/** The card audit rows an email produced, for its own run to pair. */
export async function cardRowsForEmail(db: Db, emailId: string): Promise<string[]> {
  const rows = await db
    .select({ id: adminActions.id })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.targetType, "inbound_email"),
        eq(adminActions.targetId, emailId),
        inArray(adminActions.action, [CARD_APPLIED, CARD_PROPOSED])
      )
    );
  return rows.map((r) => r.id);
}

/**
 * The booth run's forward look: card rows from the same uploader on the same
 * event, shot within the window AFTER `boothAt`, not yet paired. Each is then
 * paired through `pairCardRow`, which picks the card's OWN nearest booth — so a
 * card that belongs to a later booth is not stolen.
 */
export async function laterCardRows(
  db: Db,
  opts: { uploader: string; eventId: string; boothAt: number; windowMs: number }
): Promise<string[]> {
  const lo = new Date(opts.boothAt - 6 * 3_600_000);
  const hi = new Date(opts.boothAt + opts.windowMs + 6 * 3_600_000);
  const rows = await db
    .select({
      id: adminActions.id,
      receivedAt: inboundEmails.receivedAt,
      captureMeta: inboundEmails.captureMeta,
    })
    .from(adminActions)
    .innerJoin(inboundEmails, eq(inboundEmails.id, adminActions.targetId))
    .where(
      and(
        eq(adminActions.targetType, "inbound_email"),
        inArray(adminActions.action, [CARD_APPLIED, CARD_PROPOSED]),
        eq(inboundEmails.fromAddress, opts.uploader),
        gte(inboundEmails.receivedAt, lo),
        lte(inboundEmails.receivedAt, hi),
        sql`json_extract(${adminActions.payloadJson}, '$.event_id') = ${opts.eventId}`
      )
    )
    .orderBy(desc(adminActions.createdAt));
  return rows
    .filter((r) => {
      const at = shotAt(r.captureMeta, r.receivedAt);
      return at > opts.boothAt && at <= opts.boothAt + opts.windowMs;
    })
    .map((r) => r.id);
}

/**
 * Pairings recorded against proposals, keyed by the proposal's admin_actions id
 * — a booth's (`booth_action_id`) or a card's (`card_action_id`). For the
 * listing and the review tool. The first pairing wins.
 */
export async function pairingsForProposals(
  db: Db,
  proposalIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (proposalIds.length === 0) return out;
  const want = new Set(proposalIds);
  const rows = await db
    .select({ payloadJson: adminActions.payloadJson })
    .from(adminActions)
    .where(eq(adminActions.action, CARD_PAIRED_ACTION))
    .orderBy(adminActions.createdAt);
  for (const r of rows) {
    const p = parse(r.payloadJson);
    for (const id of [s(p.booth_action_id), s(p.card_action_id)]) {
      if (id && want.has(id) && !out.has(id)) out.set(id, p);
    }
  }
  return out;
}
