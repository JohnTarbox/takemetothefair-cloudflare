/**
 * OPE-829 — `is_publicly_visible` must answer the question it is read for.
 *
 * It is the field an operator or agent reads to confirm a retirement took
 * effect. It read `event.status === "APPROVED"` alone, ignoring
 * `lifecycle_status`, while every public reader filters on `publicEventWhere()`
 * — `status IN (APPROVED, TENTATIVE) AND lifecycle IN PUBLIC_LIFECYCLE_STATUSES`.
 *
 * ⚠️ The filed ticket found the false-POSITIVE half. Measured in prod
 * 2026-09-07, the false-NEGATIVE half is 38x larger and was not in the ticket:
 *
 *   said TRUE while hidden   6 rows   APPROVED+CANCELLED (2), APPROVED+NO_SHOW (4)
 *   said FALSE while live  230 rows   status TENTATIVE (126 SCHEDULED, 104 TENTATIVE)
 *
 * An operator asking "is this live?" was told **no** for 230 events that are.
 *
 * ⚠️ Note where this misconception has been before: OPE-597 corrected this very
 * file's tool DESCRIPTION for claiming the public reader hides TENTATIVE. The
 * prose was fixed; the code two hundred lines below it still said the same
 * wrong thing.
 *
 * These tests drive the TOOL, not the helper. A test of `isPubliclyVisible`
 * alone would stay green if someone rewrote the tool's inline expression back
 * to a bare status check — which is the regression worth catching.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminEventReadTools } from "../src/tools/admin-event-read.js";
import { events } from "../src/schema.js";
import { eq } from "drizzle-orm";

function collect() {
  const tools = new Map<string, (a: never) => Promise<{ content: Array<{ text: string }> }>>();
  const server = {
    tool: (n: string, _d: string, _s: unknown, cb: (a: never) => Promise<never>) =>
      void tools.set(n, cb as never),
  } as never;
  return { server, tools };
}

let db: TestDb;
let tools: ReturnType<typeof collect>["tools"];

async function visible(slug: string): Promise<boolean> {
  const res = await tools.get("get_event_details_admin")!({ slug } as never);
  return JSON.parse(res.content[0].text).is_publicly_visible;
}

/** The four real prod rows the ticket names, plus the cohort it missed. */
const ROWS = [
  // filed: retired via lifecycle, must now read false
  { id: "e1", slug: "ledyard-fair-2026", status: "APPROVED", lifecycleStatus: "CANCELLED" },
  { id: "e2", slug: "makers-on-main-august", status: "APPROVED", lifecycleStatus: "NO_SHOW" },
  // filed: positive landmarks — these must NOT move
  {
    id: "e3",
    slug: "charlestown-seafood-festival-2026",
    status: "APPROVED",
    lifecycleStatus: "SCHEDULED",
  },
  {
    id: "e4",
    slug: "2026-bonny-eagle-craft-fair",
    status: "REJECTED",
    lifecycleStatus: "SCHEDULED",
  },
  // NOT filed: the 230-row false-negative cohort
  {
    id: "e5",
    slug: "tentative-editorial-scheduled",
    status: "TENTATIVE",
    lifecycleStatus: "SCHEDULED",
  },
  {
    id: "e6",
    slug: "tentative-editorial-tentative",
    status: "TENTATIVE",
    lifecycleStatus: "TENTATIVE",
  },
  // evergreen: a past event stays public on purpose
  { id: "e7", slug: "approved-occurred", status: "APPROVED", lifecycleStatus: "OCCURRED" },
];

beforeEach(async () => {
  ({ db } = createTestDb());
  const c = collect();
  registerAdminEventReadTools(c.server, db as never, { role: "ADMIN", userId: "u" } as never);
  tools = c.tools;

  for (const r of ROWS) {
    await db.insert(events).values({
      ...r,
      name: r.slug,
      description: "x",
      promoterId: "p1",
      startDate: new Date("2026-09-01T00:00:00Z"),
      endDate: new Date("2026-09-02T00:00:00Z"),
      datesConfirmed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
  }
});

describe("OPE-829 — the filed acceptance", () => {
  it("a lifecycle-retired event reads false (CANCELLED)", async () => {
    expect(await visible("ledyard-fair-2026")).toBe(false);
  });

  it("a lifecycle-retired event reads false (NO_SHOW)", async () => {
    expect(await visible("makers-on-main-august")).toBe(false);
  });

  it("the positive landmarks are unmoved — a live event still true, a rejected one still false", async () => {
    // Without these the two assertions above are satisfiable by returning
    // `false` unconditionally, which is the vacuous fix.
    expect(await visible("charlestown-seafood-festival-2026")).toBe(true);
    expect(await visible("2026-bonny-eagle-craft-fair")).toBe(false);
  });

  it("acceptance item 3 — flipping the lifecycle back makes it true again", async () => {
    // The ticket asks for this explicitly: a fix never observed to CHANGE its
    // answer is a hypothesis about a fix. Done here rather than against prod,
    // where it would be an unapproved write to a live row.
    expect(await visible("ledyard-fair-2026")).toBe(false);
    await db.update(events).set({ lifecycleStatus: "SCHEDULED" }).where(eq(events.id, "e1")).run();
    expect(await visible("ledyard-fair-2026")).toBe(true);
    await db.update(events).set({ lifecycleStatus: "CANCELLED" }).where(eq(events.id, "e1")).run();
    expect(await visible("ledyard-fair-2026")).toBe(false);
  });
});

describe("OPE-829 — the half the ticket missed: 230 live rows read as hidden", () => {
  it("editorial TENTATIVE is publicly served and must read true", async () => {
    // PUBLIC_EVENT_STATUSES has always been [APPROVED, TENTATIVE]; the public
    // category pages render these badged. OPE-597 already had to correct this
    // file's description for the same misconception.
    expect(await visible("tentative-editorial-scheduled")).toBe(true);
    expect(await visible("tentative-editorial-tentative")).toBe(true);
  });

  it("an OCCURRED event stays true — evergreen by design, not an oversight", async () => {
    expect(await visible("approved-occurred")).toBe(true);
  });
});

describe("OPE-829 — the flag agrees with the reader across the whole matrix", () => {
  it("matches publicEventWhere() on every status x lifecycle combination", async () => {
    const { PUBLIC_EVENT_STATUSES, PUBLIC_LIFECYCLE_STATUSES } =
      await import("@takemetothefair/constants");
    const statuses = ["APPROVED", "TENTATIVE", "PENDING", "REJECTED", "DRAFT", "CANCELLED"];
    const lifecycles = [
      "SCHEDULED",
      "TENTATIVE",
      "POSTPONED",
      "RESCHEDULED",
      "OCCURRED",
      "MOVED_ONLINE",
      "CANCELLED",
      "NO_SHOW",
    ];

    let checked = 0;
    let expectedTrue = 0;
    for (const status of statuses) {
      for (const lifecycleStatus of lifecycles) {
        ({ db } = createTestDb());
        const c = collect();
        registerAdminEventReadTools(c.server, db as never, { role: "ADMIN", userId: "u" } as never);
        tools = c.tools;
        await db.insert(events).values({
          id: "m1",
          slug: "matrix-row",
          name: "matrix",
          description: "x",
          status,
          lifecycleStatus,
          promoterId: "p1",
          startDate: new Date("2026-09-01T00:00:00Z"),
          endDate: new Date("2026-09-02T00:00:00Z"),
          datesConfirmed: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never);

        const want =
          (PUBLIC_EVENT_STATUSES as readonly string[]).includes(status) &&
          (PUBLIC_LIFECYCLE_STATUSES as readonly string[]).includes(lifecycleStatus);
        expect(await visible("matrix-row"), `${status} x ${lifecycleStatus}`).toBe(want);
        checked++;
        if (want) expectedTrue++;
      }
    }

    // Positive landmarks: the matrix was actually walked, and it contains BOTH
    // outcomes. An all-false matrix would pass a naive version of this test.
    expect(checked).toBe(48);
    expect(expectedTrue).toBe(12);
  });
});
