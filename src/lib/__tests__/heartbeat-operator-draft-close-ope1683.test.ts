/**
 * OPE-1683 — the operator-draft-closes-obligation probe: floored at enabled_at,
 * red from the OLDEST sent operator draft that left its recipient's earlier
 * contact obligation open, healthy once that obligation is closed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE email_send_ledger (
    message_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL, recipient TEXT, source TEXT, status TEXT
  );
  CREATE TABLE support_obligations (
    id TEXT PRIMARY KEY, from_address TEXT, kind TEXT, status TEXT, opened_at INTEGER
  );
  CREATE TABLE heartbeat_probes (
    probe_name TEXT PRIMARY KEY, enabled_at INTEGER, updated_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "operator-draft-closes-obligation")!;
const isNow = (d: Date | null) => d !== null && Math.abs(d.getTime() - Date.now()) < 60_000;

const send = (
  id: string,
  at: string,
  over: { source?: string; status?: string; to?: string } = {}
) =>
  raw
    .prepare(
      `INSERT INTO email_send_ledger (message_id, sent_at, recipient, source, status) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      id,
      T(at),
      over.to ?? "Sam@x.example",
      over.source ?? "operator:outbound",
      over.status ?? "sent"
    );
const obligation = (id: string, opened: string, over: { kind?: string; status?: string } = {}) =>
  raw
    .prepare(
      `INSERT INTO support_obligations (id, from_address, kind, status, opened_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, "sam@x.example", over.kind ?? "contact", over.status ?? "open", T(opened));

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  raw
    .prepare(`INSERT INTO heartbeat_probes (probe_name, enabled_at) VALUES (?, ?)`)
    .run("operator-draft-closes-obligation", T("2026-11-18T00:00:00Z"));
  db = drizzle(raw, { schema });
});

describe("OPE-1683 operator-draft-closes-obligation probe", () => {
  it("is registered, owned, 2h", () => {
    expect(probe.ownerOpe).toBe("OPE-1683");
    expect(probe.expectedWindowHours).toBe(2);
  });

  it("a draft that left an earlier contact obligation open starts the clock at the send", async () => {
    obligation("o1", "2026-11-18T10:00:00Z");
    send("d1", "2026-11-18T12:00:00Z");
    send("d2", "2026-11-18T13:00:00Z");
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-11-18T12:00:00.000Z");
  });

  it("closing the obligation clears it", async () => {
    obligation("o1", "2026-11-18T10:00:00Z");
    send("d1", "2026-11-18T12:00:00Z");
    raw.exec(`UPDATE support_obligations SET status='answered'`);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("before arming, a failed send, another source, a support obligation, or one opened after the send read healthy — with a landmark", async () => {
    obligation("o1", "2026-11-18T10:00:00Z");
    send("old", "2026-11-17T12:00:00Z");
    send("failed", "2026-11-18T12:00:00Z", { status: "failed" });
    send("manual", "2026-11-18T12:00:00Z", { source: "reply:manual" });
    raw.exec(`UPDATE support_obligations SET kind='support'`);
    send("d-ok", "2026-11-18T12:30:00Z");
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
    obligation("o-late", "2026-11-18T15:00:00Z");
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
    // Landmark: one in-scope pair turns it red.
    obligation("o2", "2026-11-18T11:00:00Z");
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-11-18T12:30:00.000Z");
  });

  it("the seed migration arms exactly this probe", () => {
    const sql = readFileSync(
      join(process.cwd(), "drizzle/0431_ope1683_operator_draft_close_probe.sql"),
      "utf8"
    );
    expect(sql).toContain("'operator-draft-closes-obligation'");
    expect(sql).toContain("ON CONFLICT(probe_name) DO NOTHING");
  });
});
