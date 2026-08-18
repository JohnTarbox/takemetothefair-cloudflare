/**
 * OPE-432 — a merge tombstone is not a duplicate candidate.
 *
 * `merge_events` does not delete the losing row. It renames the slug to
 * `<orig>-merged-<id8>`, writes `event_slug_history` so the old URL 301s,
 * sets `status='REJECTED'` and `merged_into=<keeper>`, and keeps the row as an
 * audit tombstone. What remains is a redirect, not an event.
 *
 * Reproduced live 2026-08-17 while entering the missing 2028 Martha's Vineyard
 * edition. `suggest_event` refused it and named as the duplicate a row whose
 * slug was already `marthas-vineyard-agricultural-fair-2026-merged-4acbfcb3` —
 * a URL that redirects away from itself. An operator had to pass
 * `force_create: true` to enter a legitimate event, which is exactly the
 * override that should be reserved for overruling a real duplicate.
 *
 * Prod scale, measured 2026-08-18:
 *   48 merge tombstones, 46 with a `source_url` over 44 distinct URLs
 *   23 of them future-dated — inside the ±7d window stages 2–4 match on
 *   98 (venue, ±7d) windows hold a dead row alongside a live one; 49 future
 *
 * That last number is why ordering matters as much as filtering: every stage
 * is `limit(1)` over a set that often has more than one row, and none of them
 * ordered it. Which event a submitter was told they duplicated depended on
 * SQLite's scan order.
 *
 * Real in-memory SQLite, so these exercise the actual SQL rather than a mocked
 * query builder — and both directions are pinned. A change that only proved
 * "the tombstone does not block" would be indistinguishable from deleting the
 * guard, so the live-event cases assert it still refuses.
 *
 * ── Which mechanism covers which case ──────────────────────────────────────
 *
 * Reverting each half separately shows they are not redundant, and that the
 * division of labour is not the obvious one:
 *
 *   tombstone + keeper both in the window   the ORDERING fixes it — APPROVED
 *                                           sorts ahead of the REJECTED
 *                                           tombstone, so the keeper wins
 *   tombstone alone in the window           only the FILTER fixes it; there is
 *                                           nothing to out-sort it, and the
 *                                           submitter is refused against a
 *                                           row that redirects elsewhere
 *
 * So the filter is what makes the guarantee unconditional. Without it the
 * correct answer would depend on whether the keeper happened to share the
 * window — which it does after a merge, but not after the keeper is later
 * rescheduled, re-merged, or deleted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";

// Stage 1 and stage 3 are what these cover; venue resolution stays inert so
// the fixture does not need the venue-matching tables.
vi.mock("@/lib/venue-matching", () => ({
  autoLinkVenue: vi.fn(async () => ({ venueId: null, decision: "no-match" })),
}));

import { findDuplicate } from "../find-duplicate";

const MV_URL = "https://marthasvineyardagriculturalsociety.org/the-fair";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, slug TEXT, name TEXT,
    start_date INTEGER, end_date INTEGER,
    status TEXT, source_url TEXT, venue_id TEXT,
    series_id TEXT, rolled_from_event_id TEXT,
    merged_into TEXT
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY, name TEXT, city TEXT, state TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

interface SeedOpts {
  id: string;
  name: string;
  startIso: string;
  sourceUrl?: string | null;
  status?: string;
  mergedInto?: string | null;
  venueId?: string | null;
  slug?: string;
}

function seed(o: SeedOpts) {
  raw
    .prepare(
      `INSERT INTO events (id, slug, name, start_date, status, source_url, venue_id, merged_into)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      o.id,
      o.slug ?? o.id,
      o.name,
      epoch(o.startIso),
      o.status ?? "APPROVED",
      o.sourceUrl ?? null,
      o.venueId ?? null,
      o.mergedInto ?? null
    );
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the refusal that prompted this ticket", () => {
  beforeEach(() => {
    // The tombstone as merge_events actually leaves it: REJECTED, merged_into
    // set, slug already rewritten to the -merged- form.
    seed({
      id: "4acbfcb3",
      slug: "marthas-vineyard-agricultural-fair-2026-merged-4acbfcb3",
      name: "Martha's Vineyard Agricultural Fair 2026",
      startIso: "2026-08-13",
      sourceUrl: MV_URL,
      status: "REJECTED",
      mergedInto: "ce52e387",
    });
    // Its keeper — the live 2026 edition the tombstone redirects to.
    seed({
      id: "ce52e387",
      name: "Martha's Vineyard Agricultural Fair 2026",
      startIso: "2026-08-13",
      sourceUrl: MV_URL,
    });
  });

  it("does not refuse the 2028 edition against a 2026 tombstone", async () => {
    const res = await findDuplicate(db, {
      sourceUrl: MV_URL,
      name: "Martha's Vineyard Agricultural Fair 2028",
      startDate: "2028-08-10",
    });

    // The URL genuinely is shared — the organizer publishes four editions on
    // one page — so saying so is right. Claiming it is the SAME event is not.
    if (!res.isDuplicate) throw new Error("expected the shared source to be reported");
    expect(res.identifiesSameEvent).toBe(false);
    expect(res.existingEvent.id).not.toBe("4acbfcb3");
  });

  it("never names a tombstone as the duplicate, even when the dates DO agree", async () => {
    // A resubmission of the 2026 edition. Both the tombstone and its keeper sit
    // in the window on the same URL and the same day, which is precisely the
    // state a merge leaves behind — so this is the case where an unordered
    // limit(1) could return either.
    const res = await findDuplicate(db, {
      sourceUrl: MV_URL,
      name: "Martha's Vineyard Agricultural Fair",
      startDate: "2026-08-13",
    });

    if (!res.isDuplicate) throw new Error("a genuine duplicate must still be refused");
    expect(res.matchType).toBe("exact_url");
    expect(res.identifiesSameEvent).toBe(true);
    // The keeper, never the redirect.
    expect(res.existingEvent.id).toBe("ce52e387");
    expect(res.existingEvent.slug).not.toContain("-merged-");
  });

  it("reports no same-event match at all when ONLY the tombstone remains", async () => {
    // Delete the keeper: the tombstone is now the sole row on that URL and
    // date. Before the fix this returned `exact_url` + identifiesSameEvent,
    // handing the submitter a slug that 301s elsewhere. The event genuinely is
    // absent, so intake must be free to create it.
    raw.prepare(`DELETE FROM events WHERE id = 'ce52e387'`).run();

    const res = await findDuplicate(db, {
      sourceUrl: MV_URL,
      name: "Martha's Vineyard Agricultural Fair",
      startDate: "2026-08-13",
    });

    expect(res.isDuplicate).toBe(false);
  });
});

describe("the guard is not weakened for live rows", () => {
  it("still refuses a genuine same-URL, same-date duplicate", async () => {
    seed({
      id: "live-1",
      name: "Cummington Fair 2026",
      startIso: "2026-08-28",
      sourceUrl: "https://cummingtonfair.com",
    });

    const res = await findDuplicate(db, {
      sourceUrl: "https://cummingtonfair.com",
      name: "Cummington Fair",
      startDate: "2026-08-28",
    });

    if (!res.isDuplicate) throw new Error("expected a block");
    expect(res.identifiesSameEvent).toBe(true);
    expect(res.existingEvent.id).toBe("live-1");
  });

  it("still sees PENDING rows — the OPE-437 property, asserted behaviourally", () => {
    // dedup-sees-nonpublic-events.test.ts asserts this at source level (no
    // status predicate in the file). This asserts the consequence: a PENDING
    // row must still match, or re-ingesting a source creates a second copy of
    // an event nobody has reviewed yet.
    seed({
      id: "pending-1",
      name: "Martha's Vineyard Agricultural Fair 2028",
      startIso: "2028-08-10",
      sourceUrl: MV_URL,
      status: "PENDING",
    });

    return findDuplicate(db, {
      sourceUrl: MV_URL,
      name: "Martha's Vineyard Agricultural Fair 2028",
      startDate: "2028-08-10",
    }).then((res) => {
      if (!res.isDuplicate) throw new Error("PENDING rows must remain visible to dedup");
      expect(res.existingEvent.id).toBe("pending-1");
      expect(res.existingEvent.status).toBe("PENDING");
    });
  });

  it("still matches a REJECTED row that was NOT merged", async () => {
    // Deliberate, and the reason this fix keys on `merged_into` rather than on
    // `status='REJECTED'` as the ticket first proposed. OPE-278 exists to stop
    // attendee-list and list-broker spam from being classified new_event and
    // creating events; what an operator rejects is largely that. Blind dedup to
    // REJECTED rows and the same spam is re-creatable on every resubmission,
    // with nothing left to match it against.
    //
    // The thing that was actually wrong — telling a submitter it is "already in
    // our directory" — is a message, and `status` is on the result so the
    // caller can say something true instead.
    seed({
      id: "rejected-1",
      name: "Attendee List — New England Fairs 2026",
      startIso: "2026-09-05",
      sourceUrl: "https://list-broker.example.com/offer",
      status: "REJECTED",
      mergedInto: null,
    });

    const res = await findDuplicate(db, {
      sourceUrl: "https://list-broker.example.com/offer",
      name: "Attendee List — New England Fairs 2026",
      startDate: "2026-09-05",
    });

    if (!res.isDuplicate) throw new Error("a rejected submission must stay matchable");
    expect(res.existingEvent.id).toBe("rejected-1");
    expect(res.existingEvent.status).toBe("REJECTED");
  });
});

describe("a window with several live candidates resolves deterministically", () => {
  it("prefers the APPROVED row over a PENDING one at the same venue and date", async () => {
    // 98 such windows exist in prod. Both rows are legitimate matches; the
    // question is only which one the submitter is shown. An APPROVED event is
    // the one they can actually go and look at.
    seed({
      id: "zzz-approved",
      name: "Topsham Fair 2026",
      startIso: "2026-08-11",
      sourceUrl: "https://topshamfair.net",
      status: "APPROVED",
    });
    seed({
      id: "aaa-pending",
      name: "Topsham Fair 2026",
      startIso: "2026-08-11",
      sourceUrl: "https://topshamfair.net",
      status: "PENDING",
    });

    // Asked twice: the answer must not depend on scan order. `aaa-pending`
    // sorts first by id, so a plain `ORDER BY id` would pick the wrong one and
    // this would fail.
    for (let i = 0; i < 2; i++) {
      const res = await findDuplicate(db, {
        sourceUrl: "https://topshamfair.net",
        name: "Topsham Fair",
        startDate: "2026-08-11",
      });
      if (!res.isDuplicate) throw new Error("expected a match");
      expect(res.existingEvent.id).toBe("zzz-approved");
    }
  });
});
