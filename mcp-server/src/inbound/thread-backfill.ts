/**
 * OPE-768 scope 5 — thread the rows that predate drizzle/0263.
 *
 * PURE: the caller loads the rows and writes the plan. The same resolver the
 * ingest path uses (`resolveThread`) decides every row, fed the rows that came
 * BEFORE it in receipt order — exactly what ingest would have seen had
 * threading existed then. So a backfilled thread and a live one mean the same
 * thing, and the basis column stays an honest record of which tier decided.
 *
 * ⚠️ Best-effort, and reported as such. Only a minority of old rows carry
 * reply headers; the rest can only ever match on subject AND participants, and
 * a row that matches neither stays a singleton. Leaving a conversation split
 * costs an operator a search; fusing two strangers shows them someone else's
 * mail. The resolver already refuses the weak match on a generic subject.
 */
import {
  normalizeThreadSubject,
  participantKey,
  resolveThread,
  type ThreadBasis,
  type ThreadCandidateRow,
} from "@takemetothefair/utils";

export interface BackfillInboundRow {
  id: string;
  receivedAt: number;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  emailReferences: string | null;
  originalSenderAddress: string | null;
  threadId: string | null;
  threadPosition: number | null;
}

export interface BackfillLedgerRow {
  providerMessageId: string | null;
  inboundEmailId: string | null;
}

export interface ThreadAssignment {
  id: string;
  threadId: string;
  threadPosition: number;
  threadBasis: ThreadBasis;
}

export interface ThreadBackfillPlan {
  assignments: ThreadAssignment[];
  byBasis: Record<ThreadBasis, number>;
  /** Threads that the backfill made hold MORE than one message. */
  multiMessageThreads: number;
  /** Rows the backfill left alone in their own thread. */
  singletons: number;
}

export function planThreadBackfill(
  rows: BackfillInboundRow[],
  ledger: BackfillLedgerRow[],
  trustedSenders: Set<string>,
  newId: () => string
): ThreadBackfillPlan {
  const ordered = [...rows].sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : 1));

  // What every row resolves to, as the walk proceeds. Already-threaded rows
  // keep their thread and are never re-decided.
  const threadOf = new Map<string, string>();
  const threadSize = new Map<string, number>();
  const sendsByInbound = new Map<string, string[]>();
  for (const l of ledger) {
    if (!l.inboundEmailId || !l.providerMessageId) continue;
    const list = sendsByInbound.get(l.inboundEmailId) ?? [];
    list.push(l.providerMessageId);
    sendsByInbound.set(l.inboundEmailId, list);
  }

  const seen: ThreadCandidateRow[] = [];
  const assignments: ThreadAssignment[] = [];
  const byBasis: Record<ThreadBasis, number> = {
    header_chain: 0,
    operator_forward: 0,
    subject_participants: 0,
    new: 0,
  };

  const admit = (row: BackfillInboundRow, threadId: string) => {
    threadOf.set(row.id, threadId);
    const base = {
      threadId,
      normalizedSubject: normalizeThreadSubject(row.subject),
      participants: participantKey([row.fromAddress, row.toAddress]),
      fromAddress: row.fromAddress,
    };
    seen.push({ ...base, messageId: row.messageId });
    // Our own replies to this row join its thread — a customer answering one
    // of them names OUR Message-ID (Celina, 2026-09-01).
    for (const sent of sendsByInbound.get(row.id) ?? []) {
      seen.push({ ...base, messageId: sent });
    }
  };

  for (const row of ordered) {
    if (row.threadId) {
      admit(row, row.threadId);
      threadSize.set(
        row.threadId,
        Math.max(threadSize.get(row.threadId) ?? 0, row.threadPosition ?? 1)
      );
      continue;
    }

    const from = (row.fromAddress ?? "").trim().toLowerCase();
    const original = row.originalSenderAddress?.trim().toLowerCase() || null;
    const forwardOf = original && original !== from && trustedSenders.has(from) ? original : null;

    const { threadId, basis } = resolveThread(
      {
        inReplyTo: row.inReplyTo,
        emailReferences: row.emailReferences,
        subject: row.subject,
        participants: participantKey([row.fromAddress, row.toAddress]),
        forwardOf,
      },
      seen,
      newId()
    );

    const position = (threadSize.get(threadId) ?? 0) + 1;
    threadSize.set(threadId, position);
    admit(row, threadId);
    assignments.push({ id: row.id, threadId, threadPosition: position, threadBasis: basis });
    byBasis[basis] += 1;
  }

  const touched = new Set(assignments.map((a) => a.threadId));
  let multi = 0;
  let singletons = 0;
  for (const t of touched) {
    if ((threadSize.get(t) ?? 0) > 1) multi += 1;
    else singletons += 1;
  }

  return { assignments, byBasis, multiMessageThreads: multi, singletons };
}
