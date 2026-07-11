/**
 * OPE-173 regression guard. `size: "invisible"` is NOT a valid Cloudflare
 * Turnstile explicit-render parameter — the widget throws `TurnstileError` on
 * init, produces no token, and silently blocks the form submit. This shipped
 * twice (OPE-150 exposed it once the sitekey mounted, OPE-173 fixed it), so pin
 * it: no Turnstile mount may pass an invalid `size`. Valid values are only
 * "normal", "compact", "flexible"; invisible/managed behavior is configured on
 * the sitekey in the Cloudflare dashboard, not via `size`.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const TURNSTILE_MOUNTS = ["src/app/(auth)/register/page.tsx", "src/app/suggest-event/page.tsx"];

const INVALID_SIZE = /size:\s*["'`]invisible["'`]/;
const SIZE_PROP = /size:\s*["'`]([a-z]+)["'`]/g;
const VALID_SIZES = new Set(["normal", "compact", "flexible"]);

describe("Turnstile render size param (OPE-173)", () => {
  for (const file of TURNSTILE_MOUNTS) {
    it(`${file} never passes the invalid size:"invisible"`, () => {
      const src = readFileSync(file, "utf8");
      expect(INVALID_SIZE.test(src)).toBe(false);
    });

    it(`${file} only uses valid Turnstile size values`, () => {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(SIZE_PROP)) {
        expect(VALID_SIZES.has(m[1])).toBe(true);
      }
    });
  }
});
