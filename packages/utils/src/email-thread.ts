/**
 * OPE-768 — the discriminator between a first contact and an ongoing
 * conversation, which is already in the table and drives nothing.
 *
 * Every table in the inbound lane is keyed to a single MESSAGE, so a person who
 * writes twice reads as two waiting people. Heather Santiago showed as two open
 * support obligations for eight weeks after one reply had discharged both.
 * Celina Daigle wrote five times between 2026-07-09 and 09-02 and nothing
 * assembled that history; John reconstructed it by hand.
 *
 * `in_reply_to` is populated on 21 of 431 rows and names our OWN message-id on
 * 7 of them — a mathematically exact "this is mid-conversation" test, consulted
 * nowhere.
 *
 * ## The resolution order, and why the weak tier is last and narrow
 *
 * 1. **Header chain** — `In-Reply-To` / `References` against message-ids we
 *    already hold. RFC 5322 headers, exact, no judgement.
 * 2. **Normalised subject + participant set** — a heuristic, applied ONLY when
 *    both match. Subject alone would merge every "Question about my listing".
 * 3. **New thread.**
 *
 * ⚠️ Tier 2 must stay conservative, and the ticket says so in its acceptance:
 * *"Do not silently merge threads on a weak match — leave singletons rather
 * than guess."* There is a live negative control for this. Holly Plush Cargo's
 * two 2026-08-05 rows went to DIFFERENT addresses with DIFFERENT message-ids —
 * two genuine emails, captured correctly. A matcher loose enough to fuse them
 * on subject similarity would also be reporting a capture defect that does not
 * exist, which `[[support-obligations-open-is-not-a-waiting-customer]]` records
 * somebody already getting wrong once.
 *
 * Merging two strangers' conversations is worse than leaving one conversation
 * split: a split thread costs an operator a search, a merged one shows them
 * somebody else's mail.
 */

/** How a thread id was arrived at. Stored, because the weak tier must be audit-able. */
export type ThreadBasis = "header_chain" | "operator_forward" | "subject_participants" | "new";

export interface ThreadResolution {
  threadId: string;
  basis: ThreadBasis;
}

/**
 * Split an `In-Reply-To` / `References` header into normalised message-ids.
 *
 * `References` is the full space-separated chain, so one header yields many
 * ids. Angle brackets are stripped and the result lower-cased: message-ids are
 * case-insensitive in practice and round-trip through several agents before
 * reaching us.
 */
export function parseMessageIdList(header: string | null | undefined): string[] {
  if (!header) return [];
  const ids = header.match(/<[^<>\s]+>/g);
  const raw = ids ?? header.split(/\s+/);
  return raw
    .map((s) => s.trim().replace(/^</, "").replace(/>$/, "").toLowerCase())
    .filter((s) => s.length > 0);
}

/** Normalise one message-id for comparison against a stored `message_id`. */
export function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const v = id.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
  return v || null;
}

/**
 * Strip reply/forward prefixes and list decorations from a subject.
 *
 * Repeated, because real subjects accumulate them ("Re: Fwd: RE: ..."), and
 * localised forms appear via webmail clients. Returns "" for a subject that is
 * nothing but prefixes — which must NOT be treated as a match key.
 */
export function normalizeThreadSubject(subject: string | null | undefined): string {
  if (!subject) return "";
  let s = subject.trim();
  let previous: string;
  do {
    previous = s;
    s = s
      .replace(/^\s*\[[^\]]*\]\s*/i, "") // [EXTERNAL], [SPAM], list tags
      .replace(/^\s*(re|fwd?|aw|antwort|tr|rif|res|sv|vs)\s*(\[\d+\])?\s*:\s*/i, "")
      .trim();
  } while (s !== previous);
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Bare lower-cased address from `"Jane <jane@x.com>"` or `jane@x.com`. */
function extractAddress(a: string | null | undefined): string {
  const v = (a ?? "").trim().toLowerCase();
  const m = /<([^>]+)>/.exec(v);
  return m ? m[1].trim() : v;
}

/**
 * OPE-768 scope 2 — the PERSON an inbound row is waiting on behalf of.
 *
 * A thread is a conversation; a person may have several. Heather Santiago
 * wrote "account" to support@ and "booth set up" to hello@ ten minutes apart —
 * two subjects, two addresses, no reply headers. Fusing those into one THREAD
 * would take exactly the weak match scope 5 forbids, but they are one PERSON by
 * an exact key: the sender address. So the queue counts people by this, and
 * threads stay strict.
 *
 * An operator forward counts as the person it forwards, not as the operator —
 * otherwise John is a waiting customer (symptom 2).
 */
export function correspondentKey(row: {
  fromAddress: string | null | undefined;
  originalSenderAddress?: string | null;
  threadBasis?: string | null;
}): string {
  if (row.threadBasis === "operator_forward" && row.originalSenderAddress) {
    return extractAddress(row.originalSenderAddress);
  }
  return extractAddress(row.fromAddress);
}

/** Lower-cased, order-independent participant key for the weak tier. */
export function participantKey(addresses: Array<string | null | undefined>): string {
  return [
    ...new Set(
      addresses
        .map((a) => (a ?? "").trim().toLowerCase())
        .filter(Boolean)
        // A display name may be wrapped: "Jane <jane@x.com>".
        .map((a) => {
          const m = /<([^>]+)>/.exec(a);
          return m ? m[1].trim() : a;
        })
    ),
  ]
    .sort()
    .join("|");
}

/**
 * Is this subject strong enough to key a heuristic match on?
 *
 * A subject that normalises to nothing, or to a generic stub, cannot
 * distinguish two conversations — and the whole risk of tier 2 is fusing two
 * people who both wrote "Hello".
 */
const GENERIC_SUBJECTS = new Set([
  "",
  "hello",
  "hi",
  "question",
  "inquiry",
  "enquiry",
  "info",
  "information",
  "help",
  "contact",
  "no subject",
  "(no subject)",
  "vendor application",
  "application",
]);

export function isThreadableSubject(normalized: string): boolean {
  if (GENERIC_SUBJECTS.has(normalized)) return false;
  // Two words or ten characters — short enough to admit "fall craft fair",
  // long enough to reject "thanks".
  return normalized.length >= 10 || normalized.split(" ").length >= 3;
}

export interface ThreadCandidateRow {
  threadId: string | null;
  messageId: string | null;
  normalizedSubject: string;
  participants: string;
  /** Sender of the candidate row. Only the operator-forward tier reads it. */
  fromAddress?: string | null;
}

/**
 * Pick the thread for an incoming message from candidate rows already fetched.
 *
 * Pure: the caller does the I/O and hands over what it found, so the decision
 * is testable without a database and identical in every ingest path.
 *
 * `newThreadId` is supplied rather than generated here so the caller controls
 * id generation (and a test can assert the exact value).
 */
export function resolveThread(
  incoming: {
    inReplyTo?: string | null;
    emailReferences?: string | null;
    subject?: string | null;
    participants: string;
    /**
     * The ORIGINAL sender of a forward, set by the caller ONLY when the
     * forwarder is a trusted operator (OPE-768 scope 3). Null otherwise.
     */
    forwardOf?: string | null;
  },
  candidates: ThreadCandidateRow[],
  newThreadId: string
): ThreadResolution {
  const referenced = new Set([
    ...parseMessageIdList(incoming.inReplyTo),
    ...parseMessageIdList(incoming.emailReferences),
  ]);

  // Tier 1 — the header chain. Exact, and it is allowed to match ACROSS
  // subjects: a renamed reply is still the same conversation.
  if (referenced.size > 0) {
    for (const row of candidates) {
      const mid = normalizeMessageId(row.messageId);
      if (mid && referenced.has(mid) && row.threadId) {
        return { threadId: row.threadId, basis: "header_chain" };
      }
    }
  }

  const subject = normalizeThreadSubject(incoming.subject);

  // Tier 1b — an operator forwarding a customer's message (OPE-768 scope 3).
  // `2c194709` ("Fwd: Account creation" from John) minted a second obligation
  // beside Celina's own row. The forward joins HER thread when her own row has
  // the same subject. Same strength as tier 2 — sender AND subject — with the
  // sender being the one the forward names, not the forwarder.
  const forwardOf = incoming.forwardOf ? extractAddress(incoming.forwardOf) : "";
  if (forwardOf && isThreadableSubject(subject)) {
    for (const row of candidates) {
      if (
        row.threadId &&
        row.normalizedSubject === subject &&
        extractAddress(row.fromAddress) === forwardOf
      ) {
        return { threadId: row.threadId, basis: "operator_forward" };
      }
    }
  }

  // Tier 2 — subject AND participants, both, and only for a subject specific
  // enough to mean something. Either half alone merges strangers.
  if (isThreadableSubject(subject)) {
    for (const row of candidates) {
      if (
        row.threadId &&
        row.normalizedSubject === subject &&
        row.participants === incoming.participants
      ) {
        return { threadId: row.threadId, basis: "subject_participants" };
      }
    }
  }

  return { threadId: newThreadId, basis: "new" };
}
