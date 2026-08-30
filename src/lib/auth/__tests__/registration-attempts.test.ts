/**
 * OPE-634 — the blocked-cohort trace.
 *
 * The property that matters is the ANTI-JOIN: the blocked cohort is attempts
 * whose email still has no `users` row. Testing that a row gets written would
 * miss the whole point — the question is who is still missing an account, and
 * that answer has to stay correct as people retry.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import {
  recordRegistrationAttempt,
  listBlockedRegistrations,
} from "../record-registration-attempt";
import { REGISTRATION_ATTEMPT_OUTCOME } from "@/lib/db/schema";

const SCHEMA_SQL = `
  CREATE TABLE registration_attempts (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, attempted_at INTEGER NOT NULL,
    outcome TEXT NOT NULL, detail TEXT, recovered_at INTEGER, recovery_note TEXT
  );
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, role TEXT, origin TEXT
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const WINDOW = { since: new Date("2026-07-01T00:00:00Z"), until: new Date("2026-12-31T00:00:00Z") };
const blocked = () => listBlockedRegistrations(db as never, WINDOW);

function seedUser(email: string) {
  raw
    .prepare(`INSERT INTO users (id, email, origin) VALUES (?,?,?)`)
    .run(email, email, "registration");
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("capturing the refusal", () => {
  it("records a Turnstile refusal with the address the person typed", async () => {
    // The OPE-150 shape. Before this, everyone who reached exactly here
    // vanished without trace.
    await recordRegistrationAttempt(db as never, {
      email: "Celina@FreedomBoatClub.com",
      outcome: REGISTRATION_ATTEMPT_OUTCOME.TURNSTILE,
      detail: "missing-input-response",
    });
    const rows = await blocked();
    expect(rows).toHaveLength(1);
    // Normalized, so the anti-join against users.email is exact.
    expect(rows[0].email).toBe("celina@freedomboatclub.com");
    expect(rows[0].outcome).toBe("turnstile");
  });

  it("never throws — a recovery-tracking write cannot break a signup", async () => {
    // The inverse failure would make this ticket's own subject worse.
    await expect(
      recordRegistrationAttempt(db as never, { email: undefined, outcome: "turnstile" as never })
    ).resolves.toBeUndefined();
    await expect(
      recordRegistrationAttempt(null as never, { email: "a@b.com", outcome: "turnstile" as never })
    ).resolves.toBeUndefined();
    expect(await blocked()).toHaveLength(0);
  });

  it("ignores an unusable address rather than storing junk", async () => {
    for (const email of ["", "   ", "not-an-email", 42, null]) {
      await recordRegistrationAttempt(db as never, {
        email,
        outcome: REGISTRATION_ATTEMPT_OUTCOME.VALIDATION,
      });
    }
    expect(await blocked()).toHaveLength(0);
  });
});

describe("the anti-join is the whole answer", () => {
  it("DROPS someone once they successfully register — self-healing", async () => {
    // The property that keeps this list correct with no reconciliation step.
    await recordRegistrationAttempt(db as never, {
      email: "retry@example.com",
      outcome: REGISTRATION_ATTEMPT_OUTCOME.TURNSTILE,
    });
    expect(await blocked()).toHaveLength(1);

    seedUser("retry@example.com");
    expect(await blocked()).toHaveLength(0);
  });

  it("matches the account case-insensitively", async () => {
    // users.email is normalized (OPE-601); so is the stored attempt. If these
    // ever diverged the person would show as blocked forever.
    await recordRegistrationAttempt(db as never, {
      email: "Mixed@Case.com",
      outcome: REGISTRATION_ATTEMPT_OUTCOME.TURNSTILE,
    });
    seedUser("mixed@case.com");
    expect(await blocked()).toHaveLength(0);
  });

  it("hides rows an operator has closed out", async () => {
    // A queue that cannot reach zero gets ignored.
    await recordRegistrationAttempt(db as never, {
      email: "handled@example.com",
      outcome: REGISTRATION_ATTEMPT_OUTCOME.TURNSTILE,
    });
    raw
      .prepare(`UPDATE registration_attempts SET recovered_at=?, recovery_note=?`)
      .run(1_790_000_000, "emailed, no reply");
    expect(await blocked()).toHaveLength(0);
  });

  it("respects the window", async () => {
    await recordRegistrationAttempt(db as never, {
      email: "old@example.com",
      outcome: REGISTRATION_ATTEMPT_OUTCOME.TURNSTILE,
    });
    raw.prepare(`UPDATE registration_attempts SET attempted_at=?`).run(1_600_000_000); // 2020
    expect(await blocked()).toHaveLength(0);
  });
});
