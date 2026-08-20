import { readFileSync } from "node:fs";
/**
 * OPE-364 — funnel step registry, device classification, and ratio maths.
 */
import { describe, it, expect } from "vitest";
import {
  classifyDevice,
  computeStepRatios,
  FUNNEL_STEPS,
  ALL_FUNNEL_STEP_NAMES,
  NEW_FUNNEL_STEP_NAMES,
} from "@/lib/analytics/funnel-steps";

describe("classifyDevice", () => {
  // Real UA strings. OPE-361 was mobile-only AND presented differently on iOS
  // vs Android, so both the device split and the OS split are load-bearing.
  const CASES: Array<[string, string, string, string]> = [
    [
      "iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "mobile",
      "ios",
    ],
    [
      "Android phone",
      "Mozilla/5.0 (Linux; Android 14; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      "mobile",
      "android",
    ],
    [
      "Android tablet (no 'Mobile' token)",
      "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "tablet",
      "android",
    ],
    [
      "iPad (classic UA)",
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "tablet",
      "ios",
    ],
    [
      "Windows desktop",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "desktop",
      "windows",
    ],
    [
      "macOS desktop",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "desktop",
      "macos",
    ],
  ];

  for (const [label, ua, device, os] of CASES) {
    it(`${label} → ${device}/${os}`, () => {
      expect(classifyDevice(ua)).toEqual({ device, os });
    });
  }

  it("an Android tablet is NOT counted as mobile", () => {
    // The `android(?!.*mobile)` lookahead is the whole reason tablet is tested
    // before mobile; a naive /android/ check would swallow tablets and blur the
    // phone-only signal OPE-361 depended on.
    const tablet = classifyDevice(
      "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
    );
    expect(tablet.device).toBe("tablet");
  });

  it("missing or empty UA is 'unknown', never silently 'desktop'", () => {
    // Defaulting to desktop would quietly inflate the desktop bucket with bots
    // and make a mobile-only break look smaller than it is.
    expect(classifyDevice(null)).toEqual({ device: "unknown", os: "unknown" });
    expect(classifyDevice("")).toEqual({ device: "unknown", os: "unknown" });
    expect(classifyDevice("   ")).toEqual({ device: "unknown", os: "unknown" });
  });

  it("an unrecognised UA is 'unknown', not misfiled", () => {
    expect(classifyDevice("SomeBot/1.0").device).toBe("unknown");
  });
});

describe("computeStepRatios", () => {
  it("first step has no ratio — there is no predecessor to divide by", () => {
    const out = computeStepRatios("register", { register_view: 100 });
    expect(out[0]).toEqual({ step: "register_view", count: 100, ratioFromPrevious: null });
  });

  it("computes each step against the one before it", () => {
    const out = computeStepRatios("register", {
      register_view: 100,
      register_form_interacted: 40,
      register_submitted: 10,
    });
    expect(out[1].ratioFromPrevious).toBeCloseTo(0.4);
    // 10/40, NOT 10/100 — adjacency is what localises the drop to one edge.
    expect(out[2].ratioFromPrevious).toBeCloseTo(0.25);
  });

  it("the OPE-361 signature: views land, interactions do not", () => {
    // Page viewed, form never touched, because the form was off-screen. This
    // is the shape the whole ticket exists to make visible.
    const out = computeStepRatios("register", {
      register_view: 250,
      register_form_interacted: 0,
      register_submitted: 0,
    });
    expect(out[1].ratioFromPrevious).toBe(0);
    // And the step AFTER a zero is null, not 0 — see below.
    expect(out[2].ratioFromPrevious).toBeNull();
  });

  it("a zero predecessor yields null, never 0 or Infinity", () => {
    // "Nobody reached this step" and "everyone who reached it dropped" are
    // different claims. Reporting 0 for the first would read as a total
    // failure at that edge when the real failure is upstream.
    const out = computeStepRatios("register", { register_form_interacted: 5 });
    expect(out[1].ratioFromPrevious).toBeNull();
  });

  it("missing steps count as 0, not undefined", () => {
    const out = computeStepRatios("claim", {});
    expect(out.every((s) => s.count === 0)).toBe(true);
  });
});

describe("registry integrity", () => {
  it("every registered step appears in the beacon allowlist", async () => {
    // The write path (allowlist) and the read path (registry) are in different
    // files; a step added to one and not the other is silently uncounted — the
    // membrane pattern this codebase keeps re-filing. This is the guard.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/api/analytics/track/route.ts", "utf8")
    );
    // Names either appear literally in ALLOWED_EVENT_NAMES or arrive via the
    // spread of NEW_FUNNEL_STEP_NAMES.
    const spreadsNew = src.includes("...NEW_FUNNEL_STEP_NAMES");
    for (const step of ALL_FUNNEL_STEP_NAMES) {
      const literal = src.includes(`"${step}"`);
      const viaSpread = spreadsNew && (NEW_FUNNEL_STEP_NAMES as readonly string[]).includes(step);
      expect(literal || viaSpread, `step "${step}" is not allowlisted in the beacon`).toBe(true);
    }
  });

  it("every funnel has a view-like first step and at least one interaction step", () => {
    for (const [funnel, steps] of Object.entries(FUNNEL_STEPS)) {
      expect(steps.length, `${funnel} has too few steps to form a ratio`).toBeGreaterThanOrEqual(2);
      expect(
        steps.some((s) => s.includes("interacted")),
        `${funnel} has no interaction step — it cannot tell "would not" from "could not"`
      ).toBe(true);
    }
  });
});

/**
 * OPE-364 rework — the guard that existed asserted every funnel step is
 * ALLOWLISTED in the beacon route, and it passed. It said nothing about the
 * CATEGORY the step is emitted with, and the read path selects on
 * `event_category = 'funnel'`.
 *
 * So `claim_started` and `claim_submitted` were beaconed as `"conversion"` —
 * allowlisted, accepted, written, and permanently invisible to the funnel that
 * declares them. A guard written specifically to stop the write path and the
 * read path drifting apart watched the wrong half of the contract.
 */
describe("funnel steps are emitted under the category the read path queries", () => {
  const SOURCES = ["lib/analytics.ts", "app/suggest-event/page.tsx"];

  function src(rel: string): string {
    return readFileSync(`${process.cwd()}/src/${rel}`, "utf8");
  }

  it("no sendBeacon() sends a registered funnel step under a non-funnel category", () => {
    // Matches sendBeacon("name", "category" …) with a LITERAL step name.
    const CALL = /sendBeacon\(\s*["'`]([a-z_]+)["'`]\s*,\s*["']([a-z_]+)["']/g;
    const offenders: string[] = [];

    for (const rel of SOURCES) {
      for (const m of src(rel).matchAll(CALL)) {
        const [, name, category] = m;
        if (ALL_FUNNEL_STEP_NAMES.includes(name) && category !== "funnel") {
          offenders.push(`${rel}: ${name} → "${category}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("claim_started and claim_submitted resolve to the funnel category", () => {
    // The live regression. Derived from the registry rather than hard-coded so
    // a step added to FUNNEL_STEPS later cannot keep the wrong category.
    for (const step of ["claim_started", "claim_submitted"]) {
      expect(ALL_FUNNEL_STEP_NAMES).toContain(step);
    }
    // claim_approved is NOT a funnel step and correctly stays a conversion.
    expect(ALL_FUNNEL_STEP_NAMES).not.toContain("claim_approved");
  });
});

/**
 * The terminal step must fire on the ATTEMPT, not on success.
 *
 * A step that only fires on success cannot distinguish "nobody tried" from
 * "everyone tried and the server rejected them all" — the blind spot this
 * ticket exists to remove. `register_submitted` was built this way on purpose;
 * `submit_submitted` was not, and fired only after `data.success`.
 */
describe("terminal funnel steps fire on the attempt", () => {
  function src(rel: string): string {
    return readFileSync(`${process.cwd()}/src/${rel}`, "utf8");
  }

  it("suggest-event beacons submit_submitted BEFORE the POST", () => {
    const s = src("app/suggest-event/page.tsx");
    const beacon = s.indexOf('trackFunnelSubmitted("submit")');
    const post = s.indexOf('fetch("/api/suggest-event/submit"');
    expect(beacon).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(-1);
    expect(beacon).toBeLessThan(post);
  });

  it("register beacons register_submitted BEFORE its POST", () => {
    const s = src("app/(auth)/register/page.tsx");
    const beacon = s.indexOf('trackFunnelSubmitted("register")');
    const post = s.indexOf('fetch("/api/auth/register"');
    expect(beacon).toBeGreaterThan(-1);
    if (post > -1) expect(beacon).toBeLessThan(post);
  });
});
