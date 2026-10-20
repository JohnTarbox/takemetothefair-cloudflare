/**
 * OPE-384 stage 4 — deciding which ask an inbound reply answers.
 *
 * Pure. No database, no clock of its own, no side effects: the caller hands in
 * the inbound's headers and the candidate attempts, and gets back a verdict it
 * may then apply. That separation is what makes "we linked the wrong reply to
 * the wrong event" a testable proposition rather than an incident.
 *
 * Threading here is a TWO-HOP problem, and it is worth stating plainly because
 * the obvious one-hop version does not work. `send_promoter_email` hands the
 * message to the EMAIL_JOBS queue, so the provider's Message-ID does not exist
 * yet when the attempt row is written — `promoter_outreach_attempts
 * .provider_message_id` is, as of stage 3, never populated by anyone. The id
 * appears later, in the queue consumer, on the `email_send_ledger` row. So the
 * caller resolves ledger ids for each attempt and passes them in as
 * `providerMessageIds`; this module does not know how they were obtained.
 *
 * The ordering below is deliberate: an exact identifier first, a fuzzy one
 * second, and an explicit refusal to guess third. A wrong link is worse than
 * no link, because it marks an ask answered and lets the event leave the queue
 * carrying somebody else's answer.
 */

/** Everything about one open ask that bears on matching a reply to it. */
export type ReplyLinkCandidate = {
  attemptId: string;
  eventId: string | null;
  /** The address as SENT — history, not a live lookup. */
  toAddress: string;
  sentAt: Date | null;
  /** Message-IDs the provider assigned to this ask, via `email_send_ledger`.
   *  Any shape — `<id@host>` as the ledger stores it, or bare: both sides are
   *  normalised through `parseMessageIds` before comparing (OPE-1509). */
  providerMessageIds?: readonly string[];
  /** The ask's subject as sent. Read only by the `subject_domain` rule. */
  subject?: string | null;
  /** The promoter's website. Its domain is an organizer domain too. */
  promoterWebsite?: string | null;
};

export type ReplyLinkVerdict =
  | { match: "message_id"; attemptId: string; note?: string }
  | { match: "address"; attemptId: string }
  | { match: "subject_domain"; attemptId: string }
  | { match: "ambiguous"; attemptIds: string[]; reason: string }
  | { match: "none"; reason: string };

/**
 * `"Jane Doe" <jane@grange.org>` -> `jane@grange.org`.
 *
 * Comparing raw From headers would fail on the display name alone, and an
 * organizer whose mail client adds one is exactly the organizer we most want
 * to hear from.
 */
export function normalizeEmailAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angled = raw.match(/<([^>]+)>/);
  const addr = (angled ? angled[1] : raw).trim().toLowerCase();
  return addr.includes("@") ? addr : null;
}

/**
 * Message-IDs out of an `In-Reply-To` / `References` header.
 *
 * `References` accumulates the whole thread, so a reply to our follow-up still
 * carries the first ask's id. Both headers are read and pooled: a client that
 * drops `In-Reply-To` but keeps `References` is common enough that ignoring the
 * second would lose real matches.
 */
export function parseMessageIds(...headers: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const h of headers) {
    if (!h) continue;
    const angled = h.match(/<[^>]+>/g);
    if (angled) {
      for (const a of angled) out.push(a.slice(1, -1).trim());
      continue;
    }
    // Some providers store the bare id with no angle brackets.
    for (const tok of h.split(/[\s,]+/)) {
      const t = tok.trim();
      if (t) out.push(t);
    }
  }
  return [...new Set(out.filter(Boolean))];
}

export function linkPromoterReply(input: {
  inbound: {
    fromAddress: string | null;
    subject?: string | null;
    inReplyTo?: string | null;
    emailReferences?: string | null;
    receivedAt: Date;
  };
  candidates: readonly ReplyLinkCandidate[];
}): ReplyLinkVerdict {
  const { inbound, candidates } = input;

  if (candidates.length === 0) {
    return { match: "none", reason: "no open outreach attempts to match against" };
  }

  // ---- 1. Exact: the provider's own Message-ID.
  const referenced = new Set(parseMessageIds(inbound.inReplyTo, inbound.emailReferences));
  if (referenced.size > 0) {
    // OPE-1509: the ledger stores `<id@host>` WITH brackets and
    // parseMessageIds strips them from the inbound side, so comparing the raw
    // ledger value never matched — this rule was dead from the day it shipped
    // (the test fixture used bare ids). Normalise both sides the same way.
    const hits = candidates.filter((c) =>
      parseMessageIds(...(c.providerMessageIds ?? [])).some((id) => referenced.has(id))
    );
    if (hits.length === 1) {
      // NO timestamp guard here, unlike the address rule below. A Message-ID
      // match is definitional — this mail is a reply to that mail — so
      // discarding it because two clocks disagree would throw away the one
      // signal we can actually be sure of. The anomaly is reported, not acted
      // on.
      const c = hits[0];
      const anomalous = c.sentAt != null && c.sentAt.getTime() > inbound.receivedAt.getTime();
      return {
        match: "message_id",
        attemptId: c.attemptId,
        ...(anomalous
          ? { note: "reply timestamp precedes the send — clock skew; matched on Message-ID anyway" }
          : {}),
      };
    }
    if (hits.length > 1) {
      return {
        match: "ambiguous",
        attemptIds: hits.map((h) => h.attemptId),
        reason: "more than one attempt claims the referenced Message-ID",
      };
    }
  }

  // ---- 2. Fuzzy: they wrote back from the address we wrote to.
  const from = normalizeEmailAddress(inbound.fromAddress);
  if (!from) {
    return { match: "none", reason: "inbound has no parseable from address" };
  }

  const byAddress = candidates.filter((c) => {
    if (normalizeEmailAddress(c.toAddress) !== from) return false;
    // An inbound that arrived BEFORE we sent cannot be an answer to it. Without
    // this, an organizer's unrelated older email would attach itself to a new
    // ask and mark it answered by a message written before the question.
    if (!c.sentAt) return false;
    return c.sentAt.getTime() <= inbound.receivedAt.getTime();
  });

  if (byAddress.length === 1) return { match: "address", attemptId: byAddress[0].attemptId };
  if (byAddress.length > 1) {
    return {
      match: "ambiguous",
      attemptIds: byAddress.map((c) => c.attemptId),
      reason:
        "this address has more than one open ask; the reply may answer either, " +
        "so an operator has to say which",
    };
  }

  // ---- 3. Fuzzy: our subject, answered from the organizer's domain (OPE-1509).
  // A shared inbox (info@) that a named person answers from their own address
  // is the normal case. Both halves are required: the subject alone is
  // guessable, and the domain alone matches any mail from that organizer.
  const subject = normalizeReplySubject(inbound.subject);
  const fromDomain = hostOf(from);
  if (subject.isReply && subject.base && fromDomain) {
    const bySubject = candidates.filter((c) => {
      if (!c.sentAt || c.sentAt.getTime() > inbound.receivedAt.getTime()) return false;
      if (normalizeReplySubject(c.subject).base !== subject.base) return false;
      const own = [hostOf(c.toAddress), hostOf(c.promoterWebsite)].filter((d): d is string => !!d);
      return own.some((d) => sameOrganizerDomain(d, fromDomain));
    });
    if (bySubject.length === 1)
      return { match: "subject_domain", attemptId: bySubject[0].attemptId };
    if (bySubject.length > 1) {
      return {
        match: "ambiguous",
        attemptIds: bySubject.map((c) => c.attemptId),
        reason: "more than one open ask has this subject at this organizer's domain",
      };
    }
  }

  return {
    match: "none",
    reason: "no open ask to this address that predates the reply",
  };
}

/**
 * `"RE: Fwd: re:  Saco  Holiday Festival"` -> `{ isReply: true, base: "saco
 * holiday festival" }`. Case, whitespace and any run of Re:/Fwd:/Fw: prefixes
 * are dropped; `isReply` says whether a Re: was among them.
 */
export function normalizeReplySubject(raw: string | null | undefined): {
  isReply: boolean;
  base: string;
} {
  let s = (raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  let isReply = false;
  for (;;) {
    const m = s.match(/^(re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*/);
    if (!m) break;
    if (m[1] === "re" || m[1] === "aw" || m[1] === "sv") isReply = true;
    s = s.slice(m[0].length);
  }
  return { isReply, base: s };
}

/** Host of an email address or URL, lowercased, without `www.`. */
function hostOf(addressOrUrl: string | null | undefined): string | null {
  if (!addressOrUrl) return null;
  const t = addressOrUrl.trim().toLowerCase();
  let host: string;
  if (t.includes("@") && !t.includes("/")) host = t.split("@").pop()!;
  else {
    try {
      host = new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, "").replace(/>$/, "");
  return host.includes(".") ? host : null;
}

/** Mailbox providers: a shared domain here says nothing about the organizer
 *  (an ask to a@gmail.com is not answered by every Gmail user). */
const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "charter.net",
  "roadrunner.com",
  "myfairpoint.net",
  "protonmail.com",
  "proton.me",
  "gmx.com",
]);

/** `mail.grange.org` and `grange.org` are one organizer; `grange.org` and
 *  `notgrange.org` are not. A subdomain matches its parent, never a suffix.
 *  A mailbox provider's domain never counts as an organizer's. */
function sameOrganizerDomain(a: string, b: string): boolean {
  if (FREEMAIL.has(a) || FREEMAIL.has(b)) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
