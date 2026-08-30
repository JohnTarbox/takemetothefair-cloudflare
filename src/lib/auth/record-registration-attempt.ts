/**
 * OPE-634 — record a registration that did not produce an account.
 *
 * ## The failure this exists to stop
 *
 * We fix registration outages fast and have no mechanism at all for the people
 * who hit one. OPE-150 was filed and fixed inside a day; a real prospect who
 * wrote to `support@` in the middle of it still had no account 51 days later,
 * because the only trace she left was an email she chose to send. Everyone who
 * did not write is invisible: a blocked signup is by construction someone with
 * NO `users` row, so the cohort cannot be queried from the thing they failed to
 * create.
 *
 * This writes the row that makes the next one recoverable, at the one moment the
 * data exists — after the payload is parsed, before the wall refuses it.
 *
 * ## Fail-soft, and that is not a shrug
 *
 * A recovery-tracking write must never be able to break a registration. If this
 * throws, the person still gets their account; we lose a row in a triage queue.
 * The inverse — a logging failure turning into a signup failure — would make
 * this ticket's own subject worse.
 *
 * ## Deliberately not wired to anything that sends
 *
 * OPE-634 STOP-gates contacting this cohort. Enumeration is the deliverable;
 * reaching out to people who failed to sign up weeks ago is a customer-facing
 * decision and is John's.
 */
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { registrationAttempts, users, type RegistrationAttemptOutcome } from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/auth/normalize-email";
import type { Database } from "@/lib/db";

export async function recordRegistrationAttempt(
  db: Database,
  input: {
    /** Raw address as typed; normalized here so it joins `users.email` exactly. */
    email: unknown;
    outcome: RegistrationAttemptOutcome;
    detail?: string | null;
  }
): Promise<void> {
  try {
    // The body is unvalidated at the earliest call site — a validation failure
    // is one of the outcomes recorded — so the address is checked here rather
    // than assumed. Nothing to recover without one.
    if (typeof input.email !== "string") return;
    const email = normalizeEmail(input.email.trim());
    if (!email || !email.includes("@") || email.length > 320) return;

    await db.insert(registrationAttempts).values({
      email,
      attemptedAt: new Date(),
      outcome: input.outcome,
      detail: input.detail ?? null,
    });
  } catch {
    // See the fail-soft note above.
  }
}

/**
 * OPE-634 scope item 1 — "who started registration between X and Y and never
 * finished?"
 *
 * The blocked cohort is the anti-join: attempts whose email STILL has no
 * `users` row. That definition is self-healing — someone who retries
 * successfully drops out with no reconciliation step — and it means the answer
 * stays correct without anything having to maintain it.
 *
 * `recoveredAt IS NULL` keeps the list to people nobody has closed out yet.
 * Recording the decision (contacted, or consciously skipped) is the point of
 * scope item 3; a queue that cannot be emptied gets ignored.
 *
 * ⚠️ Returns addresses. Admin-gated, and NOT wired to any sender: OPE-634
 * STOP-gates contacting this cohort.
 */
export async function listBlockedRegistrations(
  db: Database,
  window: { since: Date; until: Date; limit?: number }
): Promise<
  { id: string; email: string; attemptedAt: Date; outcome: string; detail: string | null }[]
> {
  return db
    .select({
      id: registrationAttempts.id,
      email: registrationAttempts.email,
      attemptedAt: registrationAttempts.attemptedAt,
      outcome: registrationAttempts.outcome,
      detail: registrationAttempts.detail,
    })
    .from(registrationAttempts)
    .leftJoin(users, eq(users.email, registrationAttempts.email))
    .where(
      and(
        gte(registrationAttempts.attemptedAt, window.since),
        lte(registrationAttempts.attemptedAt, window.until),
        isNull(registrationAttempts.recoveredAt),
        // The anti-join: no account was ever created for this address.
        isNull(users.id)
      )
    )
    .orderBy(desc(registrationAttempts.attemptedAt))
    .limit(window.limit ?? 200);
}
