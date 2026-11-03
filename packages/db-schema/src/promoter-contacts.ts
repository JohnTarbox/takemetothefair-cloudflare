/**
 * OPE-1330 — promoter contacts: the rules, in one place.
 *
 * Pure by design, like the other shared modules here (`entity-claim-record.ts`):
 * this decides WHAT to write and WHETHER; each caller runs the write with its
 * own `db`. The writers live in two deploy artifacts that cannot import each
 * other's code — the MCP Worker (inbound capture, the admin tools) and the
 * Next.js app (claim approval, the admin page) — and a rule duplicated in both
 * is how a fix ends up wired into one of two parallel paths.
 *
 * ⚠️ Personal contact data: see the table comment in ./index.ts.
 */
import { isNonOwnableDomain, organizationalDomain } from "@takemetothefair/utils";
import { normalizeEmailAddress } from "./promoter-reply-link";

export type PromoterContactStatus = "candidate" | "validated" | "stale" | "rejected";
export type PromoterContactMethod =
  | "domain_verified"
  | "replied_to_our_mail"
  | "approved_claim"
  | "phone"
  | "in_person"
  | "published_on_site"
  | "self_asserted";
export type PromoterContactSenderAuth = "pass" | "partial" | "fail";

// ── Domain verification (scope item 6, John's ruling 2026-10-06) ─────────────

export interface InboundAuthFacts {
  fromAddress: string | null;
  /** inbound_emails.dmarc_result — the raw token: pass / fail / none / … */
  dmarcResult: string | null;
  /** inbound_emails.auth_results_raw — read only for DMARC's header.from. */
  authResultsRaw: string | null;
  /** inbound_emails.original_sender_auth — `not_forwarded` for direct mail. */
  originalSenderAuth: string | null;
}

export interface DomainVerdict {
  /** The DMARC header.from domain, or the From domain when there is no DMARC clause. */
  authDomain: string | null;
  /** Is authDomain the promoter's OWN website domain? null = cannot tell (no website). */
  matchesPromoter: boolean | null;
  /** All of John's conditions hold: write `validated` / `domain_verified`. */
  qualifies: boolean;
  /** Why it does / does not qualify — recorded as evidence. */
  reason: string;
}

/** `dmarc=pass header.from=example.org` → `example.org`. */
export function dmarcHeaderFrom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/\bdmarc=[a-z]+\b[^;]*?\bheader\.from=([^\s;]+)/i);
  return m ? m[1].trim().toLowerCase() : null;
}

function domainOfAddress(addr: string | null | undefined): string | null {
  const a = normalizeEmailAddress(addr);
  return a ? a.slice(a.lastIndexOf("@") + 1) : null;
}

/**
 * Does this message prove it came from the promoter's own domain?
 *
 * Qualifies only when ALL hold:
 *  - DMARC passed for the message (`none` — no DMARC record — does not; nor
 *    does a DKIM/SPF pass for some other domain, e.g. a Yahoo-signed message
 *    from a custom domain);
 *  - the DMARC-aligned From domain's organizational domain equals that of
 *    `promoters.website` (so `events@mail.example.org` ↔ `www.example.org`);
 *  - that domain is the promoter's own — never a free mailbox provider or a
 *    shared host (one list: `NON_OWNABLE_DOMAINS`);
 *  - the message is direct, not a forward.
 *
 * `matchesPromoter` is computed whether or not DMARC passed: it records a
 * separate fact (is this the promoter's domain at all?).
 */
export function decidePromoterContactDomain(
  facts: InboundAuthFacts,
  promoterWebsite: string | null | undefined
): DomainVerdict {
  const fromDomain = domainOfAddress(facts.fromAddress);
  const headerFrom = dmarcHeaderFrom(facts.authResultsRaw);
  const authDomain = headerFrom ?? fromDomain;
  const authOrg = organizationalDomain(authDomain);
  const siteOrg = organizationalDomain(promoterWebsite);

  let matchesPromoter: boolean | null;
  if (!authOrg || !siteOrg) matchesPromoter = null;
  else if (isNonOwnableDomain(authOrg) || isNonOwnableDomain(siteOrg)) matchesPromoter = false;
  else matchesPromoter = authOrg === siteOrg;

  const dmarc = (facts.dmarcResult ?? "").toLowerCase();
  const fail = (reason: string): DomainVerdict => ({
    authDomain,
    matchesPromoter,
    qualifies: false,
    reason,
  });

  if (dmarc !== "pass") return fail(`dmarc=${dmarc || "absent"}, not pass`);
  if (!siteOrg) return fail("promoter has no website to compare against");
  if (!authOrg) return fail("no parseable sender domain");
  if (isNonOwnableDomain(authOrg)) return fail(`${authOrg} is a shared or free-mail domain`);
  if (isNonOwnableDomain(siteOrg)) return fail(`website ${siteOrg} is a shared host`);
  if (authOrg !== siteOrg) return fail(`sender ${authOrg} ≠ website ${siteOrg}`);
  if (headerFrom && fromDomain && organizationalDomain(fromDomain) !== authOrg)
    return fail(`DMARC header.from ${headerFrom} ≠ From ${fromDomain}`);
  if (facts.originalSenderAuth !== "not_forwarded")
    return fail(
      `forwarded or unknown (original_sender_auth=${facts.originalSenderAuth ?? "null"})`
    );
  return {
    authDomain,
    matchesPromoter,
    qualifies: true,
    reason: `DMARC pass aligned to ${authOrg}, the promoter's own website domain`,
  };
}

/** inbound_emails.sender_auth → the column's domain (`unknown` carries nothing). */
export function contactSenderAuth(v: string | null | undefined): PromoterContactSenderAuth | null {
  return v === "pass" || v === "partial" || v === "fail" ? v : null;
}

// ── The write rule ───────────────────────────────────────────────────────────

/** The subset of an existing row the plan needs. */
export interface ExistingPromoterContact {
  id: string;
  status: PromoterContactStatus;
  firstValidatedAt: Date | null;
  lastHeardAt: Date | null;
}

export interface PromoterContactFields {
  name?: string | null;
  role?: string | null;
  phone?: string | null;
  validationMethod: PromoterContactMethod;
  validationEvidence?: string | null;
  inboundEmailId?: string | null;
  senderAuth?: PromoterContactSenderAuth | null;
  authDomain?: string | null;
  authDomainMatchesPromoter?: boolean | null;
  status: PromoterContactStatus;
  notes?: string | null;
}

/**
 * Who is writing, which decides what an existing row may become:
 *  - `capture` — the inbound pipeline, unattended. A repeat only refreshes
 *    `last_heard_at`; the single exception is a `candidate` promoted to
 *    `validated` by a later qualifying message. Never touches a human's edits.
 *  - `claim` — a promoter claim was approved: the claimant becomes
 *    `validated` / `approved_claim`. Unattended on several paths, so a row a
 *    human `rejected` is left alone.
 *  - `manual` — an admin (MCP tool / admin page): every given field applies.
 */
export type PromoterContactWriter = "capture" | "claim" | "manual";

export type PromoterContactPlan =
  | { kind: "invalid"; reason: string }
  | { kind: "insert"; values: Record<string, unknown> }
  | { kind: "update"; id: string; set: Record<string, unknown>; promoted: boolean }
  | { kind: "noop"; id: string; reason: string };

const laterOf = (a: Date | null, b: Date | null): Date | null =>
  !a ? b : !b ? a : a.getTime() >= b.getTime() ? a : b;

export function planPromoterContactWrite(input: {
  writer: PromoterContactWriter;
  existing: ExistingPromoterContact | null;
  promoterId: string;
  email: string | null | undefined;
  fields: PromoterContactFields;
  /** When we heard from them (the inbound's received_at); null for non-mail writes. */
  heardAt?: Date | null;
  actor: string;
  now: Date;
}): PromoterContactPlan {
  const { writer, existing, fields, now } = input;
  const email = normalizeEmailAddress(input.email);
  if (!email) return { kind: "invalid", reason: "no valid email address" };
  if (!input.promoterId) return { kind: "invalid", reason: "no promoter" };
  const heardAt = input.heardAt ?? null;

  if (!existing) {
    return {
      kind: "insert",
      values: {
        promoterId: input.promoterId,
        email,
        name: fields.name ?? null,
        role: fields.role ?? null,
        phone: fields.phone ?? null,
        validationMethod: fields.validationMethod,
        validationEvidence: fields.validationEvidence ?? null,
        inboundEmailId: fields.inboundEmailId ?? null,
        senderAuth: fields.senderAuth ?? null,
        authDomain: fields.authDomain ?? null,
        authDomainMatchesPromoter: fields.authDomainMatchesPromoter ?? null,
        status: fields.status,
        firstValidatedAt: fields.status === "validated" ? now : null,
        lastHeardAt: heardAt,
        notes: fields.notes ?? null,
        createdBy: input.actor,
        updatedBy: input.actor,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  const lastHeardAt = laterOf(existing.lastHeardAt, heardAt);
  const heardChanged =
    (lastHeardAt?.getTime() ?? null) !== (existing.lastHeardAt?.getTime() ?? null);

  if (writer === "capture") {
    if (existing.status === "candidate" && fields.status === "validated") {
      return {
        kind: "update",
        id: existing.id,
        promoted: true,
        set: {
          status: "validated",
          validationMethod: fields.validationMethod,
          validationEvidence: fields.validationEvidence ?? null,
          inboundEmailId: fields.inboundEmailId ?? null,
          senderAuth: fields.senderAuth ?? null,
          authDomain: fields.authDomain ?? null,
          authDomainMatchesPromoter: fields.authDomainMatchesPromoter ?? null,
          firstValidatedAt: existing.firstValidatedAt ?? now,
          lastHeardAt,
          updatedBy: input.actor,
          updatedAt: now,
        },
      };
    }
    if (!heardChanged)
      return { kind: "noop", id: existing.id, reason: "already heard at or after this message" };
    return {
      kind: "update",
      id: existing.id,
      promoted: false,
      set: { lastHeardAt, updatedBy: input.actor, updatedAt: now },
    };
  }

  if (writer === "claim") {
    if (existing.status === "rejected")
      return {
        kind: "noop",
        id: existing.id,
        reason: "a human rejected this contact; a claim does not override that",
      };
    if (existing.status === "validated" && !heardChanged)
      return { kind: "noop", id: existing.id, reason: "already validated" };
    return {
      kind: "update",
      id: existing.id,
      promoted: existing.status !== "validated",
      set: {
        status: "validated",
        validationMethod: fields.validationMethod,
        validationEvidence: fields.validationEvidence ?? null,
        ...(fields.name ? { name: fields.name } : {}),
        firstValidatedAt: existing.firstValidatedAt ?? now,
        lastHeardAt,
        updatedBy: input.actor,
        updatedAt: now,
      },
    };
  }

  // manual: every field the admin gave applies; absent optionals are left as they are.
  const set: Record<string, unknown> = {
    validationMethod: fields.validationMethod,
    status: fields.status,
    updatedBy: input.actor,
    updatedAt: now,
  };
  for (const k of [
    "name",
    "role",
    "phone",
    "validationEvidence",
    "inboundEmailId",
    "senderAuth",
    "authDomain",
    "authDomainMatchesPromoter",
    "notes",
  ] as const) {
    if (fields[k] !== undefined) set[k] = fields[k];
  }
  if (fields.status === "validated" && !existing.firstValidatedAt) set.firstValidatedAt = now;
  if (heardChanged) set.lastHeardAt = lastHeardAt;
  return { kind: "update", id: existing.id, promoted: false, set };
}
