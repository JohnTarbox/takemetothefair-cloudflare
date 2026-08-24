/**
 * OPE-297 rework — John's acceptance run failed with two symptoms that turned
 * out to be one cause.
 *
 *   1. "Event Name field is blank and no Event Details fields populated at all."
 *   2. A red "Invalid URL" banner on the Review step, on a path with no URL.
 *
 * The wizard sent `url: state.url` unconditionally (use-import-wizard.ts:707).
 * On the image/paste lane nobody types a URL, so that is the initial `""`
 * (:146). The endpoint declares `url: z.string().url().optional()`, and
 * `.optional()` admits `undefined` — NOT `""`. Zod rejects with exactly
 * "Invalid URL", the route returns 400, and the wizard dispatches EXTRACT_FAIL
 * with no events.
 *
 * So symptom 1 is a CONSEQUENCE of symptom 2: extraction never ran, and the OCR
 * text — which was correct — was never looked at. Worth stating because the
 * other hypothesis on the ticket (verbose OCR prose defeating the field
 * extractor) is a real concern but is NOT what broke this run, and fixing that
 * instead would have left the lane just as dead.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildExtractPayload } from "../utils";

/**
 * Mirrors the url/content shape of extractRequestSchema
 * (src/app/api/admin/import-url/extract/route.ts:13-24). Only the fields this
 * defect turns on are modelled; metadata is passed through untouched.
 */
const routeSchema = z.object({
  content: z.string().min(1, "Content is required"),
  url: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

describe("the failure, reproduced at the boundary", () => {
  it("an empty-string url is REJECTED by the route schema with exactly 'Invalid URL'", () => {
    const r = routeSchema.safeParse({ content: "ocr text", url: "", metadata: {} });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Invalid URL");
  });

  it("an omitted url is accepted — so the fix is to omit, not to loosen", () => {
    expect(routeSchema.safeParse({ content: "ocr text", metadata: {} }).success).toBe(true);
  });
});

describe("the endpoint now tolerates '' too — defence in depth", () => {
  /**
   * Mirrors the relaxed route schema. Two fixes, deliberately:
   *
   *   client — stops sending a meaningless "" (the correct SEMANTIC: the URL
   *            genuinely is absent on this lane)
   *   server — treats "" as absent (RESILIENCE: this is the shared entry point
   *            for every extract path, and the next caller should not have to
   *            rediscover this)
   *
   * Either alone fixes John's repro. Both together mean it cannot come back
   * through a different door.
   */
  const relaxed = z.object({
    content: z.string().min(1, "Content is required"),
    url: z
      .string()
      .url()
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : undefined)),
  });

  it("accepts the exact payload that used to 400", () => {
    const r = relaxed.safeParse({ content: "ocr text", url: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.url).toBeUndefined();
  });

  it("still rejects a non-empty string that is not a URL", () => {
    // Relaxing "" must not become "accept anything" — a typo'd URL is still a
    // caller error worth surfacing.
    expect(relaxed.safeParse({ content: "x", url: "not a url" }).success).toBe(false);
  });

  it("still passes a real URL through unchanged", () => {
    const r = relaxed.safeParse({ content: "x", url: "https://example.org/fair" });
    expect(r.success && r.data.url).toBe("https://example.org/fair");
  });
});

describe("buildExtractPayload (OPE-297)", () => {
  it("omits url entirely on the image/paste lane, where state.url is ''", () => {
    const payload = buildExtractPayload("ocr text", "");
    expect("url" in payload).toBe(false);
    expect(routeSchema.safeParse(payload).success).toBe(true);
  });

  it.each([null, undefined, "   ", "\n\t "])("treats %p as absent", (v) => {
    const payload = buildExtractPayload("ocr text", v as string | null | undefined);
    expect("url" in payload).toBe(false);
    expect(routeSchema.safeParse(payload).success).toBe(true);
  });

  it("keeps a real URL on the URL lane — the regression that must not happen", () => {
    const payload = buildExtractPayload("page text", "https://example.org/fair");
    expect(payload.url).toBe("https://example.org/fair");
    expect(routeSchema.safeParse(payload).success).toBe(true);
  });

  it("trims a padded URL rather than dropping it", () => {
    expect(buildExtractPayload("x", "  https://example.org/fair  ").url).toBe(
      "https://example.org/fair"
    );
  });

  it("always sends content and a metadata object", () => {
    const payload = buildExtractPayload("ocr text", "");
    expect(payload.content).toBe("ocr text");
    expect(payload.metadata).toEqual({});
    expect(buildExtractPayload("x", "", { title: "T" }).metadata).toEqual({ title: "T" });
  });
});
