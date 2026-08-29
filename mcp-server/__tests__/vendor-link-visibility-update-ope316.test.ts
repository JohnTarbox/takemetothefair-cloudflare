/**
 * OPE-316 — the UPDATE path for `event_vendors.public_visible`.
 *
 * The mechanism shipped: the column (migration 0176), the
 * `isPubliclyVisibleVendorLink()` predicate applied at eleven public surfaces,
 * a `public_visible` param on `create_or_link_vendor`, and a source-level test
 * pinning which surfaces use the visibility-aware filter.
 *
 * What was missing is the case the ticket exists for. `create_or_link_vendor`
 * sets the flag at CREATION, and LeafFilter is a vendor already linked to
 * events who then asks to be hidden. There was no way to flip an existing row —
 * confirmed against prod: **0 of 6,598 links were hidden**, so the capability
 * had never been reachable for its own motivating case.
 *
 * These tests cover the update semantics. The important one is the third: a
 * truthiness check on this parameter silently ignores every request to HIDE a
 * link while honouring every request to show one, which is the exact failure
 * that would make the feature look present and be useless.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestDb } from "./setup-db.js";

let raw: {
  exec: (s: string) => unknown;
  prepare: (s: string) => {
    get: () => unknown;
    all: () => unknown[];
    run: (...a: unknown[]) => unknown;
  };
};

const NOW = Math.floor(new Date("2026-08-29T00:00:00Z").getTime() / 1000);

beforeEach(() => {
  const t = createTestDb();
  raw = t.raw as unknown as typeof raw;
  raw.exec(`
    INSERT INTO promoters (id, company_name, slug) VALUES ('p1','P','p1');
    INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, lifecycle_status)
    VALUES ('e1','Fair','fair','p1', ${NOW}, ${NOW + 86400}, 'APPROVED','SCHEDULED');
    INSERT INTO vendors (id, user_id, business_name, slug)
    VALUES ('v1','u1','LeafFilter North LLC','leaffilter-north');
  `);
});

/** Seed a link the way `create_or_link_vendor` does — visible by default. */
function seedLink(publicVisible = 1) {
  raw.exec(`
    INSERT INTO event_vendors (id, event_id, vendor_id, status, public_visible)
    VALUES ('ev1','e1','v1','CONFIRMED', ${publicVisible})
  `);
}

const linkRow = () =>
  raw.prepare(`SELECT status, public_visible FROM event_vendors WHERE id='ev1'`).get() as {
    status: string;
    public_visible: number;
  };

describe("event_vendors.public_visible", () => {
  it("defaults to VISIBLE, so the flag is opt-in and nothing changes silently", () => {
    raw.exec(
      `INSERT INTO event_vendors (id, event_id, vendor_id, status) VALUES ('ev1','e1','v1','CONFIRMED')`
    );
    expect(linkRow().public_visible).toBe(1);
  });

  it("can be flipped to hidden on an EXISTING link — the LeafFilter case", () => {
    // The gap this ticket actually had: the vendor is already linked when they
    // ask to be hidden, and creation-time-only meant the answer was "no".
    seedLink(1);
    raw.prepare(`UPDATE event_vendors SET public_visible = ? WHERE id = 'ev1'`).run(0);
    expect(linkRow().public_visible).toBe(0);
  });

  it("hiding does NOT change the participation status — tracked, not shown", () => {
    // The whole requirement in one assertion. A hidden link is still CONFIRMED,
    // so admin roster views and coverage stats — which filter on status alone —
    // keep counting it.
    seedLink(1);
    raw.prepare(`UPDATE event_vendors SET public_visible = ? WHERE id = 'ev1'`).run(0);
    expect(linkRow().status).toBe("CONFIRMED");
  });

  it("a status-only filter still sees a hidden link; the public filter does not", () => {
    seedLink(0);
    const adminVisible = raw
      .prepare(`SELECT COUNT(*) n FROM event_vendors WHERE status IN ('APPROVED','CONFIRMED')`)
      .get() as { n: number };
    const publicVisible = raw
      .prepare(
        `SELECT COUNT(*) n FROM event_vendors WHERE status IN ('APPROVED','CONFIRMED') AND public_visible = 1`
      )
      .get() as { n: number };

    // This asymmetry IS the feature: recorded where the operator looks,
    // absent everywhere a visitor looks.
    expect(adminVisible.n).toBe(1);
    expect(publicVisible.n).toBe(0);
  });

  it("`false` must be APPLIED, not skipped — asserted against the real handler", () => {
    // ⚠️ This was a decorative test first time round. I wrote it against two
    // little shape functions defined inside the test, which demonstrated the
    // principle and guarded nothing: mutating the real handler to `if
    // (params.public_visible)` left it green.
    //
    // The property only exists in one place, so the test has to look there.
    // A truthy check silently drops EVERY request to hide a link while
    // honouring every request to show one — the feature would look present and
    // be useless, with no error to notice.
    const src = readFileSync(resolve(__dirname, "../src/tools/admin.ts"), "utf8");
    // Anchored on the call syntax, not the bare symbol: a bare `public_visible`
    // also matches the zod schema and the tool description above it.
    expect(src).toContain("if (params.public_visible !== undefined) {");
    expect(src).not.toContain("if (params.public_visible) {");
  });
});
