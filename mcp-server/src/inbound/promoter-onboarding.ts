/**
 * OPE-1608 — the promoter onboarding lane.
 *
 *   inbound  → one request row, one obligation, no ack
 *   10-min job → enrichment pass → draft → notify John → reminder → deadline fault
 *              → 7-day follow-up draft
 *
 * ── Nothing here reaches the sender ─────────────────────────────────────────
 * Every message to the organizer is a row in the operator draft queue, delivered
 * only by review_operator_draft on John's approval. The only mail this file
 * sends goes to ALERT_EMAIL_TECHNICAL.
 *
 * ── The enrichment job is the row ───────────────────────────────────────────
 * `enrichment_status='queued'` is the queue, and the ten-minute job is its consumer. A
 * step.sleep in the inbound workflow would hold a Workflow open for up to 30
 * minutes, and an EMAIL-driven queue message would need its own DLQ for a job
 * that retries on the next tick anyway.
 *
 * ── What the pass does today, and does not ──────────────────────────────────
 * It reads the org's own site and looks up the public events we already hold for
 * the org. It does NOT discover new events from that site: no such automated
 * path exists in this Worker (promoter enrichment fills promoter fields, and
 * needs a promoter row). Feed reading is OPE-1613. The draft therefore lists
 * what we hold or says plainly that we hold nothing.
 */
import { and, asc, desc, eq, gte, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  extractEmailAddress,
  isNonOwnableDomain,
  organizationalDomain,
} from "@takemetothefair/utils";
import { PUBLIC_EVENT_STATUSES } from "@takemetothefair/constants";
import {
  events,
  inboundEmails,
  operatorOutboundDrafts,
  orgsForDomain,
  PENDING_REPLY_STATUS,
  pendingPromoterContacts,
  promoterContacts,
  promoterOnboardingRequests,
  promoters,
  upcomingEndPredicate,
} from "../schema.js";
import { getDb, type Db } from "../db.js";
import { logError } from "../logger.js";
import type { Env } from "../index.js";
import { fetchVendorSite } from "../enrichment/fetch-site.js";
import { isEmailSuppressed } from "../tools/admin-send-vendor-email.js";
import { ref } from "./crossing-ledger.js";
import { contactObligationTarget } from "./business-days.js";
import { draftSubject, firstNameFrom, settleObligation } from "./contact-lane.js";

type InboundEmail = typeof inboundEmails.$inferSelect;

export const ONBOARDING_SOURCE = "mcp:inbound:promoter-onboarding";
export const ONBOARDING_COMPOSER = "system:promoter-onboarding";
export const ONBOARDING_NOTICE_SOURCE = "promoter-onboarding-notice";
export const ONBOARDING_ENTITY_TYPE = "promoter_onboarding";

/** How long a draft may wait on the enrichment pass (the ticket's suggestion). */
export const ENRICHMENT_TIMEOUT_MS = 30 * 60_000;
/** The health check: a request this old with no draft is a fault. */
export const DRAFT_MISSING_AFTER_MS = 2 * 3_600_000;
export const FOLLOWUP_AFTER_MS = 7 * 86_400_000;
/** Claims and submissions are measured for this long, then the row closes. */
export const MEASURE_WINDOW_MS = 30 * 86_400_000;
const MAX_PER_RUN = 50;
const SITE = "https://meetmeatthefair.com";

// ── Match report ─────────────────────────────────────────────────────────────

interface SenderMatchLite {
  entityType: string;
  entityId: string;
  name?: string;
  basis?: string;
}

function parseMatches(raw: string | null | undefined): SenderMatchLite[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (m): m is SenderMatchLite =>
            !!m && typeof m === "object" && typeof (m as SenderMatchLite).entityId === "string"
        )
      : [];
  } catch {
    return []; // an unreadable match list means "no match", not a lost request
  }
}

export interface MatchReport {
  promoters: SenderMatchLite[];
  vendors: SenderMatchLite[];
  venues: SenderMatchLite[];
  missing: Array<"promoter" | "vendor" | "venue">;
}

export function buildMatchReport(raw: string | null | undefined): MatchReport {
  const m = parseMatches(raw);
  const of = (t: string) => m.filter((x) => x.entityType === t);
  const report = {
    promoters: of("promoter"),
    vendors: of("vendor"),
    venues: of("venue"),
    missing: [] as MatchReport["missing"],
  };
  if (report.promoters.length === 0) report.missing.push("promoter");
  if (report.vendors.length === 0) report.missing.push("vendor");
  if (report.venues.length === 0) report.missing.push("venue");
  return report;
}

/**
 * The ticket routes a claim here "when the org has no promoter row". We can only
 * say that about an org we can identify, so a free-mail claimant with no match
 * stays an ordinary claim.
 */
export function claimBelongsInOnboarding(
  row: Pick<InboundEmail, "matchedEntities" | "fromAddress">
): boolean {
  const report = buildMatchReport(row.matchedEntities);
  if (report.promoters.length > 0) return false;
  if (report.vendors.length > 0 || report.venues.length > 0) return true;
  const domain = organizationalDomain(row.fromAddress);
  return !!domain && !isNonOwnableDomain(domain);
}

// ── Opening a request ────────────────────────────────────────────────────────

export interface StagedPromoter {
  state: "staged";
  companyName: string;
  website: string | null;
  contactEmail: string;
  linkedVendorId: string | null;
  linkedVenueId: string | null;
}

export async function openOnboardingRequest(
  db: Db,
  row: InboundEmail,
  now: Date = new Date()
): Promise<{ requestId: string | null; obligationRef: string | null }> {
  const rootId = row.parentEmailId ?? row.id;
  const family = await db
    .select({ id: inboundEmails.id })
    .from(inboundEmails)
    .where(or(eq(inboundEmails.id, rootId), eq(inboundEmails.parentEmailId, rootId)));
  const familyIds = [...new Set([rootId, row.id, ...family.map((f) => f.id)])];

  const received = row.receivedAt ?? now;
  const targetAt = contactObligationTarget(received);
  const obligation = await settleObligation(db, {
    rootId,
    familyIds,
    threadId: row.threadId ?? null,
    fromAddress: row.fromAddress,
    subject: row.subject ?? null,
    classifiedConfidence: row.classifiedConfidence ?? null,
    openedAt: received,
    targetAt,
  });

  const report = buildMatchReport(row.matchedEntities);
  const fromAddress = extractEmailAddress(row.fromAddress);
  const domain = organizationalDomain(fromAddress);
  const orgDomain = domain && !isNonOwnableDomain(domain) ? domain : null;
  const named = report.promoters[0] ?? report.vendors[0] ?? report.venues[0];
  const orgName = named?.name ?? orgDomain;
  const staged: StagedPromoter | null =
    report.promoters.length === 0 && orgName
      ? {
          state: "staged",
          companyName: orgName,
          website: orgDomain ? `https://${orgDomain}` : null,
          contactEmail: fromAddress,
          linkedVendorId: report.vendors[0]?.entityId ?? null,
          linkedVenueId: report.venues[0]?.entityId ?? null,
        }
      : null;

  await db
    .insert(promoterOnboardingRequests)
    .values({
      id: crypto.randomUUID(),
      inboundEmailId: rootId,
      fromAddress,
      orgDomain,
      orgName: orgName ?? null,
      matchReport: JSON.stringify(report),
      stagedPromoter: staged ? JSON.stringify(staged) : null,
      obligationId: obligation?.id ?? null,
      targetAt: obligation?.targetAt ?? targetAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const [request] = await db
    .select({ id: promoterOnboardingRequests.id })
    .from(promoterOnboardingRequests)
    .where(eq(promoterOnboardingRequests.inboundEmailId, rootId))
    .limit(1);
  return {
    requestId: request?.id ?? null,
    obligationRef: obligation ? ref.supportObligation(obligation.id) : null,
  };
}

// ── The draft ────────────────────────────────────────────────────────────────

export interface ListedEvent {
  name: string;
  slug: string;
  startDate: Date | null;
  endDate: Date | null;
}

function formatDates(e: ListedEvent): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  if (!e.startDate) return "dates to be announced";
  if (!e.endDate || fmt(e.endDate) === fmt(e.startDate)) return fmt(e.startDate);
  return `${fmt(e.startDate)} to ${fmt(e.endDate)}`;
}

/** Proposed wording: John reviews every instance, and the template on OPE-1608. */
export function composeOnboardingDraft(input: {
  subject: string | null | undefined;
  firstName: string | null;
  orgName: string | null;
  events: ListedEvent[];
  validated: boolean;
}): { subject: string; bodyText: string } {
  const who = input.orgName ? `${input.orgName}'s events` : "your events";
  const blocks = [
    input.firstName ? `Hello ${input.firstName},` : "Hello,",
    `Thank you for writing. We'd be glad to list ${who} on Meet Me at the Fair, and listing is free.`,
  ];
  if (input.events.length > 0) {
    blocks.push(
      [
        "Here is what we already have listed. Please check these and tell me if anything is wrong:",
        ...input.events.map((e) => `– ${e.name}, ${formatDates(e)}\n  ${SITE}/events/${e.slug}`),
      ].join("\n")
    );
  } else {
    blocks.push("We haven't found any of your events to list yet.");
  }
  blocks.push(
    [
      "There are two ways to get them on the site:",
      "1. Send them to us. Reply with a link, flyer or schedule and we'll enter them for you.",
      `2. Manage them yourself. Reply "account" and I'll send a link to claim your promoter account, where you can add and edit your events at ${SITE}/promoter/events/new.`,
    ].join("\n")
  );
  if (input.validated) {
    blocks.push(
      "Since your note came from your organization's own address, updates you send us from it are applied directly."
    );
  }
  blocks.push("Do you have other events coming up that we should include?");
  blocks.push(`John\n${SITE}`);
  return { subject: draftSubject(input.subject), bodyText: blocks.join("\n\n") };
}

export function composeOnboardingFollowup(input: {
  firstName: string | null;
  orgName: string | null;
}): { subject: string; bodyText: string } {
  const who = input.orgName ? `${input.orgName}'s events` : "your events";
  return {
    subject: "Following up: listing your events on Meet Me at the Fair",
    bodyText: [
      input.firstName ? `Hello ${input.firstName},` : "Hello,",
      `I wanted to check back about listing ${who}. If you reply with a link, flyer or schedule, we'll enter them for you. Listing is free.`,
      "If now isn't a good time, no need to reply.",
      `John\n${SITE}`,
    ].join("\n\n"),
  };
}

type Request = typeof promoterOnboardingRequests.$inferSelect;

export async function findOrgEvents(
  db: Db,
  request: Pick<Request, "matchReport" | "orgDomain">,
  now: Date
): Promise<ListedEvent[]> {
  const report = JSON.parse(request.matchReport ?? "{}") as Partial<MatchReport>;
  const promoterIds = (report.promoters ?? []).map((p) => p.entityId);
  const venueIds = (report.venues ?? []).map((v) => v.entityId);
  const org: SQL[] = [];
  if (promoterIds.length) org.push(inArray(events.promoterId, promoterIds));
  if (venueIds.length) org.push(inArray(events.venueId, venueIds));
  if (request.orgDomain) org.push(eq(events.sourceDomain, request.orgDomain));
  if (org.length === 0) return [];
  return db
    .select({
      name: events.name,
      slug: events.slug,
      startDate: events.startDate,
      endDate: events.endDate,
    })
    .from(events)
    .where(
      and(
        or(...org),
        inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
        isNull(events.mergedInto),
        upcomingEndPredicate(now)
      )
    )
    .orderBy(asc(events.startDate))
    .limit(15);
}

async function isValidatedContact(db: Db, email: string): Promise<boolean> {
  const [held] = await db
    .select({ id: pendingPromoterContacts.id })
    .from(pendingPromoterContacts)
    .where(eq(pendingPromoterContacts.email, email))
    .limit(1);
  if (held) return true;
  const [contact] = await db
    .select({ id: promoterContacts.id })
    .from(promoterContacts)
    .where(and(eq(promoterContacts.email, email), eq(promoterContacts.status, "validated")))
    .limit(1);
  return !!contact;
}

// ── The */10 pass ────────────────────────────────────────────────────────────

export type OnboardingEnv = Pick<
  Env,
  "DB" | "EMAIL_JOBS" | "ALERT_EMAIL_TECHNICAL" | "CLOUDFLARE_ACCOUNT_ID"
> & { CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string };

export interface OnboardingSummary {
  examined: number;
  enriched: number;
  drafted: number;
  notified: number;
  reminded: number;
  faults: number;
  followups: number;
}

const set = (db: Db, id: string, values: Partial<Request>, now: Date) =>
  db
    .update(promoterOnboardingRequests)
    .set({ ...values, updatedAt: now })
    .where(eq(promoterOnboardingRequests.id, id));

function midpoint(start: Date, end: Date): Date {
  return new Date(start.getTime() + (end.getTime() - start.getTime()) / 2);
}

async function runEnrichmentPass(
  db: Db,
  env: OnboardingEnv,
  request: Request,
  now: Date
): Promise<string> {
  const held = await findOrgEvents(db, request, now);
  let site: { url: string; ok: boolean; failReason?: string; calendarDetected: boolean } | null =
    null;
  if (request.orgDomain) {
    const url = `https://${request.orgDomain}`;
    const fetched = await fetchVendorSite(url, env);
    site = {
      url,
      ok: fetched.ok,
      ...(fetched.failReason ? { failReason: fetched.failReason } : {}),
      calendarDetected: /tribe-events|wp-json\/tribe|[?&]ical=1/i.test(fetched.html ?? ""),
    };
  }
  return JSON.stringify({ site, eventsHeld: held.length });
}

/**
 * The single place a first draft is written. It refuses while the enrichment
 * pass is still running: a draft composed early is a defect the ticket names.
 */
export async function composeFirstDraft(
  db: Db,
  request: Request,
  now: Date
): Promise<string | null> {
  if (request.enrichmentStatus === "queued") {
    await logError(db, {
      source: ONBOARDING_SOURCE,
      message: "promoter-onboarding: draft refused, enrichment has not finished",
      context: { requestId: request.id },
    });
    return null;
  }
  const [inbound] = await db
    .select({
      subject: inboundEmails.subject,
      fromDisplayName: inboundEmails.fromDisplayName,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, request.inboundEmailId))
    .limit(1);
  const composed = composeOnboardingDraft({
    subject: inbound?.subject,
    firstName: firstNameFrom(inbound?.fromDisplayName),
    orgName: request.orgName,
    events: await findOrgEvents(db, request, now),
    validated: await isValidatedContact(db, request.fromAddress),
  });
  await db
    .insert(operatorOutboundDrafts)
    .values({
      id: crypto.randomUUID(),
      toAddress: request.fromAddress,
      subject: composed.subject,
      bodyText: composed.bodyText,
      reason:
        `An organizer asked how to list their events (OPE-1608). Enrichment: ` +
        `${request.enrichmentStatus}. Match report: ${request.matchReport ?? "none"}.`,
      relatedEntityType: ONBOARDING_ENTITY_TYPE,
      relatedEntityId: request.id,
      composedBy: ONBOARDING_COMPOSER,
      composedAt: now,
      status: PENDING_REPLY_STATUS.PENDING,
      inboundEmailId: request.inboundEmailId,
    })
    .onConflictDoNothing();
  const [draft] = await db
    .select({ id: operatorOutboundDrafts.id })
    .from(operatorOutboundDrafts)
    .where(eq(operatorOutboundDrafts.inboundEmailId, request.inboundEmailId))
    .limit(1);
  return draft?.id ?? null;
}

async function loadDraft(db: Db, id: string) {
  const [draft] = await db
    .select({
      status: operatorOutboundDrafts.status,
      toAddress: operatorOutboundDrafts.toAddress,
      subject: operatorOutboundDrafts.subject,
      bodyText: operatorOutboundDrafts.bodyText,
      sentAt: operatorOutboundDrafts.sentAt,
    })
    .from(operatorOutboundDrafts)
    .where(eq(operatorOutboundDrafts.id, id))
    .limit(1);
  return draft ?? null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** True only once the notice is enqueued; a false retries on the next tick. */
async function noticeToJohn(
  env: OnboardingEnv,
  subject: string,
  draft: { toAddress: string; subject: string; bodyText: string },
  draftId: string,
  deadline: Date | null
): Promise<boolean> {
  if (!env.ALERT_EMAIL_TECHNICAL || !env.EMAIL_JOBS) {
    await logError(env.DB, {
      level: "warn",
      source: ONBOARDING_SOURCE,
      message: "promoter-onboarding: notice not sent, ALERT_EMAIL_TECHNICAL/EMAIL_JOBS unset",
    });
    return false;
  }
  const text = [
    `To: ${draft.toAddress}`,
    `Subject: ${draft.subject}`,
    deadline ? `Reply due by: ${deadline.toISOString().slice(0, 16)}Z` : null,
    "",
    draft.bodyText,
    "",
    `Approve with review_operator_draft, id ${draftId}.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
  await env.EMAIL_JOBS.send({
    to: env.ALERT_EMAIL_TECHNICAL,
    subject,
    text,
    html: `<pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    source: ONBOARDING_NOTICE_SOURCE,
  });
  return true;
}

async function faultRow(db: Db, message: string, request: Request): Promise<void> {
  await logError(db, {
    source: ONBOARDING_SOURCE,
    message,
    context: { requestId: request.id, inboundEmailId: request.inboundEmailId },
  });
}

/** Claims and submissions are read each pass so the scorecard can count them. */
async function recordOutcomes(db: Db, request: Request, now: Date): Promise<Partial<Request>> {
  const patch: Partial<Request> = {};
  if (!request.claimedAt && request.orgDomain) {
    // OPE-1614: the promoter that owns the domain on its LIST (website host
    // included); a shared domain has no owner, so it never counts as claimed.
    const owners = await orgsForDomain(db, "promoter", request.orgDomain);
    if (owners.ids.length === 1) {
      const [owner] = await db
        .select({ claimed: promoters.claimed, claimedAt: promoters.claimedAt })
        .from(promoters)
        .where(eq(promoters.id, owners.ids[0]))
        .limit(1);
      if (owner?.claimed) patch.claimedAt = owner.claimedAt ?? now;
    }
  }
  if (!request.firstSubmissionAt && request.repliedAt) {
    const [sub] = await db
      .select({ at: inboundEmails.receivedAt })
      .from(inboundEmails)
      .where(
        and(
          eq(inboundEmails.fromAddress, request.fromAddress),
          inArray(inboundEmails.classifiedIntent, ["new_event"]),
          gte(inboundEmails.receivedAt, request.repliedAt)
        )
      )
      .orderBy(desc(inboundEmails.receivedAt))
      .limit(1);
    if (sub?.at) patch.firstSubmissionAt = sub.at;
  }
  return patch;
}

async function advance(
  db: Db,
  env: OnboardingEnv,
  initial: Request,
  now: Date,
  s: OnboardingSummary
): Promise<void> {
  let r = initial;
  const update = async (values: Partial<Request>) => {
    await set(db, r.id, values, now);
    r = { ...r, ...values };
  };

  if (await isEmailSuppressed(db, r.fromAddress)) {
    await update({ closedAt: now, closeReason: "sender-suppressed" });
    return;
  }

  // 1. Enrichment finishes or times out before anything else may happen.
  if (r.enrichmentStatus === "queued") {
    if (now.getTime() - r.createdAt.getTime() >= ENRICHMENT_TIMEOUT_MS) {
      await update({ enrichmentStatus: "timed_out", enrichmentFinishedAt: now });
    } else {
      const detail = await runEnrichmentPass(db, env, r, now);
      await update({
        enrichmentStatus: "finished",
        enrichmentDetail: detail,
        enrichmentFinishedAt: now,
      });
      s.enriched += 1;
    }
  }

  // 2. The first draft.
  if (!r.draftId) {
    const draftId = await composeFirstDraft(db, r, now);
    if (!draftId) {
      if (
        now.getTime() - r.createdAt.getTime() >= DRAFT_MISSING_AFTER_MS &&
        !r.draftMissingFaultAt
      ) {
        await faultRow(db, "promoter-onboarding: no draft two hours after the request", r);
        await update({ draftMissingFaultAt: now });
        s.faults += 1;
      }
      return;
    }
    await update({ draftId, draftComposedAt: now });
    s.drafted += 1;
  }
  if (!r.draftId) return;

  // 3. What has happened to the draft.
  const draft = await loadDraft(db, r.draftId);
  if (!draft) return;
  if (draft.status === PENDING_REPLY_STATUS.DISCARDED) {
    await update({ closedAt: now, closeReason: "draft-discarded" });
    return;
  }
  if (draft.status === PENDING_REPLY_STATUS.SENT && !r.repliedAt) {
    await update({ repliedAt: draft.sentAt ?? now });
  }

  // 4. Keep John informed while the first reply is outstanding.
  if (!r.repliedAt) {
    const pending = draft.status === PENDING_REPLY_STATUS.PENDING;
    if (!r.notifiedAt) {
      const sent = await noticeToJohn(
        env,
        `Organizer onboarding reply waiting for your approval: ${r.orgName ?? r.fromAddress}`,
        draft,
        r.draftId,
        r.targetAt
      );
      if (sent) {
        await update({ notifiedAt: now });
        s.notified += 1;
      }
    }
    if (pending && r.targetAt && !r.remindedAt && now >= midpoint(r.createdAt, r.targetAt)) {
      const sent = await noticeToJohn(
        env,
        `[ACTION NEEDED] Organizer reply still unapproved, half its time gone: ${r.orgName ?? r.fromAddress}`,
        draft,
        r.draftId,
        r.targetAt
      );
      if (sent) {
        await update({ remindedAt: now });
        s.reminded += 1;
      }
    }
    if (r.targetAt && now >= r.targetAt && !r.deadlineFaultAt) {
      await faultRow(db, "promoter-onboarding: reply deadline passed with no send", r);
      await update({ deadlineFaultAt: now });
      s.faults += 1;
    }
    return;
  }

  // 5. After the reply: record outcomes, follow up once, then stop measuring.
  const outcomes = await recordOutcomes(db, r, now);
  if (Object.keys(outcomes).length > 0) await update(outcomes);

  if (!r.followupDraftId) {
    const engaged = r.claimedAt || r.firstSubmissionAt;
    if (!engaged && now.getTime() - r.repliedAt.getTime() >= FOLLOWUP_AFTER_MS) {
      const [inbound] = await db
        .select({ fromDisplayName: inboundEmails.fromDisplayName })
        .from(inboundEmails)
        .where(eq(inboundEmails.id, r.inboundEmailId))
        .limit(1);
      const composed = composeOnboardingFollowup({
        firstName: firstNameFrom(inbound?.fromDisplayName),
        orgName: r.orgName,
      });
      const followupDraftId = crypto.randomUUID();
      await db.insert(operatorOutboundDrafts).values({
        id: followupDraftId,
        toAddress: r.fromAddress,
        subject: composed.subject,
        bodyText: composed.bodyText,
        reason: "Seven days since our reply, with no claim and no submission (OPE-1608).",
        relatedEntityType: ONBOARDING_ENTITY_TYPE,
        relatedEntityId: r.id,
        composedBy: ONBOARDING_COMPOSER,
        composedAt: now,
        status: PENDING_REPLY_STATUS.PENDING,
      });
      await update({
        followupDraftId,
        followupComposedAt: now,
        followupTargetAt: contactObligationTarget(now),
      });
      s.followups += 1;
    }
  }

  if (r.followupDraftId) {
    const followup = await loadDraft(db, r.followupDraftId);
    if (followup?.status === PENDING_REPLY_STATUS.SENT && !r.followupSentAt) {
      await update({ followupSentAt: followup.sentAt ?? now });
    }
    if (followup?.status === PENDING_REPLY_STATUS.PENDING) {
      if (!r.followupNotifiedAt) {
        const sent = await noticeToJohn(
          env,
          `Organizer follow-up waiting for your approval: ${r.orgName ?? r.fromAddress}`,
          followup,
          r.followupDraftId,
          r.followupTargetAt
        );
        if (sent) {
          await update({ followupNotifiedAt: now });
          s.notified += 1;
        }
      }
      if (
        r.followupTargetAt &&
        r.followupComposedAt &&
        !r.followupRemindedAt &&
        now >= midpoint(r.followupComposedAt, r.followupTargetAt)
      ) {
        const sent = await noticeToJohn(
          env,
          `[ACTION NEEDED] Organizer follow-up still unapproved, half its time gone: ${r.orgName ?? r.fromAddress}`,
          followup,
          r.followupDraftId,
          r.followupTargetAt
        );
        if (sent) {
          await update({ followupRemindedAt: now });
          s.reminded += 1;
        }
      }
      if (r.followupTargetAt && now >= r.followupTargetAt && !r.followupDeadlineFaultAt) {
        await faultRow(db, "promoter-onboarding: follow-up deadline passed with no send", r);
        await update({ followupDeadlineFaultAt: now });
        s.faults += 1;
      }
    }
  }

  if (now.getTime() - r.repliedAt.getTime() >= MEASURE_WINDOW_MS) {
    await update({ closedAt: now, closeReason: "measurement-window-ended" });
  }
}

export async function runPromoterOnboardingPass(
  db: Db,
  env: OnboardingEnv,
  now: Date = new Date()
): Promise<OnboardingSummary> {
  const summary: OnboardingSummary = {
    examined: 0,
    enriched: 0,
    drafted: 0,
    notified: 0,
    reminded: 0,
    faults: 0,
    followups: 0,
  };
  const open = await db
    .select()
    .from(promoterOnboardingRequests)
    .where(isNull(promoterOnboardingRequests.closedAt))
    .orderBy(asc(promoterOnboardingRequests.createdAt))
    .limit(MAX_PER_RUN);
  for (const request of open) {
    summary.examined += 1;
    try {
      await advance(db, env, request, now, summary);
    } catch (error) {
      // One bad row must not stop the others; it retries on the next tick.
      await logError(db, {
        source: ONBOARDING_SOURCE,
        message: "promoter-onboarding: advancing a request failed",
        error,
        context: { requestId: request.id },
      });
    }
  }
  return summary;
}

export async function runScheduledPromoterOnboarding(env: Env, now: Date = new Date()) {
  const summary = await runPromoterOnboardingPass(getDb(env.DB), env, now);
  // The heartbeat's evidence. Every run with work, plus the top-of-hour run, so
  // an idle lane leaves about one row an hour rather than six.
  if (summary.examined > 0 || now.getUTCMinutes() < 10) {
    await logError(env.DB, {
      level: "info",
      source: ONBOARDING_SOURCE,
      message: "promoter-onboarding: pass complete",
      context: { ...summary },
    });
  }
  return summary;
}
