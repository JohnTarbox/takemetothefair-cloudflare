/**
 * OPE-189 — toMarkdownWithRetry / isTransientAiError.
 *
 * The image→markdown vision model times out on the cold-start call and reads the
 * poster fine on a warm retry. These tests pin that a transient first-attempt
 * failure (the `{format:"error", error:"AI binding timed out…"}` variant OR a
 * throw) is retried and recovered, while a non-transient error fails fast, and
 * every attempt is surfaced via onAttempt (the observability contract).
 */
import { describe, it, expect, vi } from "vitest";
import {
  isTransientAiError,
  toMarkdownWithRetry,
  type ToMarkdownAi,
} from "../src/email-handlers/ocr-retry.js";

const doc = { name: "poster.png", blob: new Blob(["x"]) };
const ai = (fn: ReturnType<typeof vi.fn>): ToMarkdownAi => ({ toMarkdown: fn as never });
const md = (data: string) => [{ format: "markdown", data }];
const errRes = (error: string) => [{ format: "error", error }];
const TIMEOUT = "AI binding timed out after 60000ms (model: @cf/google/gemma-4-26b-a4b-it)";

describe("isTransientAiError (OPE-189)", () => {
  it("flags cold-start timeout / capacity / rate-limit / model-load errors", () => {
    expect(isTransientAiError(TIMEOUT)).toBe(true);
    expect(isTransientAiError("Service at capacity")).toBe(true);
    expect(isTransientAiError("429 Too Many Requests")).toBe(true);
    expect(isTransientAiError("error 5028: no healthy upstream")).toBe(true);
    expect(isTransientAiError("model overloaded")).toBe(true);
  });

  it("does NOT flag a genuinely unreadable file", () => {
    expect(isTransientAiError("unsupported file format")).toBe(false);
    expect(isTransientAiError("could not decode image")).toBe(false);
  });
});

describe("toMarkdownWithRetry (OPE-189)", () => {
  it("recovers on a warm retry after a cold-start timeout (the repro)", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(errRes(TIMEOUT)) // attempt 1: cold-start timeout
      .mockResolvedValueOnce(md("MAY 22-23, 2027 · WESTOVER AIR RESERVE BASE")); // attempt 2: ok
    const seen: string[] = [];
    const out = await toMarkdownWithRetry(ai(fn), doc, 3, (a, o) => seen.push(`${a}:${o}`));
    expect(out.text).toContain("WESTOVER");
    expect(out.attempts).toBe(2);
    expect(out.outcome).toMatch(/^ok:\d+chars$/);
    expect(fn).toHaveBeenCalledTimes(2);
    // Attempt 1's timeout is still recorded even though attempt 2 won.
    expect(seen[0]).toContain("toMarkdown-error");
    expect(seen[1]).toContain("ok:");
  });

  it("succeeds on the first attempt without retrying", async () => {
    const fn = vi.fn().mockResolvedValue(md("Summer Fair · June 1"));
    const out = await toMarkdownWithRetry(ai(fn), doc, 3);
    expect(out.attempts).toBe(1);
    expect(out.text).toContain("Summer Fair");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts the retry budget when the timeout persists", async () => {
    const fn = vi.fn().mockResolvedValue(errRes(TIMEOUT));
    const out = await toMarkdownWithRetry(ai(fn), doc, 3);
    expect(out.text).toBeNull();
    expect(out.attempts).toBe(3);
    expect(out.outcome).toContain("toMarkdown-error");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("fails fast on a non-transient error (no wasted retries)", async () => {
    const fn = vi.fn().mockResolvedValue(errRes("unsupported file format"));
    const out = await toMarkdownWithRetry(ai(fn), doc, 3);
    expect(out.text).toBeNull();
    expect(out.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown transient error, then recovers", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error(TIMEOUT))
      .mockResolvedValueOnce(md("Fall Festival · Sept 9"));
    const out = await toMarkdownWithRetry(ai(fn), doc, 3);
    expect(out.text).toContain("Fall Festival");
    expect(out.attempts).toBe(2);
  });

  it("fails fast on a thrown non-transient error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("decode failure"));
    const out = await toMarkdownWithRetry(ai(fn), doc, 3);
    expect(out.text).toBeNull();
    expect(out.attempts).toBe(1);
    expect(out.outcome).toContain("threw");
  });

  it("treats an unexpected shape as terminal (not retryable)", async () => {
    const fn = vi.fn().mockResolvedValue([{ format: "weird" }]);
    const out = await toMarkdownWithRetry(ai(fn), doc, 3);
    expect(out.text).toBeNull();
    expect(out.attempts).toBe(1);
    expect(out.outcome).toContain("unexpected-shape");
  });

  it("returns empty text (not null) when markdown data is non-string", async () => {
    const fn = vi.fn().mockResolvedValue([{ format: "markdown", data: null }]);
    const out = await toMarkdownWithRetry(ai(fn), doc, 3);
    expect(out.text).toBe("");
    expect(out.outcome).toBe("ok:0chars");
  });
});
