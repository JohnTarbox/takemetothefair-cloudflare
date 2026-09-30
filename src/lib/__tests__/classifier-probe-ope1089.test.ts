/**
 * OPE-1089 — the classifier-execution probe watches the ANSWER, not the attempt.
 *
 * This distinction is the whole probe. A classifier that runs and fails on
 * every single call writes `classified_at` exactly like a healthy one, so a
 * probe keyed on "did the classifier run" would have stayed green through both
 * real outages: the 2026-05-22 3B swap (non-string `.response`, every email
 * routed `classifier-no-json` for days) and the 2026-06-15 8B deprecation
 * (error 5028 on every call). Keyed on routing_source, both go red.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

let sqlite: Database.Database;
const db = () => drizzle(sqlite, { schema }) as never;

const probe = () => {
  const p = HEARTBEAT_PROBES.find((x) => x.name === "classifier-execution");
  expect(p, "classifier-execution probe is not registered — this test is inert").toBeTruthy();
  return p!;
};

const SEC = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function insert(id: string, routingSource: string | null, classifiedAt: string) {
  sqlite
    .prepare("INSERT INTO inbound_emails (id, routing_source, classified_at) VALUES (?, ?, ?)")
    .run(id, routingSource, SEC(classifiedAt));
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE inbound_emails (
      id TEXT PRIMARY KEY,
      routing_source TEXT,
      classified_at INTEGER
    );
  `);
});

describe("OPE-1089 — classifier-execution probe evidence", () => {
  it("counts the three routing_sources only a live classifier can write", async () => {
    insert("a", "classifier", "2026-09-01T00:00:00Z");
    insert("b", "classifier_override", "2026-09-05T00:00:00Z");
    insert("c", "fallback_low_confidence", "2026-09-10T00:00:00Z");

    // Newest of the three.
    expect(await probe().lastEvidenceAt(db())).toEqual(new Date("2026-09-10T00:00:00Z"));
  });

  it("ACCEPTANCE: address_only does NOT count — a failing classifier is not evidence", async () => {
    insert("ok", "classifier", "2026-09-01T00:00:00Z");
    // Every call failing after that date. This is exactly the 3B and 5028
    // outage shape: rows keep being written, classified_at keeps advancing.
    insert("dead1", "address_only", "2026-09-18T00:00:00Z");
    insert("dead2", "address_only", "2026-09-19T00:00:00Z");
    insert("dead3", "address_only", "2026-09-20T00:00:00Z");

    // The probe must still report the LAST GOOD answer, so the silence is
    // measured from there and the probe goes red.
    expect(await probe().lastEvidenceAt(db())).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("trusted_fastpath does not count either — the classifier was skipped, not answered", async () => {
    insert("ok", "classifier", "2026-09-01T00:00:00Z");
    insert("fast", "trusted_fastpath", "2026-09-20T00:00:00Z");

    expect(await probe().lastEvidenceAt(db())).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("no successful classification ever → null, which is what a dormant/never-run path reports", async () => {
    insert("dead", "address_only", "2026-09-20T00:00:00Z");
    expect(await probe().lastEvidenceAt(db())).toBeNull();
  });

  it("the window is 240h and is sized off the MEASURED max gap, not the mean", () => {
    // n=209 successes: max gap 167.6h all-time, 142.3h in 90d, mean 14.1h.
    // A window near the mean would fire on any ordinary quiet week.
    expect(probe().expectedWindowHours).toBe(240);
    expect(probe().expectedWindowHours).toBeGreaterThan(167.6);
  });
});
