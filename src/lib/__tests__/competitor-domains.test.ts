import { describe, it, expect, vi, beforeEach } from "vitest";

const selectResults: Array<{ domain: string }> = [];

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn(async () => selectResults.slice()),
};

import { loadCompetitorDomains } from "../competitor-domains";
type TestDb = Parameters<typeof loadCompetitorDomains>[0];

beforeEach(() => {
  selectResults.length = 0;
  vi.clearAllMocks();
});

describe("loadCompetitorDomains", () => {
  it("returns [] when table is empty", async () => {
    const r = await loadCompetitorDomains(mockDb as unknown as TestDb);
    expect(r).toEqual([]);
  });

  it("returns the domains lowercased", async () => {
    selectResults.push({ domain: "FairsAndFestivals.NET" }, { domain: "FESTIVALNET.com" });
    const r = await loadCompetitorDomains(mockDb as unknown as TestDb);
    expect(r).toEqual(["fairsandfestivals.net", "festivalnet.com"]);
  });

  it("preserves order returned by the query", async () => {
    selectResults.push({ domain: "z.com" }, { domain: "a.com" }, { domain: "m.com" });
    const r = await loadCompetitorDomains(mockDb as unknown as TestDb);
    expect(r).toEqual(["z.com", "a.com", "m.com"]);
  });
});
