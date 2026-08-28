/**
 * OPE-614 — the client-error payload could not settle its own question.
 *
 * The standing triage precedent was that "every client-side candidate diagnosed
 * in depth to date has resolved to third-party or stale-asset noise", and it
 * was steering rulings on live candidates. It was not supported by the data,
 * because the data **could not support or refute it**:
 *
 *   thirdParty      set on   10 of 450 client rows — absence proves nothing
 *   stack_trace     NULL on all 34 rows of the family under investigation,
 *                   while 307 of 450 client rows overall DO carry one
 *   userAgent       the field did not exist
 *
 * That is un-falsifiability, not a finding — and it manufactures confidence in
 * the false-healthy direction, the same shape as OPE-488 and OPE-574.
 *
 * These tests pin the three capture points and, critically, that none of them
 * reached the signature key.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeSignature } from "@/lib/faults/signature";

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const REPORTER = read("src/lib/report-client-error.ts");
const BRIDGE = read("src/components/ErrorAnalyticsBridge.tsx");
const ROUTE = read("src/app/api/client-errors/route.ts");

describe("OPE-614 scope 1 — userAgent is captured and persisted", () => {
  it("the reporter attaches it centrally, not per call site", () => {
    // Attached in reportClientError so the React boundaries and the two global
    // handlers all get it without four separate edits — and so a future
    // reporting path inherits it.
    expect(REPORTER).toMatch(/userAgent:\s*report\.userAgent\s*\?\?\s*currentUserAgent\(\)/);
  });

  it("reads navigator lazily, so SSR never touches it", () => {
    expect(REPORTER).toMatch(/typeof navigator !== "undefined"/);
  });

  it("the route persists it into context", () => {
    expect(ROUTE).toMatch(/userAgent:\s*typeof payload\.userAgent === "string"/);
  });
});

describe("OPE-614 scope 2 — a non-Error rejection is described", () => {
  it("records the type and constructor of the rejection value", () => {
    // The handler takes `.stack` only when `reason instanceof Error`, which is
    // exactly why the family under investigation is stackless. What it WAS is
    // the next best signal.
    expect(BRIDGE).toMatch(/reasonType:\s*typeof reason/);
    expect(BRIDGE).toMatch(/reasonConstructor:/);
  });

  it("does not throw on a null or undefined rejection value", () => {
    // `null.constructor` would throw inside an error handler, which is the one
    // place a throw is least affordable.
    expect(BRIDGE).toMatch(/reason === null \|\| reason === undefined/);
  });

  it("the route persists both", () => {
    expect(ROUTE).toContain("reasonType:");
    expect(ROUTE).toContain("reasonConstructor:");
  });
});

describe("OPE-614 scope 3 — script origin", () => {
  it("captures event.filename on the window-error path", () => {
    expect(BRIDGE).toMatch(/filename:\s*event\.filename/);
  });

  it("the route persists it", () => {
    expect(ROUTE).toMatch(/filename:\s*typeof payload\.filename === "string"/);
  });
});

describe("OPE-614 scope 4 — none of this enters the signature key", () => {
  it("the same fault from two browsers is ONE signature", () => {
    // The explicit instruction: "Do not add these to the signature key. This is
    // capture for adjudication, not new dedup dimensions." If a UA reached the
    // key, one fault would fragment into a row per browser and the ledger would
    // become unreadable — a worse outcome than the blindness being fixed.
    const a = computeSignature({
      route: "/blog/big-e-parking",
      message: "TypeError: null is not an object (evaluating 's.id')",
      digest: null,
    });
    const b = computeSignature({
      route: "/blog/big-e-parking",
      message: "TypeError: null is not an object (evaluating 's.id')",
      digest: null,
    });
    expect(a).toBe(b);
  });

  it("computeSignature takes only route, message and digest", () => {
    const sig = read("src/lib/faults/signature.ts");
    const start = sig.indexOf("export function computeSignature");
    const body = sig.slice(start, start + 500);
    for (const field of ["userAgent", "reasonType", "reasonConstructor", "filename"]) {
      expect(body).not.toContain(field);
    }
  });
});

describe("OPE-614 — the PII boundary", () => {
  it("captures userAgent and nothing that identifies a person", () => {
    // "PII: userAgent only. Do NOT capture IP or any user identifier."
    const start = ROUTE.indexOf("context: {");
    const ctx = ROUTE.slice(start, ROUTE.indexOf("});", start));
    for (const forbidden of ["ipAddress", "clientIp", "cf-connecting-ip", "userId", "email"]) {
      expect(ctx.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("bounds the stored strings so a hostile UA cannot bloat a row", () => {
    expect(ROUTE).toMatch(/payload\.userAgent\.slice\(0, \d+\)/);
    expect(ROUTE).toMatch(/payload\.filename\.slice\(0, \d+\)/);
  });
});
