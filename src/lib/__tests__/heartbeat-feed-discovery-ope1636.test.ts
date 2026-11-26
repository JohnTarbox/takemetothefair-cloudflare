/**
 * OPE-1636 — the two feed discovery probes, driven both ways on the real 0441
 * DDL: healthy when the cron is probing / nothing is owed, red when the path it
 * watches has gone silent. Times are relative to the real clock (the probes
 * read `new Date()`), so the current month is computed, not hard-coded.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../mcp-server/__tests__/setup-db";
import { HEARTBEAT_PROBES } from "../heartbeat";

let db: unknown;
let raw: Database.Database;
const HOUR = 3_600_000;
const probe = (name: string) => HEARTBEAT_PROBES.find((x) => x.name === name)!;
const evidence = (name: string) => probe(name).lastEvidenceAt(db as never);
const silent = async (name: string) => {
  const t = await evidence(name);
  return t != null && Date.now() - t.getTime() > probe(name).expectedWindowHours * HOUR;
};
const month = () => new Date().toISOString().slice(0, 7);
const secs = (msAgo: number) => Math.floor((Date.now() - msAgo) / 1000);

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw.prepare("INSERT INTO promoters (id, company_name, slug) VALUES ('p','P','p')").run();
});

const openRun = (
  m: string,
  startedAgoMs: number,
  completedAgoMs: number | null = null,
  opeId: string | null = null
) =>
  raw
    .prepare(
      "INSERT INTO feed_discovery_runs (month, started_at, completed_at, ope_id, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      m,
      secs(startedAgoMs),
      completedAgoMs == null ? null : secs(completedAgoMs),
      opeId,
      secs(0)
    );
const probeRow = (m: string, agoMs: number) =>
  raw
    .prepare(
      "INSERT INTO feed_discovery_probes (id, promoter_id, month, probed_at, outcome) VALUES (?, 'p', ?, ?, 'none')"
    )
    .run(`d-${m}-${agoMs}`, m, secs(agoMs));

describe("feed-discovery-probing (OPE-1636)", () => {
  it("no run ever: null, so the anchor is enabled_at and a fresh ship cannot read red", async () => {
    expect(await evidence("feed-discovery-probing")).toBeNull();
  });
  it("an open run with a recent probe is healthy; with only old probes it is red", async () => {
    openRun(month(), 20 * HOUR);
    probeRow(month(), 1 * HOUR);
    expect(await silent("feed-discovery-probing")).toBe(false);
    raw.prepare("DELETE FROM feed_discovery_probes").run();
    probeRow(month(), 10 * HOUR);
    expect(await silent("feed-discovery-probing")).toBe(true);
  });
  it("a completed run is healthy", async () => {
    openRun(month(), 50 * HOUR, 40 * HOUR, "OPE-1");
    expect(await silent("feed-discovery-probing")).toBe(false);
  });
  it("runs exist but none this month: the clock starts at the 1st 00:00Z", async () => {
    openRun("2000-01", 0, 0, "none");
    const now = new Date();
    expect((await evidence("feed-discovery-probing"))!.toISOString()).toBe(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    );
  });
});

describe("feed-discovery-filed (OPE-1636)", () => {
  it("nothing owed is healthy; a run completed 4 days ago and unfiled is red; filing clears it", async () => {
    openRun("2000-02", 120 * HOUR);
    expect(await silent("feed-discovery-filed")).toBe(false); // open, not owed
    raw.prepare("UPDATE feed_discovery_runs SET completed_at = ?").run(secs(96 * HOUR));
    expect(await silent("feed-discovery-filed")).toBe(true);
    raw.prepare("UPDATE feed_discovery_runs SET ope_id = 'OPE-9'").run();
    expect(await silent("feed-discovery-filed")).toBe(false);
  });
});
