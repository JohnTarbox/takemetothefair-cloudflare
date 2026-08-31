/**
 * OPE-537 — `extract-400` told us nothing, and it should have.
 *
 * The endpoint answered "Content is required", which names the failing field
 * exactly. `submitExtract` threw `extract-${res.status}` and dropped the body,
 * so diagnosing the 2026-08-24 re-submit took three D1 queries against
 * telemetry columns instead of reading one log line.
 *
 * `submitFetch` in the same file already captured upstream error text. These
 * two call sites did not — the same swallowed-detail defect this whole ticket
 * is about, one function apart.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SUBMIT = readFileSync(resolve(__dirname, "..", "src", "email-handlers", "submit.ts"), "utf8");
const FETCH_ROUTE = readFileSync(
  resolve(__dirname, "..", "..", "src", "app", "api", "admin", "import-url", "fetch", "route.ts"),
  "utf8"
);

describe("submitExtract / submitFreeTextExtract carry the endpoint's message", () => {
  it("no longer throws a bare status with the body discarded", () => {
    // The exact expression that lost "Content is required".
    expect(SUBMIT).not.toContain("throw new NonRetryableError(`extract-${res.status}`);");
  });

  it("reads the upstream error and appends it to the thrown message", () => {
    expect(SUBMIT).toContain('"error" in b ? String(b.error) : null');
    expect(SUBMIT).toContain('`extract-${res.status}${upstream ? `: ${upstream}` : ""}`');
  });

  it("fixes BOTH call sites, not one", () => {
    // There were two identical throws. Fixing one and leaving the other is the
    // precise failure mode that made OPE-457's prose fix incomplete and cost
    // this ticket its existence.
    const occurrences = SUBMIT.split("const upstream = await res").length - 1;
    expect(occurrences).toBe(2);
  });

  it("does not let a non-JSON body turn a 400 into a network error", () => {
    // `.clone()` so the body is still readable, `.catch(() => null)` so a
    // non-JSON error page degrades to the bare status rather than throwing
    // inside the error path.
    expect(SUBMIT).toContain(".clone()");
    expect(SUBMIT).toContain(".catch(() => null)");
  });
});

describe("the fetch route refuses to report an empty page as success", () => {
  it("checks extractable text and escalates instead of returning success", () => {
    // OPE-537 item 3 widened this condition: a bot-check interstitial escalates
    // on the same branch, because it is the same failure wearing content. The
    // assertion now names BOTH triggers rather than the old exact line — the
    // emptiness check must survive the widening, which is what this pins.
    expect(FETCH_ROUTE).toMatch(
      /if \(isEmptyExtraction\(content\) \|\| challenge\.isChallenge\) \{/
    );
    expect(FETCH_ROUTE).toContain("fetchViaBrowserRendering(parsedUrl.href, cfEnv)");
  });

  it("treats a bot-check interstitial as a fetch failure too (OPE-537 item 3)", () => {
    // A challenge page yields real, extractable text about nothing, so it
    // clears the 32-char floor that isEmptyExtraction enforces. Specimen
    // `1da06d90` — an event named "Just a moment...".
    expect(FETCH_ROUTE).toContain("detectChallengePage");
    expect(FETCH_ROUTE).toContain("CHALLENGE_USER_MESSAGE");
  });

  it("names THIS cause in the failure rather than leaving it to a downstream validator", () => {
    expect(FETCH_ROUTE).toContain("found no readable text");
    expect(FETCH_ROUTE).toContain('fetchMethod: "failed"');
  });

  it("does not re-escalate when the HTML already came from Browser Rendering", () => {
    // Otherwise an empty render would call Browser Rendering a second time for
    // the same page, doubling latency and quota to get the same empty string.
    expect(FETCH_ROUTE).toContain('const alreadyRendered = fetchMethod === "browser-rendering";');
  });

  it("logs the diagnosis, including the BR outcome", () => {
    expect(FETCH_ROUTE).toContain("Fetch returned 200 with no extractable text");
    expect(FETCH_ROUTE).toContain("extractedChars");
    expect(FETCH_ROUTE).toContain("brError");
  });
});
