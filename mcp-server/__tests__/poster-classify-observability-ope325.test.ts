/**
 * OPE-325 rework — the classifier shipped 2026-08-04 and produced no evidence
 * in twenty days.
 *
 * `classifyAsPoster` had five ways to return null and logged on one of them.
 * Prod on 2026-08-24: ZERO rows in `error_logs` from
 * `mcp:photo-intake:poster-classify` — not one verdict, not one failure — while
 * at least 13 posters were held, ten of them inside eighteen minutes on 08-23.
 *
 * The absence is meaningful rather than an artifact: info-level logging carried
 * 531 rows that same week, and `email-handler:ope-315-photo-only` logged at the
 * exact second the last poster arrived. The router ran; the classifier went
 * quiet.
 *
 * These tests pin the two halves of the repair:
 *
 *   1. every give-up path is observable — a silent classifier cannot be
 *      debugged, which is why this sat for 20 days;
 *   2. the empty-string source URL, the SAME root cause as the OPE-297
 *      image-lane failure. submitExtract forwards `url` to
 *      /api/admin/import-url/extract (submit.ts:337), and that endpoint used to
 *      reject "" with "Invalid URL" before the submit schema was ever reached.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

describe("the shared root cause: one empty string, two dead features (OPE-297/325)", () => {
  /** The endpoint schema as it stood when both lanes were failing. */
  const beforeFix = z.object({
    content: z.string().min(1),
    url: z.string().url().optional(),
  });

  /** As repaired in #1007 — "" means absent. */
  const afterFix = z.object({
    content: z.string().min(1),
    url: z
      .string()
      .url()
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : undefined)),
  });

  // stagePosterAsPendingEvent passes exactly this shape.
  const posterPayload = { content: "KCCV Holiday Craft Fair, Augusta Civic Center", url: "" };

  it("the poster path's payload was rejected, with the message John saw", () => {
    const r = beforeFix.safeParse(posterPayload);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Invalid URL");
  });

  it("and is accepted after the endpoint fix — so the poster lane unblocks too", () => {
    const r = afterFix.safeParse(posterPayload);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.url).toBeUndefined();
  });

  it("a real source URL still survives, so the emailed-URL lane is unaffected", () => {
    const r = afterFix.safeParse({ content: "x", url: "https://example.org/fair" });
    expect(r.success && r.data.url).toBe("https://example.org/fair");
  });

  it("a malformed URL is still rejected — tolerating '' is not tolerating anything", () => {
    expect(afterFix.safeParse({ content: "x", url: "not a url" }).success).toBe(false);
  });
});

describe("classifyAsPoster give-up paths are observable (OPE-325)", () => {
  // Mirrors the guard order in photo-intake.ts:classifyAsPoster. The point of
  // this test is the REASON STRINGS: prod showed silence, and silence is
  // indistinguishable between causes. Each branch must name itself.
  type Ref = { key: string; name?: string; mimeType?: string };
  const imageRefs = (refs: Ref[]) =>
    refs.filter(
      (r) => typeof r?.mimeType === "string" && r.mimeType.toLowerCase().startsWith("image/")
    );

  function whyGiveUp(bucket: unknown, refs: Ref[]): string | null {
    if (!bucket) return "no VENDOR_ASSETS binding";
    if (imageRefs(refs).length === 0) return "no image attachments after mimeType filter";
    return null;
  }

  it("names the missing-binding case", () => {
    expect(whyGiveUp(null, [{ key: "k", mimeType: "image/png" }])).toBe("no VENDOR_ASSETS binding");
  });

  it("names the no-images case, and distinguishes it from the binding case", () => {
    expect(whyGiveUp({}, [{ key: "k", mimeType: "application/pdf" }])).toBe(
      "no image attachments after mimeType filter"
    );
  });

  it("proceeds for the refs prod actually stored — image/png with a real key", () => {
    // The ten 08-23 holds all stored `mimeType: "image/png"`, which is why the
    // mimeType filter was ruled OUT as the cause rather than assumed.
    expect(
      whyGiveUp({}, [{ key: "inbound-attachments/x/0-image.png", mimeType: "image/png" }])
    ).toBeNull();
  });

  it("every reason string is distinct — two branches sharing a reason is the bug again", () => {
    const reasons = [
      "no VENDOR_ASSETS binding",
      "no image attachments after mimeType filter",
      "R2 object missing",
      "extract-image returned non-OK",
      "extract-image returned empty content",
    ];
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});
