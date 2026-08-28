/**
 * OPE-540 — the N=1 collapse must cite the lone candidate's OWN source.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * `runMultiSourcePipeline` has two ways to create an event:
 *
 *   Phase B — exactly one candidate and no source failures: delegate to
 *             `submitExtractedEvent`, which writes NO citation of any kind.
 *   Phase C — two or more candidates: loop, and cite per source.
 *
 * Only Phase C cited. Phase B's single citation call was
 * `recordMergedSiblingCitations`, which fires only for siblings Phase A.9
 * FOLDED IN — so the candidate's own source, the one that actually produced the
 * event, was never recorded.
 *
 * ── Why this reads as an edge case and is the opposite ───────────────────────
 * `source_count` is 1 on every fanout run in `workflow_run_steps`. The N=1
 * collapse is the ORDINARY shape and Phase C is the exception. That is why
 * `event_data_citations` holds 108 pipeline-written rows in four months against
 * 1,140 written by hand, and why the pipeline's last write was
 * 2026-08-23 01:47:31 — the last time two sources survived to Phase C.
 *
 * The ticket read this as a regression dated 2026-08-24. It is not: zero-
 * citation email events run back to 2026-07-26 at least, and the 08-23 events
 * it used as its healthy baseline carry `created_by = 'admin-user-001'` — an
 * analyst's hand-written citations, not the pipeline's.
 *
 * ── Why source-level ────────────────────────────────────────────────────────
 * Same reason as citation-step-record-ope540.test.ts: the behaviour lives in a
 * Workflow class that needs a live `WorkflowStep` binding to instantiate. These
 * pin the WIRING; `recordSourceCitations` itself is covered against the real
 * function in citation-zero-reason-ope540.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/workflows/inbound-email.ts", import.meta.url)),
  "utf8"
);

/**
 * Just the Phase B branch.
 *
 * Scoped deliberately, and the scoping is the whole test. Phase C two hundred
 * lines below calls `recordCitationsBestEffort` correctly, so ANY assertion
 * made against the whole method — or the whole file — passes with Phase B's
 * call deleted. That is exactly the shape of decorative test this file's
 * sibling already had to correct once.
 */
function phaseBCollapseBranch(): string {
  const start = SRC.indexOf("// ── Phase B: N=1 collapse");
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf("// ── Phase C: fan out over every candidate", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("OPE-540 — Phase B (N=1 collapse) cites the candidate's own source", () => {
  const branch = phaseBCollapseBranch();

  it("is a real, isolated branch — the scan is not vacuous", () => {
    // If the slice ever collapses to nothing, every assertion below passes by
    // finding nothing in an empty string.
    expect(branch.length).toBeGreaterThan(500);
    expect(branch).toContain("submitExtractedEvent(");
  });

  it("calls the citation writer inside the branch", () => {
    expect(branch).toContain("recordCitationsBestEffort(");
  });

  it("cites the candidate's OWN extraction and source, not just folded siblings", () => {
    // The distinction the defect turned on. `recordMergedSiblingCitations` was
    // already here and passes `only.mergedSiblings`; it is not a substitute,
    // because an unfolded lone candidate has no siblings at all — which is the
    // ordinary case and the one that produced no provenance.
    const call = branch.slice(branch.indexOf("recordCitationsBestEffort("));
    expect(call).toContain("only.extracted");
    expect(call).toContain("only.source");
  });

  it("guards on a resulting event id, so a failed submit cites nothing", () => {
    // Citing an event that was never created would attach provenance to
    // `undefined` and throw inside a best-effort path — noise in error_logs
    // for every extract failure.
    expect(branch).toContain("if (res.resultingEventId) {");
  });
});
