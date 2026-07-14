/**
 * OPE-198 — the AI extractor pulls the vendor-application fields (booth fee,
 * deadline, apply URL/instructions, attendance, indoor/outdoor) so URL-import /
 * inbound-email intake can persist them. These assert the two NEW fields
 * (applicationDeadline, applicationInstructions) are mapped + sanitized, and the
 * pre-existing vendor fields still survive the extract.
 */
import { describe, it, expect } from "vitest";
import { extractMultipleEvents } from "../ai-extractor";
import type { PageMetadata } from "../types";

const md = {} as PageMetadata;
const mkAi = (resp: unknown) => ({ run: async () => resp }) as never;

describe("AI extractor — vendor-application capture (OPE-198)", () => {
  it("maps applicationDeadline (parsed to YYYY-MM-DD) + applicationInstructions + fee/attendance", async () => {
    const ai = mkAi({
      response: JSON.stringify([
        {
          name: "Harvest Craft Fair",
          startDate: "2027-10-03",
          venueName: "Town Common",
          vendorFeeMin: 40,
          vendorFeeMax: 75,
          vendorFeeNotes: "$40 10x10, $75 10x20",
          applicationUrl: "https://harvestfair.example.com/apply",
          applicationDeadline: "September 1, 2027",
          applicationInstructions: "Email crafts@harvestfair.example.com with 3 product photos.",
          estimatedAttendance: 2500,
          indoorOutdoor: "OUTDOOR",
        },
      ]),
    });
    const { events } = await extractMultipleEvents(ai, "Harvest Craft Fair Oct 3 2027", md);
    expect(events.length).toBe(1);
    const e = events[0];
    // New fields
    expect(e.applicationDeadline).toBe("2027-09-01"); // "September 1, 2027" → normalized
    expect(e.applicationInstructions).toContain("Email crafts@harvestfair.example.com");
    // Pre-existing vendor fields still captured
    expect(e.vendorFeeMin).toBe(40);
    expect(e.vendorFeeMax).toBe(75);
    expect(e.vendorFeeNotes).toContain("10x10");
    expect(e.applicationUrl).toBe("https://harvestfair.example.com/apply");
    expect(e.estimatedAttendance).toBe(2500);
    expect(e.indoorOutdoor).toBe("OUTDOOR");
  });

  it("leaves the new fields null when the page doesn't state them", async () => {
    const ai = mkAi({
      response: JSON.stringify([{ name: "Quiet Market", startDate: "2027-05-01", venueName: "X" }]),
    });
    const { events } = await extractMultipleEvents(ai, "content", md);
    expect(events[0].applicationDeadline ?? null).toBeNull();
    expect(events[0].applicationInstructions ?? null).toBeNull();
  });

  it("caps applicationInstructions at 500 chars", async () => {
    const long = "a".repeat(900);
    const ai = mkAi({
      response: JSON.stringify([
        { name: "E", startDate: "2027-01-01", venueName: "V", applicationInstructions: long },
      ]),
    });
    const { events } = await extractMultipleEvents(ai, "content", md);
    expect((events[0].applicationInstructions ?? "").length).toBeLessThanOrEqual(500);
  });
});
