/**
 * OPE-1188 — the middleware matcher must cover the occurrence form.
 *
 * OPE-471 shipped a series_slug_history walker for /events/<series>/<year>, but
 * the matcher listed only "/events/:slug", so middleware never ran on a
 * two-segment path and the walker was dead code: /events/fryeburg-fair-me
 * 301'd, /events/fryeburg-fair-me/2027 404'd. Driven through Next's own
 * matcher, not a string comparison of the config.
 */
import { describe, it, expect } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "../middleware";

const matches = (path: string) =>
  unstable_doesMiddlewareMatch({ config, url: `https://meetmeatthefair.com${path}` });

describe("OPE-1188 middleware matcher", () => {
  it("runs on the occurrence form so retired series slugs can 301", () => {
    expect(matches("/events/fryeburg-fair-me/2027")).toBe(true);
    expect(matches("/events/sterling-fair-ma/2027")).toBe(true);
  });
  it("still runs on the flat form (positive landmark)", () => {
    expect(matches("/events/fryeburg-fair-me")).toBe(true);
  });
  it("does not run on facet routes (/events/<state>/<category>)", () => {
    expect(matches("/events/massachusetts/porchfests")).toBe(false);
    expect(matches("/events/maine/this-weekend")).toBe(false);
  });
});
