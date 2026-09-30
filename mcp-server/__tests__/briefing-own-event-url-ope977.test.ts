/**
 * OPE-977 — the inbound briefing resolves OUR OWN event URL before any subject
 * matching, and its warnings say what evidence actually existed.
 *
 * The two specimens are the 2026-09-13 reader emails, rebuilt with their real
 * prod shapes (read from D1 today): series canonical slug + a 2026 occurrence,
 * a subject whose distinctive token is ambiguous across several events.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { buildVendorInquiryBriefing } from "../src/inbound/vendor-inquiry-briefing.js";
import { resolveOwnEventUrl } from "../src/inbound/own-event-url.js";
import type { Db } from "../src/db.js";

let db: TestDb;
let raw: { exec: (s: string) => unknown };
const T = (d: string) => Math.floor(new Date(d).getTime() / 1000);

function event(
  id: string,
  name: string,
  slug: string,
  start: string,
  extra: Record<string, string | null> = {}
) {
  const cols = [
    "id",
    "name",
    "slug",
    "promoter_id",
    "start_date",
    "end_date",
    "status",
    "lifecycle_status",
    ...Object.keys(extra),
  ];
  const vals = [
    `'${id}'`,
    `'${name.replace(/'/g, "''")}'`,
    `'${slug}'`,
    "'p1'",
    String(T(start)),
    String(T(start) + 86400),
    "'APPROVED'",
    "'SCHEDULED'",
    ...Object.values(extra).map((v) => (v === null ? "NULL" : `'${v}'`)),
  ];
  raw.exec(`INSERT INTO events (${cols.join(",")}) VALUES (${vals.join(",")})`);
}

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  raw = t.raw as unknown as typeof raw;
  raw.exec(
    `INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'Eagle Shows', 'eagle-shows')`
  );
  raw.exec(
    `INSERT INTO event_series (id, canonical_slug, name) VALUES ('s-marl', 'marlborough-gun-show-september', 'Marlborough Gun Show September')`
  );
  raw.exec(
    `INSERT INTO event_series (id, canonical_slug, name) VALUES ('s-add', 'a-different-drummer-craft-fair-september', 'A Different Drummer Craft Fair September')`
  );
  event(
    "7e294fa4-7413-4ca4-bc89-ca305cbedbe7",
    "Marlborough Gun Show September 2026",
    "marlborough-gun-show-september-2026",
    "2026-09-19T12:00:00Z",
    { series_id: "s-marl" }
  );
  event(
    "marl-2025",
    "Marlborough Gun Show September 2025",
    "marlborough-gun-show-september-2025",
    "2025-09-20T12:00:00Z",
    { series_id: "s-marl" }
  );
  event(
    "marl-other",
    "Marlborough Fall Craft Show",
    "marlborough-fall-craft-show",
    "2026-10-03T12:00:00Z"
  );
  event(
    "7e2a0a6f-b604-4738-8b11-2b0271907c16",
    "A Different Drummer Craft Fair September 2026",
    "a-different-drummer-craft-fair-september-2026",
    "2026-09-12T12:00:00Z",
    { series_id: "s-add" }
  );
  event(
    "add-nov",
    "A Different Drummer Craft Fair November 2026",
    "a-different-drummer-craft-fair-november-2026",
    "2026-11-14T12:00:00Z"
  );
});

const brief = (id: string, subject: string, parsedUrl: string | null) =>
  buildVendorInquiryBriefing(db as unknown as Db, {
    id,
    fromAddress: "reader@example.com",
    subject,
    parsedUrl,
  });

describe("OPE-977 — the two 2026-09-13 reader emails", () => {
  it("ACCEPTANCE: 4be31e4c (Marlborough) resolves to its event via our URL, with confidence", async () => {
    const b = await brief(
      "4be31e4c",
      "Marlborough gun show",
      "https://meetmeatthefair.com/events/marlborough-gun-show-september/2026"
    );
    expect(b.matchedEvent).toMatchObject({
      id: "7e294fa4-7413-4ca4-bc89-ca305cbedbe7",
      matchedOn: "own_event_url",
    });
    expect(b.confidence).not.toBeNull();
    expect(b.urlResolution).toMatchObject({
      status: "resolved",
      detail: expect.stringContaining("series-year"),
    });
    // It must not also carry the old "ambiguous token" give-up warning.
    expect(b.warnings.join("\n")).not.toMatch(/ambiguous|No event matched/);
  });

  it("ACCEPTANCE: d062567b (A Different Drummer) resolves to its event via our URL", async () => {
    const b = await brief(
      "d062567b",
      "A Different Drummer",
      "https://meetmeatthefair.com/events/a-different-drummer-craft-fair-september/2026"
    );
    expect(b.matchedEvent).toMatchObject({
      id: "7e2a0a6f-b604-4738-8b11-2b0271907c16",
      matchedOn: "own_event_url",
    });
  });

  it("LANDMARK: the same email WITHOUT the URL still gives up on the ambiguous subject (the old outcome)", async () => {
    const b = await brief("4be31e4c", "Marlborough gun show", null);
    expect(b.matchedEvent).toBeNull();
    expect(b.warnings.join("\n")).toMatch(/carries no URL/);
  });
});

describe("OPE-977 — URL shapes and fall-through", () => {
  it("ACCEPTANCE: a flat /events/<slug> URL resolves", async () => {
    const r = await resolveOwnEventUrl(
      db as unknown as Db,
      "https://www.meetmeatthefair.com/events/marlborough-fall-craft-show/"
    );
    expect(r).toMatchObject({ status: "resolved", via: "slug", event: { id: "marl-other" } });
  });

  it("a series occurrence whose slug is NOT <series>-<year> still resolves (the flat fallback cannot)", async () => {
    raw.exec(
      `INSERT INTO event_series (id, canonical_slug, name) VALUES ('s-fg', 'fryeburg-fair', 'Fryeburg Fair')`
    );
    event("fg-2026", "Fryeburg Fair 2026", "fryeburg-fair-me-2026-10", "2026-10-04T12:00:00Z", {
      series_id: "s-fg",
    });
    const r = await resolveOwnEventUrl(
      db as unknown as Db,
      "https://meetmeatthefair.com/events/fryeburg-fair/2026"
    );
    expect(r).toMatchObject({ status: "resolved", via: "series-year", event: { id: "fg-2026" } });
  });

  it("the year picks the right edition of a series", async () => {
    const r = await resolveOwnEventUrl(
      db as unknown as Db,
      "https://meetmeatthefair.com/events/marlborough-gun-show-september/2025"
    );
    expect(r).toMatchObject({ status: "resolved", event: { id: "marl-2025" } });
  });

  it("ACCEPTANCE: a non-MMATF URL falls through to subject matching, and the warning says the URL was not ours", async () => {
    const b = await brief("x1", "Marlborough gun show", "https://eagleshows.example/marlborough");
    expect(b.urlResolution).toMatchObject({ status: "not-ours", detail: "eagleshows.example" });
    expect(b.matchedEvent).toBeNull();
    expect(b.warnings.join("\n")).toMatch(/another site \(eagleshows\.example\)/);
    expect(b.warnings.join("\n")).not.toMatch(/carries no URL/);
  });

  it("ACCEPTANCE: a renamed event resolves through event_slug_history", async () => {
    raw.exec(
      `INSERT INTO event_slug_history (id, event_id, old_slug, new_slug, changed_at) VALUES ('h1', 'marl-other', 'marlborough-craft-show-old', 'marlborough-fall-craft-show', ${T("2026-08-01T00:00:00Z")})`
    );
    const r = await resolveOwnEventUrl(
      db as unknown as Db,
      "https://meetmeatthefair.com/events/marlborough-craft-show-old"
    );
    expect(r).toMatchObject({
      status: "resolved",
      via: "slug-history",
      event: { id: "marl-other" },
    });
  });

  it("ACCEPTANCE: a merge tombstone's URL resolves to the keeper", async () => {
    event(
      "dup",
      "Marlborough Fall Craft Show",
      "marlborough-fall-craft-show-merged-dup1",
      "2026-10-03T12:00:00Z",
      { merged_into: "marl-other" }
    );
    const b = await brief(
      "x2",
      "hello",
      "https://meetmeatthefair.com/events/marlborough-fall-craft-show-merged-dup1"
    );
    expect(b.matchedEvent).toMatchObject({ id: "marl-other", matchedOn: "own_event_url" });
    expect(b.warnings.join("\n")).toMatch(/OLD address \(merged-into\)/);
  });

  it("ACCEPTANCE: our URL for an event that does not exist says 'ours, did not resolve' — never 'no URL'", async () => {
    const b = await brief("x3", "hello", "https://meetmeatthefair.com/events/gone-for-good/2026");
    expect(b.urlResolution).toMatchObject({ status: "ours-unresolved" });
    const w = b.warnings.join("\n");
    expect(w).toMatch(
      /links OUR page \/events\/gone-for-good\/2026, but it resolves to no current event/
    );
    expect(w).toMatch(/link to our site did not resolve/);
    expect(w).not.toMatch(/carries no URL/);
  });

  it("our non-event page is named as such", async () => {
    const r = await resolveOwnEventUrl(
      db as unknown as Db,
      "https://meetmeatthefair.com/vendors/acme"
    );
    expect(r).toMatchObject({ status: "ours-not-an-event-page", path: "/vendors/acme" });
  });
});
