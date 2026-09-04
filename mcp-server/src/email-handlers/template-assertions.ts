/**
 * OPE-771 — a template that asserts a fact about the inbound must be wired to
 * the field that would falsify it.
 *
 * Three shipped instances of one shape, each found by a person reading an email
 * months later rather than by anything in the system:
 *
 * | ticket  | the template asserts              | the field that falsifies it        |
 * |---------|-----------------------------------|------------------------------------|
 * | OPE-453 | "you forgot the link" (`no-url`)  | `parsed_url` is non-null           |
 * | OPE-706 | "hasn't been read by a person"    | `in_reply_to` names OUR message-id |
 * | OPE-460 | "thanks for submitting N events"  | fewer than N were created          |
 *
 * OPE-453's own close note generalised it — *"a claim not wired to the evidence
 * that would contradict it will eventually be false, and nothing will notice"* —
 * and we then shipped the second instance anyway. That is the argument for a
 * guard rather than a third ticket.
 *
 * ## Two halves, and the second is the one that lasts
 *
 * The registry below is checked at SEND time (`checkTemplateAssertions`), and
 * its completeness is checked in CI (`scripts/check-template-assertions.ts`).
 * Without the CI half the registry rots: a new reply kind gets added, nobody
 * remembers this file, and the guard silently covers less every month while
 * continuing to pass.
 */

/** The inbound facts a predicate may consult. Deliberately small. */
export interface InboundFacts {
  /** `inbound_emails.parsed_url` — a URL we actually stored off the message. */
  parsedUrl?: string | null;
  /** `inbound_emails.body_text`, for "was there a link in the prose". */
  bodyText?: string | null;
  /** `inbound_emails.in_reply_to`, verbatim. */
  inReplyTo?: string | null;
  /** How many events this submission actually created. */
  createdEventCount?: number | null;
  /** How many the outbound copy is about to claim. */
  claimedEventCount?: number | null;
  /** For `already-exists`: the dedup target we are about to point at. */
  dedupTargetId?: string | null;
  /** Photos the copy is about to claim it received. */
  claimedPhotoCount?: number | null;
  /** Photos actually stored off this message. */
  storedPhotoCount?: number | null;
  /** For `correction-applied`: did a write actually land? */
  correctionApplied?: boolean | null;
}

export interface TemplateAssertion {
  /** What the copy claims, in the words a reader of the email would use. */
  claim: string;
  /**
   * Returns a violation string when the claim is FALSE, else null.
   *
   * Returning null on missing evidence is deliberate: absence of evidence is
   * not evidence the claim is false, and a predicate that fired on unknowns
   * would suppress correct mail. The guard exists to catch the case where we
   * HOLD the contradicting fact — that is the whole of all three instances.
   */
  falsifiedBy: (facts: InboundFacts) => string | null;
}

/** Our own domain, for "did this reply come back to us". */
const OWN_DOMAIN = "@meetmeatthefair.com";

const urlInText = (text: string | null | undefined): boolean =>
  typeof text === "string" && /\bhttps?:\/\/\S+/i.test(text);

/**
 * "We received N photos" — shared by the whole photo-intake family.
 *
 * Same shape as OPE-460's "thanks for submitting N events": a number in the
 * copy that a count on our side can contradict. Factored rather than repeated
 * so a fix reaches all five kinds, which is the failure mode that produced this
 * ticket in the first place.
 */
function photoCountClaim(): TemplateAssertion {
  return {
    claim: "we received N photos",
    falsifiedBy: (f) =>
      typeof f.claimedPhotoCount === "number" &&
      typeof f.storedPhotoCount === "number" &&
      f.claimedPhotoCount !== f.storedPhotoCount
        ? `copy claims ${f.claimedPhotoCount} photo(s) but ${f.storedPhotoCount} were stored`
        : null,
  };
}

/**
 * The registry.
 *
 * A reply kind that makes NO factual claim about the inbound maps to `[]`. That
 * is a real, reviewed answer and is different from being absent — the CI check
 * treats an absent key as a failure and an empty array as a decision.
 */
export const TEMPLATE_ASSERTIONS: Record<string, TemplateAssertion[]> = {
  // ── Claims about what the sender did or did not send ────────────────────
  "no-url": [
    {
      claim: "you did not include a link",
      falsifiedBy: (f) =>
        f.parsedUrl
          ? `parsed_url is set (${f.parsedUrl}) — the sender DID send a link; 'unfetchable-url' is the honest kind`
          : urlInText(f.bodyText)
            ? "body_text contains a URL — the sender did send a link"
            : null,
    },
  ],
  "unfetchable-url": [
    {
      // OPE-453's fix split "no link" from "couldn't read your link". BOTH
      // variants need a predicate, not just the first — this is the half the
      // ticket flags as easy to miss.
      claim: "you sent a link and we could not read it",
      // ⚠️ Requires parsedUrl to be EXPLICITLY null and bodyText to be a known
      // string. `!f.parsedUrl` was the first version and it was wrong: an
      // absent fact is not evidence there was no link, so every caller that
      // did not supply facts got its template swapped. The existing OPE-453
      // suite caught it — my own test had passed `parsedUrl: null` explicitly
      // and so never exercised the absent case.
      falsifiedBy: (f) =>
        f.parsedUrl === null && typeof f.bodyText === "string" && !urlInText(f.bodyText)
          ? "no parsed_url and no URL in body_text — there was no link to fail on; 'no-url' is the honest kind"
          : null,
    },
  ],
  "empty-message": [
    {
      claim: "your message arrived carrying nothing usable",
      falsifiedBy: (f) =>
        f.parsedUrl || urlInText(f.bodyText)
          ? "the message carried a URL — it was not empty"
          : null,
    },
  ],

  // ── Claims about whether a human has been involved ──────────────────────
  "support-ack": [
    {
      claim: "this has not been read by a person yet",
      falsifiedBy: (f) =>
        typeof f.inReplyTo === "string" && f.inReplyTo.toLowerCase().includes(OWN_DOMAIN)
          ? "in_reply_to names our own message-id — this is a reply to a human, mid-correspondence"
          : null,
    },
  ],
  "correction-ack": [
    {
      claim: "this has not been read by a person yet",
      falsifiedBy: (f) =>
        typeof f.inReplyTo === "string" && f.inReplyTo.toLowerCase().includes(OWN_DOMAIN)
          ? "in_reply_to names our own message-id — this is a reply to a human, mid-correspondence"
          : null,
    },
  ],
  "press-ack": [
    {
      claim: "this has not been read by a person yet",
      falsifiedBy: (f) =>
        typeof f.inReplyTo === "string" && f.inReplyTo.toLowerCase().includes(OWN_DOMAIN)
          ? "in_reply_to names our own message-id — this is a reply to a human, mid-correspondence"
          : null,
    },
  ],

  // ── Claims about counts ─────────────────────────────────────────────────
  "ok-multi": [
    {
      claim: "thanks for submitting N events",
      falsifiedBy: (f) =>
        typeof f.claimedEventCount === "number" &&
        typeof f.createdEventCount === "number" &&
        f.claimedEventCount !== f.createdEventCount
          ? `copy claims ${f.claimedEventCount} events but ${f.createdEventCount} were created`
          : null,
    },
  ],
  "already-exists": [
    {
      claim: "we already have this event",
      falsifiedBy: (f) =>
        f.dedupTargetId === null
          ? "no dedup target resolved — there is no existing event to point at"
          : null,
    },
  ],

  // ── The photo lane. Every one of these opens "we received N photo(s)",
  //    which is the OPE-460 count shape again on a different template.
  //    Read from the copy in email-reply-builder.ts, not inferred from names.
  "photo-intake-ack": [photoCountClaim()],
  "photo-intake-held": [photoCountClaim()],
  "photo-intake-unresolved": [photoCountClaim()],
  "photo-intake-resolved": [photoCountClaim()],
  "photo-intake-poster": [photoCountClaim()],

  // ── Correction outcomes ─────────────────────────────────────────────────
  "correction-applied": [
    {
      // Copy: "We've applied your update. The change should be visible on the
      // site within a few minutes." That is a claim about a write.
      claim: "we have applied your update",
      falsifiedBy: (f) =>
        f.correctionApplied === false
          ? "no correction was applied — the copy promises a change that did not happen"
          : null,
    },
  ],

  // ── Reviewed as making no falsifiable claim about the inbound ───────────
  // Each of these is a decision, not an omission. `[]` says "somebody looked".
  ok: [],
  "ok-medium": [],
  "ok-low": [],
  "ok-low-body-extract": [],
  "ok-medium-dup": [],
  "no-url-prose-failed": [],
  "extract-failed": [],
  "submit-failed": [],
  "sweep-exceeded": [],
  "submission-approved": [],
  "thread-reply-ack": [],
  "unrouted-hold-ask": [],
  "unsubscribe-ack": [],
  "unsubscribe-unclear": [],
  "source-suggestion-ack": [],
  // Copy: "After reviewing, we weren't able to apply this change as-is." /
  // "Could you reply with a source". Neither states a fact about the inbound
  // that a column could contradict — they describe OUR decision.
  "correction-rejected": [],
  "correction-needs-info": [],
  "press-handled": [],
  "press-needs-info": [],
  "problem-report-ack": [],
};

export interface AssertionViolation {
  replyKind: string;
  claim: string;
  reason: string;
}

/**
 * Evaluate a reply kind's assertions against the inbound row.
 *
 * ⚠️ An UNREGISTERED kind returns no violation. CI is what makes that safe:
 * `check-template-assertions.ts` fails the build when a ReplyKind is missing
 * from the registry, so an unregistered kind cannot reach production. Throwing
 * here instead would mean a registry slip stops customer mail, which is the
 * wrong direction — per the OPE-706 ruling, wrong suppression fails silently
 * and is worse than a clumsy ack.
 */
export function checkTemplateAssertions(
  replyKind: string,
  facts: InboundFacts
): AssertionViolation[] {
  const assertions = TEMPLATE_ASSERTIONS[replyKind];
  if (!assertions) return [];
  const out: AssertionViolation[] = [];
  for (const a of assertions) {
    const reason = a.falsifiedBy(facts);
    if (reason) out.push({ replyKind, claim: a.claim, reason });
  }
  return out;
}

/**
 * Where to fall back when a template's claim is falsified.
 *
 * ⚠️ Every target here is a template that ALREADY EXISTS and has already been
 * through the copy gate. Nothing new is written: inventing customer-facing copy
 * to escape a guard would be an OPE-6 violation dressed up as a fix.
 *
 * ⚠️ And the fallback is never SILENCE. Per the OPE-706 ruling, wrong
 * suppression fails silently and is worse than a clumsy ack — the sender at
 * least learns their message arrived.
 *
 * A kind with no entry keeps its template and records the violation. That is
 * the honest outcome when no approved sibling says the true thing: a count that
 * is off by five is bad copy, and swapping it for an unrelated template would
 * be worse.
 */
export const NEUTRAL_FALLBACK: Record<string, string> = {
  // "you forgot the link" is false ⇔ they sent one we could not use. That is
  // exactly what `unfetchable-url` says, and OPE-453 split them for this reason.
  "no-url": "unfetchable-url",
  // And the inverse.
  "unfetchable-url": "no-url",
  // "hasn't been read by a person yet" is false ⇔ this is a reply to us
  // mid-thread. `thread-reply-ack` is the template for precisely that.
  "support-ack": "thread-reply-ack",
  "correction-ack": "thread-reply-ack",
  "press-ack": "thread-reply-ack",
};

export interface ResolvedReplyKind {
  /** The kind to actually render. Differs from the input only on a violation. */
  kind: string;
  violations: AssertionViolation[];
  /** True when a false claim was caught AND an approved sibling replaced it. */
  substituted: boolean;
}

/**
 * Decide which template may actually be sent for `kind`.
 *
 * The single decision point: called from `buildReply`, which every auto-reply
 * passes through, so a new send path inherits the check rather than having to
 * remember it. That placement is the point — all three historical instances
 * were paths that each did their own thing.
 */
export function resolveReplyKind(kind: string, facts: InboundFacts = {}): ResolvedReplyKind {
  const violations = checkTemplateAssertions(kind, facts);
  if (violations.length === 0) return { kind, violations, substituted: false };
  const fallback = NEUTRAL_FALLBACK[kind];
  if (!fallback) return { kind, violations, substituted: false };
  // Guard against swapping into a template that is itself falsified by the same
  // facts — which would send a second false claim to fix the first.
  if (checkTemplateAssertions(fallback, facts).length > 0) {
    return { kind, violations, substituted: false };
  }
  return { kind: fallback, violations, substituted: true };
}
