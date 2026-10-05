/**
 * OPE-1316 — the extract-failure classifier must read the pipeline's token
 * wherever the Workflow step boundary left it.
 *
 * In prod, `classifyExtractFailure` has never returned anything but `other`:
 * NEAR-Fest (`1e10e617`) failed on a logged Workers AI timeout and was recorded
 * `other`. The messages `submitExtract` throws START with `extract-upstream: …`,
 * but by the time the workflow's catch sees them, they no longer do. The old
 * tests fed the raw message straight in, so they could not see that.
 *
 * Each case is pinned in BOTH shapes: the raw message, and the same message
 * behind a class-name prefix of the kind an RPC boundary adds.
 */
import { describe, it, expect } from "vitest";
import {
  classifyExtractFailure,
  isZeroEventsFailure,
  pipelineErrorMessage,
} from "../src/workflows/pipeline-error.js";

// The exact message `submitExtract` builds for the NEAR-Fest response
// (route body: success:false, error: …, aiFailure: …).
const NEAR_FEST =
  "extract-upstream: Could not extract event data from this page — the extractor timed out and no usable title or date could be recovered. Retrying is unlikely to help; please add the event manually. [ai: Workers AI multi-event extraction timed out after 20000ms]";

const WRAPS: Array<[string, (m: string) => string]> = [
  ["raw", (m) => m],
  ["Error: prefix", (m) => `Error: ${m}`],
  ["NonRetryableError: prefix", (m) => `NonRetryableError: ${m}`],
  ["step-failure wrapper", (m) => `Step submit/ai-extract failed: ${m}`],
];

describe("OPE-1316 — classifyExtractFailure across the step boundary", () => {
  for (const [label, wrap] of WRAPS) {
    it(`${label}: the NEAR-Fest AI timeout is ai-timeout, not other`, () => {
      expect(classifyExtractFailure(new Error(wrap(NEAR_FEST)))).toBe("ai-timeout");
    });
    it(`${label}: zero-events / thin-content / parse-error / network timeout`, () => {
      expect(classifyExtractFailure(new Error(wrap("extract-upstream: zero-events")))).toBe(
        "zero-events"
      );
      expect(classifyExtractFailure(new Error(wrap("extract-upstream: thin-content")))).toBe(
        "thin-content"
      );
      expect(
        classifyExtractFailure(new Error(wrap("extract-upstream: could not parse JSON")))
      ).toBe("parse-error");
      expect(classifyExtractFailure(new Error(wrap("extract-network: request timed out")))).toBe(
        "ai-timeout"
      );
    });
    it(`${label}: isZeroEventsFailure (the free-text fallback's gate)`, () => {
      expect(isZeroEventsFailure(new Error(wrap("extract-upstream: zero-events")))).toBe(true);
      expect(isZeroEventsFailure(new Error(wrap(NEAR_FEST)))).toBe(false);
    });
  }

  it("a message with no pipeline token stays `other`, and is returned whole", () => {
    const e = new Error("Something unexpected happened");
    expect(classifyExtractFailure(e)).toBe("other");
    expect(pipelineErrorMessage(e)).toBe("Something unexpected happened");
  });

  it("a non-Error is `other`", () => {
    expect(classifyExtractFailure("extract-upstream: zero-events")).toBe("other");
    expect(classifyExtractFailure(undefined)).toBe("other");
  });

  it("does not mistake a token-like word inside other text for a token", () => {
    expect(pipelineErrorMessage(new Error("prefetch-cache miss"))).toBe("prefetch-cache miss");
  });

  it("finds submit- and fetch- tokens behind a prefix (the outcome-kind readers)", () => {
    expect(pipelineErrorMessage(new Error("Error: submit-409: duplicate"))).toBe(
      "submit-409: duplicate"
    );
    expect(pipelineErrorMessage("Error: fetch-pdf: unsupported")).toBe("fetch-pdf: unsupported");
  });
});
