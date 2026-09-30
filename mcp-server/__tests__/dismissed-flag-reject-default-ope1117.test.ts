/**
 * OPE-1117 — `update_event_status` must not turn a DISMISSED duplicate flag
 * into a duplicate adjudication.
 *
 * OPE-450 defaults `rejected_as_duplicate_of` from `possible_duplicate_of` on
 * a REJECTED transition, so the common "reject the duplicate" case needs no
 * extra argument. OPE-1117 added the verdict that default could not see: a
 * human looked at the pair and ruled them two different events. Rejecting that
 * row later — for any reason — must not record it as a duplicate of the event
 * it was just ruled NOT to duplicate, because OPE-450's pre-create check trusts
 * that column.
 *
 * Both sides are pinned: the default still fires for an undismissed flag, and
 * an explicit argument still wins over a dismissal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { eventDuplicateDismissals, events, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let indexnow: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  indexnow = mockIndexNowFetch();

  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: unsafeSlug("test-promoter") })
    .run();
  for (const [id, flag] of [
    ["keeper", null],
    ["flagged", "keeper"],
  ] as const) {
    db.insert(events)
      .values({
        id,
        name: id,
        slug: unsafeSlug(id),
        promoterId: "promoter-1",
        status: "PENDING",
        possibleDuplicateOf: flag,
        createdAt: new Date("2026-09-18T12:00:00Z"),
      })
      .run();
  }
});

afterEach(() => {
  indexnow.restore();
});

const dismiss = () =>
  db
    .insert(eventDuplicateDismissals)
    .values({ eventId: "flagged", candidateId: "keeper", dismissedAt: new Date() })
    .run();

const rejectedAs = () =>
  db
    .select({ v: events.rejectedAsDuplicateOf, s: events.status })
    .from(events)
    .where(eq(events.id, "flagged"))
    .get();

async function reject(extra: Record<string, unknown> = {}) {
  const r = (await server.invoke("update_event_status", {
    event_id: "flagged",
    status: "REJECTED",
    ...extra,
  })) as { isError?: boolean; content: Array<{ text: string }> };
  if (r.isError) throw new Error(r.content[0]?.text);
}

describe("update_event_status — the OPE-450 default respects an OPE-1117 dismissal", () => {
  it("still defaults from the flag when nobody has dismissed it", async () => {
    await reject();
    expect(rejectedAs()).toEqual({ v: "keeper", s: "REJECTED" });
  });

  it("records NO adjudication when the pair was dismissed", async () => {
    dismiss();
    await reject();
    expect(rejectedAs()).toEqual({ v: null, s: "REJECTED" });
  });

  it("an explicit argument is a new ruling and still wins", async () => {
    dismiss();
    await reject({ rejected_as_duplicate_of: "keeper" });
    expect(rejectedAs()).toEqual({ v: "keeper", s: "REJECTED" });
  });
});
