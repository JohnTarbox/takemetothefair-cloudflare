import { describe, it, expect } from "vitest";
import { parseThresholdToken, extractDate, parseGscMilestoneEmail } from "../gsc-milestone-email";

describe("parseThresholdToken (OPE-108)", () => {
  it("parses K-shorthand incl. decimals", () => {
    expect(parseThresholdToken("3K")).toBe(3000);
    expect(parseThresholdToken("1.5K")).toBe(1500);
    expect(parseThresholdToken("1.2K")).toBe(1200);
    expect(parseThresholdToken("2.5K")).toBe(2500);
    expect(parseThresholdToken("12K")).toBe(12000);
    expect(parseThresholdToken("500")).toBe(500);
    expect(parseThresholdToken("12,000")).toBe(12000);
    expect(parseThresholdToken(" 3k ")).toBe(3000);
  });
  it("returns null for non-numbers", () => {
    expect(parseThresholdToken("lots")).toBeNull();
    expect(parseThresholdToken("")).toBeNull();
  });
});

describe("extractDate (OPE-108)", () => {
  it("handles the three shapes without timezone drift", () => {
    expect(extractDate("Your site reached 3K clicks ... Jul 4, 2026")).toBe("2026-07-04");
    expect(extractDate("July 4 2026")).toBe("2026-07-04");
    expect(extractDate("Mon, 06 Jul 2026 09:00:00 -0400")).toBe("2026-07-06");
    expect(extractDate("2026-07-04")).toBe("2026-07-04");
  });
  it("returns null when no date present", () => {
    expect(extractDate("no date here")).toBeNull();
    expect(extractDate(null)).toBeNull();
  });
});

describe("parseGscMilestoneEmail (OPE-108)", () => {
  it("parses a standard 3K email (subject threshold + body reached date)", () => {
    const row = parseGscMilestoneEmail({
      subject: "Congrats on reaching 3K clicks in 28 days!",
      body: "Your site reached 3K clicks from Google Search in the past 28 days\nJul 4, 2026\nhttps://meetmeatthefair.com/",
      emailDate: "2026-07-06T12:00:00Z",
    });
    expect(row).toEqual({
      metric: "clicks",
      windowDays: 28,
      threshold: 3000,
      reachedDate: "2026-07-04",
      // OPE-456 — the date sits on the line AFTER the "reached" sentence, which
      // the forward-looking scan still anchors to. Google's own format.
      reachedDateSource: "anchored",
      emailDate: "2026-07-06",
    });
  });

  it("accepts a Date object for emailDate and a null body (no reached date)", () => {
    const row = parseGscMilestoneEmail({
      subject: "Congrats on reaching 1.5K clicks in 28 days!",
      body: null,
      emailDate: new Date("2026-06-26T00:00:00Z"),
    });
    expect(row).toMatchObject({ threshold: 1500, emailDate: "2026-06-26", reachedDate: null });
  });

  it("returns null for a non-milestone email", () => {
    expect(
      parseGscMilestoneEmail({ subject: "Your weekly search performance", emailDate: "2026-07-06" })
    ).toBeNull();
    expect(parseGscMilestoneEmail({ subject: "", emailDate: "2026-07-06" })).toBeNull();
  });

  it("returns null when the email date can't be parsed", () => {
    expect(
      parseGscMilestoneEmail({
        subject: "Congrats on reaching 3K clicks in 28 days!",
        emailDate: "not a date",
      })
    ).toBeNull();
  });

  it("backfill parity: reproduces the analyst's hand-entered 1.2K / 1.5K / 3K rows", () => {
    const cases = [
      { n: "1.2K", email: "2026-06-20", expected: 1200 },
      { n: "1.5K", email: "2026-06-26", expected: 1500 },
      { n: "3K", email: "2026-07-06", expected: 3000 },
    ];
    for (const c of cases) {
      const row = parseGscMilestoneEmail({
        subject: `Congrats on reaching ${c.n} clicks in 28 days!`,
        emailDate: c.email,
      });
      expect(row).toMatchObject({
        metric: "clicks",
        windowDays: 28,
        threshold: c.expected,
        emailDate: c.email,
      });
    }
  });
});

/**
 * OPE-456 — the forwarded-email shape that stored row 18 two days late.
 *
 * The ticket supposed the ingest "falls back to email_date". It does not, and
 * never did. `extractDate` returns the FIRST date anywhere in the text, and on
 * a forward that is the forward header's own Date:, not Google's claim. Same
 * wrong value, different mechanism — and the difference is what the fix hangs
 * on, so it is pinned here.
 */
describe("OPE-456 — a forwarded milestone must not take the forward date", () => {
  const FORWARDED = [
    "---------- Forwarded message ---------",
    "From: Google Search Console <sc-noreply@google.com>",
    "Date: Mon, Aug 17, 2026 at 6:03 AM",
    "Subject: Congrats on reaching 12K clicks in 28 days!",
    "To: John Tarbox <jtarboxme@gmail.com>",
    "",
    "On Aug 15, 2026 your site reached 12K clicks from Google Search in the past 28 days",
    "https://meetmeatthefair.com/",
  ].join("\n");

  it("anchors to Google's sentence, not the forward header", () => {
    const row = parseGscMilestoneEmail({
      subject: "Fwd: Congrats on reaching 12K clicks in 28 days!",
      body: FORWARDED,
      emailDate: "2026-08-17T13:43:00Z",
    });
    expect(row).not.toBeNull();
    // The exact defect: this was stored as 2026-08-17.
    expect(row!.reachedDate).toBe("2026-08-15");
    expect(row!.reachedDateSource).toBe("anchored");
    expect(row!.emailDate).toBe("2026-08-17");
  });

  it("reports `unanchored` when no reach sentence carries a date", () => {
    // Then the value is the first date in the blob, which on a forward is the
    // forward date — so it is reported as weak and the correction path lets a
    // later anchored parse replace it.
    const row = parseGscMilestoneEmail({
      subject: "Congrats on reaching 5K clicks in 28 days!",
      body: "Date: Mon, Aug 17, 2026 at 6:03 AM\n\nSee your report.",
      emailDate: "2026-08-17T13:43:00Z",
    });
    expect(row!.reachedDate).toBe("2026-08-17");
    expect(row!.reachedDateSource).toBe("unanchored");
  });
});
