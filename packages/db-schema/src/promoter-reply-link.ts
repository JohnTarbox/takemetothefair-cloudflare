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
  /** Message-IDs the provider assigned to this ask, via `email_send_ledger`. */
  providerMessageIds?: readonly string[];
};

export type ReplyLinkVerdict =
  | { match: "message_id"; attemptId: string; note?: string }
  | { match: "address"; attemptId: string }
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
    const hits = candidates.filter((c) =>
      (c.providerMessageIds ?? []).some((id) => referenced.has(id))
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

  return {
    match: "none",
    reason: "no open ask to this address that predates the reply",
  };
}
