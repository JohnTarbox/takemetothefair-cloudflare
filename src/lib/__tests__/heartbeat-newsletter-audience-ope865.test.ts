/**
 * OPE-865 — the newsletter broadcast probes must be able to fail INDEPENDENTLY.
 *
 * ## What was wrong
 *
 * One probe, `newsletter-broadcast`, queried `newsletter_issues.sent_at` with no
 * `audience` filter, covering two independent newsletters. The weekend digest
 * sends far more often than the probe's 21-day window, so the vendor digest
 * could be silent indefinitely and the probe would never go stale — the vendor
 * list going dark being exactly the failure it read as covering.
 *
 * Then the accidental vendor broadcast of 2026-09-09 stamped `sent_at` and
 * refreshed the probe for BOTH audiences. The incident cleared the only signal
 * that might have reported it.
 *
 * It was never inert. It ran, and it would have fired if BOTH newsletters died.
 * It just could not distinguish the case anyone cares about — a control whose
 * population is wider than the condition it claims to watch.
 *
 * ## ⚠️ Amendment H — the specific trap here
 *
 * "The weekend probe finds no evidence" is satisfied by an EMPTY TABLE. So the
 * decisive test is not that each probe reports something; it is that seeding
 * ONE audience moves exactly ONE probe. Every case below asserts the row count
 * of both audiences before reading the verdicts, so a query that silently
 * matches nothing cannot pass as a clean separation.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE newsletter_issues (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, subject TEXT NOT NULL,
    html TEXT, audience TEXT NOT NULL DEFAULT 'weekend',
    sent_at INTEGER, created_at INTEGER NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const weekendProbe = HEARTBEAT_PROBES.find((p) => p.name === "newsletter-broadcast-weekend")!;
const vendorProbe = HEARTBEAT_PROBES.find((p) => p.name === "newsletter-broadcast-vendor")!;

function seedIssue(slug: string, audience: string, sentAt: string | null) {
  raw
    .prepare(
      `INSERT INTO newsletter_issues (id, slug, subject, audience, sent_at, created_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(slug, slug, `Subject ${slug}`, audience, sentAt ? T(sentAt) : null, T("2026-09-01"));
}

const countBy = (audience: string): number =>
  (
    raw
      .prepare(
        `SELECT COUNT(*) AS n FROM newsletter_issues WHERE audience = ? AND sent_at IS NOT NULL`
      )
      .get(audience) as { n: number }
  ).n;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("OPE-865 — both probes exist and are declared separately", () => {
  it("the un-filtered predecessor is gone from the registry", () => {
    expect(HEARTBEAT_PROBES.find((p) => p.name === "newsletter-broadcast")).toBeUndefined();
  });

  it("both halves are declared", () => {
    expect(weekendProbe).toBeDefined();
    expect(vendorProbe).toBeDefined();
  });
});

describe("OPE-865 — a send on one list does not refresh the other's probe", () => {
  it("REGRESSION: a weekend broadcast leaves the VENDOR probe with no evidence", async () => {
    seedIssue("weekend-recent", "weekend", "2026-09-08T11:00:00Z");

    // ⚠️ The landmark. Without it, "vendor sees nothing" is satisfied by an
    // empty table and this test would pass with both queries broken.
    expect(countBy("weekend")).toBe(1);
    expect(countBy("vendor")).toBe(0);

    await expect(weekendProbe.lastEvidenceAt(db)).resolves.toBeInstanceOf(Date);
    await expect(vendorProbe.lastEvidenceAt(db)).resolves.toBeNull();
  });

  it("REGRESSION: a vendor broadcast leaves the WEEKEND probe with no evidence", async () => {
    // The 2026-09-09 incident, as an assertion. Under the old un-filtered
    // query this send refreshed both halves at once.
    seedIssue("vendor-accident", "vendor", "2026-09-09T02:05:00Z");

    expect(countBy("vendor")).toBe(1);
    expect(countBy("weekend")).toBe(0);

    await expect(vendorProbe.lastEvidenceAt(db)).resolves.toBeInstanceOf(Date);
    await expect(weekendProbe.lastEvidenceAt(db)).resolves.toBeNull();
  });

  it("with BOTH audiences present, each probe reads its OWN latest send", async () => {
    // The decisive case: both queries return a value, and the values differ.
    // A probe pair that returned the table-wide max would pass both tests above
    // whenever only one audience existed, and fail only here.
    seedIssue("weekend-old", "weekend", "2026-08-20T11:00:00Z");
    seedIssue("vendor-new", "vendor", "2026-09-09T02:05:00Z");

    expect(countBy("weekend")).toBe(1);
    expect(countBy("vendor")).toBe(1);

    const w = await weekendProbe.lastEvidenceAt(db);
    const v = await vendorProbe.lastEvidenceAt(db);
    expect(w?.toISOString()).toBe("2026-08-20T11:00:00.000Z");
    expect(v?.toISOString()).toBe("2026-09-09T02:05:00.000Z");
    expect(w!.getTime()).toBeLessThan(v!.getTime());
  });

  it("an unsent issue is not evidence, on either half", async () => {
    // `sent_at` NULL is a composed-but-never-broadcast issue — the whole reason
    // OPE-284 keyed this probe on sent_at rather than the send ledger.
    seedIssue("weekend-draft", "weekend", null);
    seedIssue("vendor-draft", "vendor", null);

    expect(countBy("weekend")).toBe(0);
    expect(countBy("vendor")).toBe(0);

    await expect(weekendProbe.lastEvidenceAt(db)).resolves.toBeNull();
    await expect(vendorProbe.lastEvidenceAt(db)).resolves.toBeNull();
  });

  it("takes the LATEST send per audience, not the first", async () => {
    seedIssue("weekend-old", "weekend", "2026-08-01T11:00:00Z");
    seedIssue("weekend-new", "weekend", "2026-09-05T11:00:00Z");
    expect(countBy("weekend")).toBe(2);
    await expect(weekendProbe.lastEvidenceAt(db)).resolves.toEqual(
      new Date("2026-09-05T11:00:00Z")
    );
  });
});

describe("OPE-865 — the vendor probe's window is a placeholder, not a measurement", () => {
  it("carries the weekend window verbatim, which is the tell", () => {
    // Documented rather than asserted-as-correct on purpose. The vendor probe
    // ships DORMANT (enabled_at NULL, drizzle/0277) precisely because no window
    // can be measured yet: Path A is supposed to be silent under the parked
    // OPE-710(a) ruling, and Path B writes no newsletter_issues row at all.
    //
    // If someone arms it, they must replace this number first. A window chosen
    // by analogy is what produced the wrong 72h figure on OPE-830 against a
    // real 12-day gap.
    expect(vendorProbe.expectedWindowHours).toBe(weekendProbe.expectedWindowHours);
  });
});
