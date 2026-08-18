/**
 * OPE-384 stage 1 — the capability to ask an organizer to confirm their own event.
 *
 * Worked example (the ticket's acceptance walkthrough): Dartmouth Grange Fair
 * 2026 holds `dates_confirmed = true` for Sep 11–12, uncorroborated — the
 * organizer's own site still shows 2024 dates. There was no tool to ask, so a
 * human hand-sent from `hello@` and the eventual reply will link to nothing.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  buildConfirmationAsk,
  findOpenAttemptForEvent,
} from "../src/tools/admin-send-promoter-email.js";
import { events, promoters, promoterOutreachAttempts } from "../src/schema.js";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
});

function seed(opts: { contactEmail?: string | null } = {}) {
  db.insert(promoters)
    .values({
      id: "promoter-1",
      companyName: "Dartmouth Grange #162",
      slug: "dartmouth-grange-162",
      contactEmail:
        opts.contactEmail === undefined ? "info@dartmouthgrange.org" : opts.contactEmail,
    } as never)
    .run();
  db.insert(events)
    .values({
      id: "event-1",
      name: "Dartmouth Grange Fair 2026",
      slug: "dartmouth-grange-fair-2026",
      promoterId: "promoter-1",
      status: "APPROVED",
    } as never)
    .run();
}

function insertAttempt(over: Record<string, unknown> = {}) {
  const row = {
    id: (over.id as string) ?? crypto.randomUUID(),
    promoterId: "promoter-1",
    eventId: "event-1",
    channel: "email" as const,
    toAddress: "info@dartmouthgrange.org",
    subject: "Confirming this year's dates",
    bodyText: "Hello,",
    status: "queued" as const,
    createdAt: new Date(),
    ...over,
  };
  db.insert(promoterOutreachAttempts)
    .values(row as never)
    .run();
  return row;
}

describe("never double-ask — enforced by the DATABASE, not by the caller", () => {
  beforeEach(seed);

  it("refuses a second OPEN attempt for the same event", () => {
    // This is the OPE-423 lesson applied ahead of time: an invariant that lives
    // only in one code path gets violated by the second code path. A partial
    // unique index makes the second open ask impossible regardless of writer.
    insertAttempt({ status: "queued" });
    expect(() => insertAttempt({ status: "sent" })).toThrow();
  });

  it("also refuses two queued asks", () => {
    insertAttempt({ status: "queued" });
    expect(() => insertAttempt({ status: "queued" })).toThrow();
  });

  it("ALLOWS a new ask once the previous one closed", () => {
    // The capped follow-up path: the first goes `no_response` on timeout, and
    // only then may a second be created. Scoping the index to the open statuses
    // is what permits this.
    insertAttempt({ status: "no_response" });
    expect(() => insertAttempt({ status: "queued" })).not.toThrow();
  });

  it("keeps the full closed history of an event", () => {
    insertAttempt({ status: "no_response" });
    insertAttempt({ status: "confirmed" });
    insertAttempt({ status: "bounced" });
    const rows = db.select().from(promoterOutreachAttempts).all();
    expect(rows).toHaveLength(3);
  });

  it("does not constrain attempts with no event", () => {
    // An ask about the organizer generally (missing contact, claim follow-up)
    // is not per-event, so the invariant must not apply to it.
    insertAttempt({ eventId: null, status: "queued" });
    expect(() => insertAttempt({ eventId: null, status: "queued" })).not.toThrow();
  });

  it("treats `replied` as CLOSED, not open", () => {
    // They answered. Whether the answer resolved anything is `confirmed`'s job;
    // it is not a reason to keep asking, and it must not block a follow-up.
    insertAttempt({ status: "replied" });
    expect(() => insertAttempt({ status: "queued" })).not.toThrow();
  });
});

describe("findOpenAttemptForEvent — the legible half of the same rule", () => {
  beforeEach(seed);

  it("finds a queued attempt", async () => {
    const { id } = insertAttempt({ status: "queued" });
    const open = await findOpenAttemptForEvent(db, "event-1");
    expect(open?.id).toBe(id);
  });

  it("finds a sent attempt", async () => {
    insertAttempt({ status: "sent" });
    expect(await findOpenAttemptForEvent(db, "event-1")).not.toBeNull();
  });

  it("returns null once the attempt closed", async () => {
    insertAttempt({ status: "confirmed" });
    expect(await findOpenAttemptForEvent(db, "event-1")).toBeNull();
  });

  it("returns null for an event with no attempts", async () => {
    expect(await findOpenAttemptForEvent(db, "event-1")).toBeNull();
  });
});

describe("the confirmation ask asks, and does not assert", () => {
  it("does not state dates we cannot corroborate", () => {
    // The Dartmouth failure IS an uncorroborated `dates_confirmed`. Telling the
    // organizer "your fair is Sep 11–12" invites them to correct our confidence
    // rather than supply the fact.
    const { body } = buildConfirmationAsk({ eventName: "Dartmouth Grange Fair 2026" });
    expect(body).toContain("rather ask than guess");
    expect(body).toContain("This year's dates");
  });

  it("names what we currently show only when we say we couldn't confirm it", () => {
    const { body } = buildConfirmationAsk({
      eventName: "Dartmouth Grange Fair 2026",
      currentDates: "September 11–12, 2026",
    });
    expect(body).toContain("September 11–12, 2026");
    expect(body).toContain("haven't been able to confirm");
  });

  it("carries NO unsubscribe footer — this is transactional, not marketing", () => {
    const { body } = buildConfirmationAsk({ eventName: "X" });
    expect(body.toLowerCase()).not.toContain("unsubscribe");
    expect(body).not.toContain("You're receiving this because");
  });

  it("asks for all three things the ticket names", () => {
    const { body } = buildConfirmationAsk({ eventName: "X" });
    expect(body).toContain("dates");
    expect(body).toContain("times");
    expect(body).toMatch(/vendor or crafter applications/);
  });

  it("includes our listing when we have a URL, and omits it cleanly when not", () => {
    expect(
      buildConfirmationAsk({ eventName: "X", eventUrl: "https://meetmeatthefair.com/events/x" })
        .body
    ).toContain("/events/x");
    expect(buildConfirmationAsk({ eventName: "X" }).body).not.toContain("Our listing:");
  });

  it("names the event in the subject, so a reply threads readably", () => {
    expect(buildConfirmationAsk({ eventName: "Dartmouth Grange Fair 2026" }).subject).toContain(
      "Dartmouth Grange Fair 2026"
    );
  });
});
