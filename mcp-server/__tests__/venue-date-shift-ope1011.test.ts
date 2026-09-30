/**
 * OPE-1011 — an upcoming public event whose start renders as a different day in
 * Eastern than it stores is an invariant break the operator notice reports.
 *
 * Fixtures are the storage classes measured on prod 2026-09-14: the noon anchor,
 * local midnight at 04:00Z (correct in EDT, a day early in EST), and a real clock
 * time. Every refusal case has a positive landmark beside it — a reader that
 * always returned 0 would pass the clean cases alone.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./setup-db.js";
import { readOperatorQueues, totalWaiting } from "../src/operator-queue-notice.js";

const NOW = new Date("2026-09-15T12:00:00Z");
let raw: ReturnType<typeof createTestDb>["raw"];
let db: ReturnType<typeof createTestDb>["db"];

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

function seedEvent(
  slug: string,
  startIso: string,
  opts: { status?: string; publicStartIso?: string; mergedInto?: string } = {}
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, status, start_date, public_start_date, merged_into)
       VALUES (?, ?, ?, 'p1', ?, ?, ?, ?)`
    )
    .run(
      `id-${slug}`,
      slug,
      slug,
      opts.status ?? "APPROVED",
      Math.floor(new Date(startIso).getTime() / 1000),
      opts.publicStartIso ? Math.floor(new Date(opts.publicStartIso).getTime() / 1000) : null,
      opts.mergedInto ?? null
    );
}

describe("venueDateShifts", () => {
  it("LANDMARK: a winter local-midnight (04:00Z in EST) start is reported", async () => {
    seedEvent("winter-show", "2026-11-15T04:00:00Z");
    const q = await readOperatorQueues(db as never, NOW);
    expect(q.venueDateShifts).toBe(1);
    expect(q.lines.some((l) => l.includes("winter-show") && l.includes("OPE-1011"))).toBe(true);
    expect(totalWaiting(q)).toBeGreaterThan(0);
  });

  it("reports a shifted public_start_date even when start_date is clean", async () => {
    seedEvent("public-shift", "2026-12-05T12:00:00Z", { publicStartIso: "2026-12-06T04:30:00Z" });
    expect((await readOperatorQueues(db as never, NOW)).venueDateShifts).toBe(1);
  });

  it("does NOT report the noon anchor, a summer 04:00Z, or a real daytime clock time", async () => {
    seedEvent("noon", "2026-11-15T12:00:00Z");
    seedEvent("summer-local-midnight", "2026-09-20T04:00:00Z");
    seedEvent("winter-local-midnight-est", "2026-12-12T05:00:00Z");
    seedEvent("nine-am", "2026-10-03T13:00:00Z");
    const q = await readOperatorQueues(db as never, NOW);
    expect(q.venueDateShifts).toBe(0);
  });

  it("ignores past, merged and non-public rows", async () => {
    seedEvent("past-winter", "2025-12-01T04:00:00Z");
    seedEvent("merged-winter", "2026-11-15T04:00:00Z", { mergedInto: "id-other" });
    seedEvent("pending-winter", "2026-11-16T04:00:00Z", { status: "PENDING" });
    expect((await readOperatorQueues(db as never, NOW)).venueDateShifts).toBe(0);
  });
});
