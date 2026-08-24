/**
 * OPE-540 — the citation step must leave a trace on SUCCESS and on ZERO,
 * not only on throw.
 *
 * `recordCitationsBestEffort` wrapped its work in `step.do(...)` and wrote a
 * `workflow_run_steps` row only from its catch block. So on 2026-08-24, when
 * five consecutive email-submitted events got zero citations, prod held no
 * record distinguishing:
 *
 *   - the method was never reached (an earlier throw, a branch not taken)
 *   - it ran and `recordSourceCitations` returned 0
 *
 * Source-level assertions, because the behaviour lives in a Workflow class
 * that needs a live `WorkflowStep` binding to instantiate. These pin the
 * wiring; the reason values themselves are covered by
 * citation-zero-reason-ope540.test.ts against the real function.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/workflows/inbound-email.ts", import.meta.url)),
  "utf8"
);

/** The body of recordCitationsBestEffort, isolated so matches cannot drift. */
function citationMethodBody(): string {
  const start = SRC.indexOf("private async recordCitationsBestEffort(");
  expect(start).toBeGreaterThan(-1);
  const next = SRC.indexOf("\n  private async ", start + 10);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

/**
 * Just the `detail: { … }` object of the citations step record.
 *
 * Scoped deliberately. Asserting `toContain("reason: result.reason")` against
 * the whole method passes on the RETURN statement, which also mentions it —
 * so deleting the detail field left the suite green. A mutation caught that;
 * the fix is to look only where the field has to be.
 */
function citationStepDetailBlock(): string {
  const body = citationMethodBody();
  const stepIdx = body.indexOf('stepName: "citations"');
  expect(stepIdx).toBeGreaterThan(-1);
  const detailIdx = body.indexOf("detail: {", stepIdx);
  expect(detailIdx).toBeGreaterThan(-1);
  // Up to the close of the recordWorkflowStep call.
  const end = body.indexOf("})", detailIdx);
  return body.slice(detailIdx, end === -1 ? body.length : end);
}

describe("the citation step records its outcome", () => {
  it("writes a workflow_run_steps row named 'citations'", () => {
    const body = citationMethodBody();
    expect(body).toContain('stepName: "citations"');
  });

  it("marks zero as 'skipped' and a write as 'ok'", () => {
    // Not merely "records something": the status has to distinguish the two,
    // or the row is present and still answers nothing.
    const body = citationMethodBody();
    expect(body).toContain('status: result.inserted > 0 ? "ok" : "skipped"');
  });

  it("carries the REASON into the detail, not just the count", () => {
    // `inserted: 0` alone reproduces the original ambiguity one field over.
    // Scoped to the detail object: the method's RETURN also names
    // `result.reason`, and a whole-body match stayed green when the detail
    // field was deleted.
    const detail = citationStepDetailBlock();
    expect(detail).toContain("reason: result.reason");
    expect(detail).toContain("inserted: result.inserted");
  });

  it("records which source the citation was attributed to", () => {
    const body = citationMethodBody();
    expect(body).toContain("source_kind: source.kind");
    expect(body).toContain("source_ref:");
  });

  it("the record is fail-soft — losing it must not cost the citations", () => {
    // This runs AFTER the insert. A throw here would turn an observability
    // failure into a data failure, which inverts the point of the change.
    //
    // Scoped to the window between the step record and the return. The
    // method's error path ends `logError(...).catch(() => {})`, so a search
    // over the whole tail matched that instead and survived deletion of the
    // guard this test exists to pin.
    const body = citationMethodBody();
    const recordIdx = body.indexOf('stepName: "citations"');
    const returnIdx = body.indexOf("return { inserted: result.inserted", recordIdx);
    expect(returnIdx).toBeGreaterThan(recordIdx);
    const window = body.slice(recordIdx, returnIdx);
    expect(window).toContain(".catch(()");
  });

  it("still logs a warn when the step itself throws", () => {
    // The pre-existing behaviour must survive: the new success-path record
    // is additive, not a replacement for the failure path.
    const body = citationMethodBody();
    expect(body).toContain("recordSourceCitations failed; event unaffected");
  });

  it("threads instanceId and messageRowId as PARAMETERS, not instance state", () => {
    // A field that is only usually right is how observability starts lying.
    const body = citationMethodBody();
    expect(body).toContain("instanceId: string");
    expect(body).toContain("messageRowId: string");
    expect(body).not.toContain("this.instanceId");
  });

  it("every recordCitationsBestEffort call site passes them", () => {
    // Six call sites across two helpers; one missed would compile only if it
    // happened to line up positionally — and would then record the wrong run.
    const calls = SRC.match(/this\.recordCitationsBestEffort\(/g) ?? [];
    const merged = SRC.match(/this\.recordMergedSiblingCitations\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(merged.length).toBeGreaterThanOrEqual(3);
    // Positional threading is verified by tsc; this pins that nobody
    // reintroduces a call that skips the ids by making them optional.
    expect(SRC).not.toContain("instanceId?: string");
    expect(SRC).not.toContain("messageRowId?: string");
  });
});
