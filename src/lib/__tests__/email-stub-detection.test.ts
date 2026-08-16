/**
 * OPE-369 — a stubbed send must become visible.
 *
 * `email_send_ledger.status='stubbed'` means the send was never attempted. All
 * 26 `indexnow:health` rows across a full month were stubbed, so the alert
 * warning us that an integration had gone silent was itself silent for a month.
 * It was discoverable only by querying the ledger by status — which is how it
 * was eventually found, by accident, rather than by anything reporting it.
 *
 * The regression sweep for this already existed at `/api/admin/email-stub-check`
 * and nothing had ever called it. So the property under test is not "can we
 * detect a stub" — that code existed and detected nothing for a month. It is
 * "does detecting one produce a row in a queue somebody reads."
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { healthIssues } from "../db/schema";

vi.mock("@/lib/sitemap/indexable-vendors", () => ({ getIndexableVendorRows: async () => [] }));

const { checkStubbedSends } = await import("../gsc-sweep");

const SCHEMA_SQL = `
  CREATE TABLE health_issues (
    id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, source TEXT, issue_type TEXT,
    severity TEXT, url TEXT, message TEXT, first_detected_at INTEGER,
    last_detected_at INTEGER, resolved_at INTEGER, resolution_reason TEXT,
    -- OPE-382 (drizzle/0188) — re-verify cursor; the pass selects on it.
    last_reverified_at INTEGER
  );
  CREATE TABLE email_send_ledger (
    message_id TEXT PRIMARY KEY, recipient TEXT, source TEXT, subject TEXT,
    status TEXT, provider TEXT, provider_message_id TEXT, error TEXT,
    inbound_email_id TEXT, body_html TEXT, body_text TEXT, sent_at INTEGER,
    -- OPE-177 (drizzle/0193) — delivery outcome columns.
    delivery_status TEXT, delivery_updated_at INTEGER, delivery_detail TEXT
  );
`;

let raw: Database.Database;
let db: any;

const newResult = () => ({
  inspected: 0,
  newIssues: 0,
  resolvedIssues: 0,
  skipped: 0,
  errors: [] as string[],
  resolvedByReason: {} as Record<string, number>,
});

const NOW = new Date("2026-08-11T12:00:00Z");
const hoursAgo = (h: number) => Math.floor((NOW.getTime() - h * 3600 * 1000) / 1000);

function ledger(id: string, source: string, status: string, sentAtSec: number) {
  raw
    .prepare(
      `INSERT INTO email_send_ledger (message_id, recipient, source, subject, status, provider, sent_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(id, "alert@meetmeatthefair.com", source, "subject", status, "stub", sentAtSec);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("checkStubbedSends (OPE-369)", () => {
  it("opens an ERROR health issue naming the sources that were swallowed", async () => {
    // The real shape: the indexnow health alert, stubbed, never attempted.
    ledger("m1", "indexnow:health", "stubbed", hoursAgo(2));
    ledger("m2", "indexnow:health", "stubbed", hoursAgo(20));

    const result = newResult();
    expect(await checkStubbedSends(db, NOW, result)).toBe(2);

    const [row]: any[] = await db.select().from(healthIssues);
    expect(row.resolvedAt).toBeNull();
    // ERROR, not WARNING — this is mail an operator believes was delivered and
    // was not. It is about someone not being told something.
    expect(row.severity).toBe("ERROR");
    expect(row.source).toBe("EMAIL_DELIVERY");
    expect(row.message).toContain("indexnow:health");
    expect(row.message).toContain("2 email(s) stubbed");
  });

  it("ignores sends that actually went out", async () => {
    ledger("m1", "vendor-digest", "sent", hoursAgo(2));
    ledger("m2", "agent-silence-watchdog", "sent", hoursAgo(3));

    const result = newResult();
    expect(await checkStubbedSends(db, NOW, result)).toBe(0);
    const rows = await db.select().from(healthIssues);
    // No open row. (recordHealthIssue with failing=false is a no-op when none exists.)
    expect(rows.filter((r: any) => !r.resolvedAt)).toHaveLength(0);
  });

  it("auto-closes once a clean window passes — no bespoke state", async () => {
    // The trap this file's sibling comment warns about: EMAIL_DELIVERY is NOT
    // in COLLECTED_SOURCES, so it cannot be closed by the generic resolve loop.
    // It has to close through its own failing=false path, or it would stay open
    // forever after a single stub — turning a real signal into permanent noise.
    ledger("m1", "indexnow:health", "stubbed", hoursAgo(2));
    await checkStubbedSends(db, NOW, newResult());
    let [row]: any[] = await db.select().from(healthIssues);
    expect(row.resolvedAt).toBeNull();

    // Next day: the stub is outside the 48h window and nothing new stubbed.
    const later = new Date("2026-08-14T12:00:00Z");
    const result = newResult();
    expect(await checkStubbedSends(db, later, result)).toBe(0);

    [row] = await db.select().from(healthIssues);
    expect(row.resolvedAt).not.toBeNull();
    expect(result.resolvedIssues).toBe(1);
  });

  it("does not look further back than its window", async () => {
    // A stub from last month is history, not a live fault — otherwise the row
    // could never close and the alert would be permanently on.
    ledger("m1", "indexnow:health", "stubbed", hoursAgo(24 * 30));

    const result = newResult();
    expect(await checkStubbedSends(db, NOW, result)).toBe(0);
  });

  it("reports every distinct source, not just the first", async () => {
    // The census found two more senders that would stub the same way and had
    // simply never fired (indexnow:auto-pause, kpi-alert:*). If one of them
    // ever does, the row must name it rather than hiding it behind the loudest.
    ledger("m1", "indexnow:health", "stubbed", hoursAgo(1));
    ledger("m2", "kpi-alert:conversion_rate", "stubbed", hoursAgo(1));
    ledger("m3", "indexnow:auto-pause", "stubbed", hoursAgo(1));

    await checkStubbedSends(db, NOW, newResult());
    const [row]: any[] = await db.select().from(healthIssues);
    expect(row.message).toContain("indexnow:health");
    expect(row.message).toContain("kpi-alert:conversion_rate");
    expect(row.message).toContain("indexnow:auto-pause");
  });
});
