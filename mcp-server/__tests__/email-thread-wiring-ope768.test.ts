/**
 * OPE-768 — EVERY inbound insert carries a thread key.
 *
 * `email-handler.ts` inserts into `inbound_emails` from four places: the
 * multi-intent parent, its children, the spam path, and the audit-noop path.
 * A thread key applied to three of them is worse than none — the obligation
 * queue would count people correctly except on the paths nobody looks at, and
 * the gap would show up as "some customers are still double-counted", which is
 * indistinguishable from the bug not being fixed.
 *
 * The resolver's own behaviour is tested in
 * `packages/utils/src/email-thread.test.ts`. This file only asserts the wiring,
 * because a correct resolver imported by three of four call sites is exactly
 * the shape this repo keeps logging.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src", "email-handler.ts"), "utf8");

describe("OPE-768 — thread columns reach every inbound insert", () => {
  const inserts = SRC.match(/\.insert\(inboundEmails\)/g) ?? [];
  const spreads = SRC.match(/\.\.\.(?:args\.)?threadColumns,/g) ?? [];

  it("finds the inserts at all — guards against a vacuous pass", () => {
    // If the insert call is ever reshaped and this matches nothing, every
    // assertion below passes over an empty set and reports a clean bill of
    // health for a file it never read.
    expect(inserts.length).toBeGreaterThanOrEqual(4);
  });

  it("every inbound insert is matched by a threadColumns spread", () => {
    expect(spreads.length).toBe(inserts.length);
  });

  it("the thread is resolved ONCE per message, not per insert", () => {
    // Four resolutions for one message would mint four thread ids for the
    // multi-intent family, which is the same defect wearing a different hat.
    const resolutions = SRC.match(/await resolveThreadColumns\(/g) ?? [];
    expect(resolutions).toHaveLength(1);
  });

  it("resolution is fail-soft — threading never takes a real message down", () => {
    // Bookkeeping must not be able to reject mail. The catch returns a fresh
    // thread rather than rethrowing.
    const fn = SRC.slice(
      SRC.indexOf("async function resolveThreadColumns("),
      SRC.indexOf("async function resolveSenderColumns(")
    );
    expect(fn).toContain("} catch (err) {");
    expect(fn).toContain('threadBasis: "new"');
    expect(fn).not.toMatch(/}\s*catch\s*\([^)]*\)\s*{\s*throw/);
  });

  it("the candidate scan is bounded", () => {
    // An unbounded scan of inbound_emails on every message is a slow path that
    // gets slower every day, on the hot ingest route.
    expect(SRC).toMatch(/THREAD_CANDIDATE_WINDOW\s*=\s*\d+/);
    expect(SRC).toContain("limit(THREAD_CANDIDATE_WINDOW)");
  });
});
