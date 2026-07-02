import { describe, it, expect } from "vitest";
import type { Metadata } from "next";
import { metadata as registerMetadata } from "../register/layout";
import { metadata as loginMetadata } from "../login/layout";
import { metadata as forgotPasswordMetadata } from "../forgot-password/layout";
import { metadata as resetPasswordMetadata } from "../reset-password/layout";

// OPE-43 (crawl hygiene): auth/action pages must be excluded from the index so
// crawlers don't waste budget on non-content routes. The pages are "use client"
// components, so robots noindex is attached via colocated server layouts.
describe("auth page robots noindex", () => {
  const cases: Array<[string, Metadata]> = [
    ["/register", registerMetadata],
    ["/login", loginMetadata],
    ["/forgot-password", forgotPasswordMetadata],
    ["/reset-password", resetPasswordMetadata],
  ];

  for (const [route, meta] of cases) {
    it(`${route} sets robots.index === false`, () => {
      const robots = meta.robots as { index?: boolean; follow?: boolean } | null | undefined;
      expect(robots).toBeTruthy();
      expect(robots!.index).toBe(false);
      expect(robots!.follow).toBe(false);
    });
  }
});
