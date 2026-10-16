/**
 * OPE-1397 (EXP2) — the admin dashboard passes only the fields
 * EventVendorsPanel renders, never a full events row.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toEventVendorsPanelRow } from "@/lib/admin/event-vendors-panel-row";

describe("toEventVendorsPanelRow", () => {
  it("drops every field the panel does not render (suggester email, user ids, ...)", () => {
    const start = new Date("2026-11-01T00:00:00Z");
    const fullRow = {
      id: "e1",
      name: "Fair",
      slug: "fair",
      startDate: start,
      endDate: null,
      suggesterEmail: "someone@example.com",
      submittedByUserId: "u-1",
      promoterId: "p-1",
      description: "long text",
    };
    const fullVenue = { id: "v1", city: "Fryeburg", state: "ME", address: "1 Main St" };
    const row = toEventVendorsPanelRow(fullRow, fullVenue, 3);
    expect(row).toEqual({
      id: "e1",
      name: "Fair",
      slug: "fair",
      startDate: start,
      endDate: null,
      venue: { city: "Fryeburg", state: "ME" },
      vendorCount: 3,
    });
    expect(JSON.stringify(row)).not.toContain("example.com");
    expect(JSON.stringify(row)).not.toContain("u-1");
  });

  it("keeps a null venue null", () => {
    const row = toEventVendorsPanelRow(
      { id: "e", name: "n", slug: "s", startDate: null, endDate: null },
      null,
      0
    );
    expect(row.venue).toBeNull();
  });

  it("src/app/admin/page.tsx builds the panel rows through the projector, not a row spread", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "app", "admin", "page.tsx"), "utf8");
    const fn = src.slice(
      src.indexOf("async function getUpcomingEventsWithVendorCounts"),
      src.indexOf("export default async function AdminDashboard")
    );
    expect(fn).toMatch(/toEventVendorsPanelRow\(/);
    expect(fn).not.toMatch(/\.\.\.e\.events/);
  });
});
