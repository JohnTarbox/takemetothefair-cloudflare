/**
 * OPE-1114 — the app's approve route warns from the SAME predicate as the MCP
 * `update_event_status` tool (behaviour tested end-to-end on the MCP side).
 * Two approve paths is the shape that lets a guard reach one and miss the
 * other, so the app side is pinned here. Anchored on CALL syntax — a bare
 * symbol also matches the import line and would pass with the call deleted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("OPE-1114 wiring — app approve route", () => {
  it("reads the description and warns via the shared predicate", () => {
    const src = readFileSync(
      join(__dirname, "../../app/api/admin/events/[id]/approve/route.ts"),
      "utf8"
    );
    expect(src).toMatch(/description: events\.description,/);
    expect(src).toMatch(/reviewerMarkerInCopy\(existing\.description\)/);
    expect(src).toMatch(/reviewer_note_in_description: reviewerMarkerWarning\(marker\)/);
  });
});
