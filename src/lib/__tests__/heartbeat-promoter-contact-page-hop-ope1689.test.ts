/**
 * OPE-1689 — the promoter-contact-page-hop probe reads ONLY the hop's output: a
 * contact_email / contact_phone candidate whose source_url is not the
 * promoter's own website. A homepage-sourced candidate (the ordinary cron's
 * output) must not keep it green.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE promoters (id TEXT PRIMARY KEY, website TEXT);
  CREATE TABLE promoter_enrichment_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, promoter_id TEXT NOT NULL, proposed_field TEXT NOT NULL,
    source_url TEXT, created_at INTEGER NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "promoter-contact-page-hop")!;
const cand = (field: string, src: string | null, at: string) =>
  raw
    .prepare(
      `INSERT INTO promoter_enrichment_candidates (promoter_id, proposed_field, source_url, created_at) VALUES ('p1', ?, ?, ?)`
    )
    .run(field, src, T(at));

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  raw
    .prepare(`INSERT INTO promoters (id, website) VALUES ('p1', ' https://farm-fixture.org/ ')`)
    .run();
  db = drizzle(raw, { schema });
});

describe("OPE-1689 promoter-contact-page-hop probe", () => {
  it("is registered, owned, two weeks", () => {
    expect(probe.ownerOpe).toBe("OPE-1689");
    expect(probe.expectedWindowHours).toBe(336);
  });

  it("homepage-sourced contact candidates (the ordinary pass) are NOT evidence", async () => {
    cand("contact_email", "https://farm-fixture.org/", "2026-11-19T00:00:00Z");
    cand("contact_phone", null, "2026-11-19T01:00:00Z");
    expect(await probe.lastEvidenceAt(db)).toBeNull();
  });

  it("a contact-page-sourced email/phone is, and the newest one wins", async () => {
    cand("contact_email", "https://farm-fixture.org/", "2026-11-21T00:00:00Z"); // homepage, newer
    cand("contact_email", "https://farm-fixture.org/contact-us/", "2026-11-19T00:00:00Z");
    cand("contact_phone", "https://farm-fixture.org/contact-us/", "2026-11-20T00:00:00Z");
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });

  it("another field from another page is not evidence", async () => {
    cand("hero", "https://farm-fixture.org/gallery/", "2026-11-19T00:00:00Z");
    expect(await probe.lastEvidenceAt(db)).toBeNull();
  });
});
