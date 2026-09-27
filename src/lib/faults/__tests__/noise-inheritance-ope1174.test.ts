/**
 * OPE-1174 — a noise ruling sticks across routes, for the shapes where it means
 * something; three stackless in-app-browser / extension shapes are denylisted.
 *
 * Every positive case sits beside the case it must NOT touch: the auth routes
 * (OPE-173 — `/register#script error.` was the registration-blocking Turnstile
 * throw) and the low-information classes (OPE-613 — a bundle-everything
 * message is no evidence about which fault it is).
 */
import { describe, it, expect } from "vitest";
import { classifyNoise } from "../signature";
import {
  reconcileFaults,
  isHighInformationClass,
  type FaultLedgerRow,
  type GroupedFault,
} from "../reconcile";

const DDG = "error: invalid call to runtime.sendmessage(). tab not found.";
const DDG_RAW = "Error: Invalid call to runtime.sendMessage(). Tab not found.";
const WK = "Error: WKWebView API client did not respond to this postMessage";
const ORIGIN = "Error: Invalid origin";
const DDG_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Ddg/26.3";
const OUR_STACK = "at renderEvent (https://meetmeatthefair.com/_next/static/chunks/app.js:23:1)";

describe("classifyNoise — the three stackless shapes", () => {
  it.each([
    ["DuckDuckGo tab-not-found", DDG_RAW],
    ["WKWebView postMessage", WK],
    ["Invalid origin", ORIGIN],
  ])("%s with no stack is third-party noise on an ordinary route", (_l, message) => {
    const v = classifyNoise({ message, route: "/events/maine", stackTrace: null });
    expect(v).toMatchObject({ noise: true, reason: "third-party" });
    expect(v.matched).toMatch(/^stackless:/);
  });

  it.each(["/register", "/login"])(
    "ACCEPTANCE: on %s all three still mint a candidate (OPE-173 carve-out)",
    (route) => {
      for (const message of [DDG_RAW, WK, ORIGIN]) {
        expect(classifyNoise({ message, route, stackTrace: null }).noise).toBe(false);
      }
    }
  );

  it("WITH a stack of ours, the same words stay a candidate", () => {
    for (const message of [WK, ORIGIN]) {
      expect(classifyNoise({ message, route: "/events/maine", stackTrace: OUR_STACK }).noise).toBe(
        false
      );
    }
  });

  it("the DuckDuckGo shape also qualifies on its UA when a stack is present", () => {
    const common = { message: DDG_RAW, route: "/events/maine", stackTrace: OUR_STACK };
    expect(classifyNoise({ ...common, userAgent: DDG_UA }).noise).toBe(true);
    expect(classifyNoise({ ...common, userAgent: "Mozilla/5.0 Safari/605" }).noise).toBe(false);
  });

  it("LANDMARK: an unrelated stackless message is not swept in", () => {
    expect(
      classifyNoise({ message: "TypeError: x is undefined", route: "/events/maine" }).noise
    ).toBe(false);
  });
});

// ── Class-level inheritance ─────────────────────────────────────────────────

const NOW = new Date("2026-09-27T12:00:00Z");
const HOUR = 3_600_000;

function group(route: string, errorClass: string): GroupedFault {
  return {
    signature: `${route}#${errorClass}`,
    route,
    errorClass,
    count: 5,
    distinctSessions: 5, // clears every gate, so a `proposed` outcome is not a threshold artefact
    firstSeen: NOW.getTime() - 5 * HOUR,
    lastSeen: NOW.getTime() - HOUR,
  };
}

function ledger(route: string, errorClass: string, status: string, opeId: string | null = null) {
  return {
    signature: `${route}#${errorClass}`,
    route,
    errorClass,
    firstSeen: NOW.getTime() - 200 * HOUR,
    lastSeen: NOW.getTime() - 20 * HOUR,
    count: 4,
    status: status as FaultLedgerRow["status"],
    opeId,
    filedAt: opeId ? NOW.getTime() - 50 * HOUR : null,
    resolvedAt: null,
    createdAt: NOW.getTime() - 200 * HOUR,
  } satisfies FaultLedgerRow;
}

const ruledNoise = (cls: string, n: number) =>
  Array.from({ length: n }, (_, i) => ledger(`/events/ruled-${i}`, cls, "noise"));

describe("reconcileFaults — noise inheritance", () => {
  it("ACCEPTANCE: a new route for a class ruled noise on >=3 routes mints noise, not proposed", () => {
    const r = reconcileFaults([group("/events/maine", DDG)], ruledNoise(DDG, 5), NOW);
    expect(r.upserts).toEqual([
      expect.objectContaining({ op: "noise", signature: `/events/maine#${DDG}` }),
    ]);
    expect(r.toEmit).toHaveLength(0);
    expect(r.inheritedNoise).toEqual([
      { signature: `/events/maine#${DDG}`, errorClass: DDG, noiseRows: 5 },
    ]);
  });

  it("ACCEPTANCE: `undefined` still mints proposed, however many noise rows it has", () => {
    const r = reconcileFaults(
      [group("/events/maine", "undefined")],
      ruledNoise("undefined", 9),
      NOW
    );
    expect(r.upserts[0]).toMatchObject({ op: "propose" });
    expect(r.inheritedNoise).toHaveLength(0);
  });

  it("two noise rows are not enough", () => {
    const r = reconcileFaults([group("/events/maine", DDG)], ruledNoise(DDG, 2), NOW);
    expect(r.upserts[0]).toMatchObject({ op: "propose" });
  });

  it("any route ruled a REAL fault blocks inheritance", () => {
    for (const status of ["open", "filed", "regressed"]) {
      const r = reconcileFaults(
        [group("/events/maine", DDG)],
        [...ruledNoise(DDG, 5), ledger("/blog/x", DDG, status, "OPE-1")],
        NOW
      );
      expect(r.upserts[0].op).not.toBe("noise");
    }
  });

  it("server-lane rows never inherit (sources sharing a class are different faults)", () => {
    const r = reconcileFaults(
      [group("api/some-job", DDG)],
      ruledNoise(DDG, 5).map((row, i) => ({ ...row, route: `api/job-${i}` })),
      NOW
    );
    expect(r.upserts[0]).toMatchObject({ op: "propose" });
  });

  it("an existing row is never re-minted", () => {
    const r = reconcileFaults(
      [group("/events/maine", DDG)],
      [...ruledNoise(DDG, 5), ledger("/events/maine", DDG, "proposed")],
      NOW
    );
    expect(r.upserts.some((u) => u.op === "noise")).toBe(false);
  });
});

describe("isHighInformationClass", () => {
  it("excludes the bundle-everything classes and anything under 20 chars", () => {
    for (const c of [
      "undefined",
      "script error.",
      "failed to fetch",
      "load failed",
      "[object event]",
      "short msg",
    ]) {
      expect(isHighInformationClass(c)).toBe(false);
    }
    expect(isHighInformationClass(DDG)).toBe(true);
  });
});
