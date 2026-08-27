/**
 * OPE-574 — the render-fault signal that survives a copy edit.
 *
 * ## Why a body marker rather than a status code
 *
 * The status line is not available to this boundary and cannot be made so on
 * these routes. `/events`, `/venues` and `/vendors` each keep a `loading.tsx`
 * inside their `(listing)` route group (OPE-420), which opens a Suspense
 * boundary and streams — the 200 is flushed before the page body runs, so a
 * throw afterwards renders the boundary into an already-committed response.
 * That is deliberate: the dynamic `[slug]` routes were moved OUT of those
 * groups exactly so they could still send a real 404.
 *
 * An apex Worker used to rewrite 200 -> 500 by reading a hidden marker here.
 * The OpenNext cutover retired that Worker and the marker went with it, leaving
 * body shape as the only external tell — and the only stable one was an H1
 * string that any copy edit would silently break.
 *
 * ## What these tests are actually protecting
 *
 * The failure this guards against is not "the marker is absent". It is "the
 * marker is present but says the same thing in both cases", or "it renders on a
 * healthy page too". Either makes it useless as an oracle while looking fine.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null }),
}));
vi.mock("@/lib/report-client-error", () => ({
  reportClientError: vi.fn(),
}));
vi.mock("@/lib/stale-chunk-recovery", () => ({
  recoverFromStaleChunkInBrowser: vi.fn(),
}));

import Error from "../error";

/** A FetchError as the page fetchers throw it (REL1' §1 / K2). */
function fetchError(): globalThis.Error {
  const e = new globalThis.Error("app/events/page.tsx:getEvents");
  e.name = "FetchError";
  return e;
}

const marker = (c: HTMLElement) =>
  c.querySelector('meta[name="x-render-fault"]')?.getAttribute("content") ?? null;

describe("the render-fault marker", () => {
  it("marks a failed data fetch as fetch-error", () => {
    const { container } = render(<Error error={fetchError()} reset={() => {}} />);
    expect(marker(container)).toBe("fetch-error");
  });

  it("DISTINGUISHES a render crash from a failed fetch", () => {
    // The whole point of the `content` value. A marker that said the same thing
    // for both would tell an operator something happened and nothing about
    // what to do — a D1 outage and a component crash need different responses.
    const { container } = render(
      <Error error={new globalThis.Error("Cannot read properties of undefined")} reset={() => {}} />
    );
    expect(marker(container)).toBe("render-error");
  });

  it("keeps noindex alongside it, so an outage cannot be indexed", () => {
    const { container } = render(<Error error={fetchError()} reset={() => {}} />);
    expect(container.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex");
  });

  it("still renders the H1 the deploy smoke depends on", () => {
    // .github/workflows/deploy.yml asserts a HEALTHY page does NOT contain
    // this string. The marker is the new contract; this one is still load-
    // bearing until that smoke step is repointed, so it must not be dropped
    // in the same change that adds the replacement.
    const { container } = render(<Error error={fetchError()} reset={() => {}} />);
    expect(container.textContent).toContain("Service temporarily unavailable");
  });

  it("a render crash does NOT claim to be a service outage", () => {
    const { container } = render(<Error error={new globalThis.Error("boom")} reset={() => {}} />);
    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).not.toContain("Service temporarily unavailable");
  });
});
