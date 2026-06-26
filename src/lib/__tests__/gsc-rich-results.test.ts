import { describe, it, expect } from "vitest";
import { summarizeRichResults } from "../gsc-rich-results";

describe("summarizeRichResults", () => {
  it("returns null when richResults is absent (page not rich-result-eligible)", () => {
    expect(summarizeRichResults(undefined)).toBeNull();
  });

  it("returns null on a PASS verdict with no issues", () => {
    expect(summarizeRichResults({ verdict: "PASS", detectedItems: [] })).toBeNull();
  });

  it("flags the K46 shape — FAIL with a 'Missing field location' ERROR", () => {
    const out = summarizeRichResults({
      verdict: "FAIL",
      detectedItems: [
        {
          richResultType: "Events",
          items: [
            {
              name: "Burlington Summer Farmers Market",
              issues: [{ issueMessage: 'Missing field "location"', severity: "ERROR" }],
            },
          ],
        },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.severity).toBe("ERROR");
    expect(out!.message).toBe('FAIL: Missing field "location" [Events]');
  });

  it("flags ERROR issues even when the top-level verdict is PARTIAL", () => {
    const out = summarizeRichResults({
      verdict: "PARTIAL",
      detectedItems: [
        {
          richResultType: "Events",
          items: [{ issues: [{ issueMessage: "Missing field 'startDate'", severity: "ERROR" }] }],
        },
      ],
    });
    expect(out?.severity).toBe("ERROR");
    expect(out?.message).toContain("startDate");
  });

  it("does NOT escalate a warning-only / NEUTRAL result (avoids dashboard noise)", () => {
    expect(
      summarizeRichResults({
        verdict: "NEUTRAL",
        detectedItems: [
          {
            richResultType: "Events",
            items: [{ issues: [{ issueMessage: "Optional field missing", severity: "WARNING" }] }],
          },
        ],
      })
    ).toBeNull();
  });

  it("handles a bare FAIL with no enumerated issues", () => {
    const out = summarizeRichResults({ verdict: "FAIL" });
    expect(out?.severity).toBe("ERROR");
    expect(out?.message).toBe("FAIL: rich result invalid");
  });

  it("truncates to 3 issues and reports the overflow count", () => {
    const out = summarizeRichResults({
      verdict: "FAIL",
      detectedItems: [
        {
          richResultType: "Events",
          items: [
            {
              issues: [
                { issueMessage: "a", severity: "ERROR" },
                { issueMessage: "b", severity: "ERROR" },
                { issueMessage: "c", severity: "ERROR" },
                { issueMessage: "d", severity: "ERROR" },
                { issueMessage: "e", severity: "ERROR" },
              ],
            },
          ],
        },
      ],
    });
    expect(out?.message).toContain("(+2 more)");
  });
});
