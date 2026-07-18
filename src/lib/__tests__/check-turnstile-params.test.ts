/**
 * OPE-250 — the Turnstile render-param guard. Registration was blocked for ALL
 * users twice in one week by a bad Turnstile config (OPE-150 empty sitekey,
 * OPE-173 `size: "invisible"`). These lock the guard's behavior so it keeps
 * catching both shapes and doesn't false-positive on the current mounts.
 *
 * Exercises the pure `checkFile` from scripts/check-turnstile-params.ts against
 * synthetic mount source — no filesystem, no process.exit.
 */
import { describe, it, expect } from "vitest";
import { checkFile, __test } from "../../../scripts/check-turnstile-params";

const OK_MOUNT = `
  interface TurnstileOptions {
    sitekey: string;
    size?: "normal" | "compact" | "flexible";
  }
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  window.turnstile.render(el, { sitekey: turnstileSiteKey, callback });
`;

describe("check-turnstile-params guard (OPE-250)", () => {
  it("passes a well-formed mount (tight union, env-sourced sitekey)", () => {
    expect(checkFile("src/app/(auth)/register/page.tsx", OK_MOUNT)).toEqual([]);
  });

  it('FAILS on size: "invisible" — the exact OPE-173 regression', () => {
    const bad = OK_MOUNT.replace("callback });", 'size: "invisible", callback });');
    const v = checkFile("x.tsx", bad);
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((e) => /invisible/.test(e.message))).toBe(true);
  });

  it("FAILS on any other non-enum size value", () => {
    const bad = OK_MOUNT.replace("callback });", 'size: "huge", callback });');
    expect(checkFile("x.tsx", bad).some((e) => /not a legal/.test(e.message))).toBe(true);
  });

  it("FAILS on size type widened to `string` — the durable-regression shape", () => {
    const bad = OK_MOUNT.replace('size?: "normal" | "compact" | "flexible";', "size?: string;");
    expect(checkFile("x.tsx", bad).some((e) => /widen-to-string/.test(e.message))).toBe(true);
  });

  it("FAILS when a union member is not allowed", () => {
    const bad = OK_MOUNT.replace(
      'size?: "normal" | "compact" | "flexible";',
      'size?: "normal" | "invisible";'
    );
    expect(checkFile("x.tsx", bad).some((e) => /invisible/.test(e.message))).toBe(true);
  });

  it("FAILS when the sitekey isn't sourced from the public env var (OPE-150)", () => {
    const bad = OK_MOUNT.replace("process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY", '"hardcoded"');
    expect(
      checkFile("x.tsx", bad).some((e) => /NEXT_PUBLIC_TURNSTILE_SITE_KEY/.test(e.message))
    ).toBe(true);
  });

  it("FAILS on an empty sitekey literal (OPE-150)", () => {
    const bad = OK_MOUNT.replace("{ sitekey: turnstileSiteKey,", '{ sitekey: "",');
    expect(checkFile("x.tsx", bad).some((e) => /empty string/.test(e.message))).toBe(true);
  });

  it("accepts every allowed size and only those", () => {
    expect([...__test.ALLOWED_SIZES].sort()).toEqual(["compact", "flexible", "normal"]);
  });

  it("enumerates both current mounts (kept in lockstep with the app)", () => {
    expect(__test.KNOWN_MOUNTS.has("src/app/(auth)/register/page.tsx")).toBe(true);
    expect(__test.KNOWN_MOUNTS.has("src/app/suggest-event/page.tsx")).toBe(true);
  });
});
