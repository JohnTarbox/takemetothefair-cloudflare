/**
 * OPE-1559 — the free-listing CTA and SEO landing, approved by John 2026-11-02
 * (comment e9ac732f, "approve all four as written").
 *
 * What these pin: the approved copy verbatim; every placement wired exactly
 * once (the scorecard reads clicks BY placement, so a missing or doubled one is
 * a wrong number, not a cosmetic slip); the landing indexable and in the
 * sitemap; and a click actually emitting the declared event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LIST_YOUR_EVENT_FAQ,
  LIST_YOUR_EVENT_PATHS,
  LIST_YOUR_EVENT_TITLE,
  listYourEventDescription,
  listYourEventStateTitle,
} from "@/lib/list-your-event/landing-content";
import { findTrackedEvent, BEACON_EVENT_NAMES } from "@/lib/analytics/event-sinks";

const trackSpy = vi.fn();
vi.mock("@/lib/analytics", () => ({ track: (...a: unknown[]) => trackSpy(...a) }));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory())
      return n === "__tests__" || n === "node_modules" ? [] : srcFiles(p);
    return /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("approved copy, verbatim", () => {
  it("SERP titles and descriptions", () => {
    expect(LIST_YOUR_EVENT_TITLE).toBe(
      "List Your Fair or Festival Free — New England | Meet Me at the Fair"
    );
    expect(listYourEventDescription()).toBe(
      "Running a fair, festival or craft show in New England? Add it to Meet Me at the Fair free — one short form, no account. Every listing is reviewed by a person."
    );
    expect(listYourEventStateTitle("Maine")).toBe(
      "List Your Craft Fair or Festival Free in Maine | Meet Me at the Fair"
    );
    expect(listYourEventDescription("Maine")).toContain("craft show in Maine?");
  });

  it("FAQ: the four approved items, ≥3 for FAQPage, and no time promise", () => {
    expect(LIST_YOUR_EVENT_FAQ.map((f) => f.question)).toEqual([
      "Is it really free?",
      "When will my event show up?",
      "What can I list?",
      "Can I change it later?",
    ]);
    expect(LIST_YOUR_EVENT_FAQ.length).toBeGreaterThanOrEqual(3);
    for (const f of LIST_YOUR_EVENT_FAQ) {
      expect(f.answer).not.toMatch(/\b(\d+\s*)?(hours?|days?|weeks?)\b/i);
    }
  });

  it("the landing paths are the hub plus the six states", () => {
    expect(LIST_YOUR_EVENT_PATHS).toEqual([
      "/list-your-event",
      "/list-your-event/maine",
      "/list-your-event/new-hampshire",
      "/list-your-event/vermont",
      "/list-your-event/massachusetts",
      "/list-your-event/connecticut",
      "/list-your-event/rhode-island",
    ]);
  });
});

describe("every placement wired exactly once", () => {
  const PLACEMENTS = [
    "nav_desktop",
    "nav_mobile",
    "footer",
    "event_page",
    "state_page",
    "state_facet_page",
  ];
  const files = srcFiles(join(process.cwd(), "src"));
  const uses = (placement: string) =>
    files.filter((f) =>
      read(f.replace(process.cwd() + "/", "")).includes(`placement="${placement}"`)
    );

  it("landmark: the type declares exactly these placements", () => {
    const cta = read("src/components/list-your-event/list-event-cta.tsx");
    const declared = [...cta.matchAll(/\| "([a-z_]+)"/g)].map((m) => m[1]);
    expect(declared).toEqual(PLACEMENTS);
  });

  it.each(PLACEMENTS)("%s is used in exactly one file", (p) => {
    expect(uses(p)).toHaveLength(1);
  });

  it("the footer no longer sends listers to account signup", () => {
    const footer = read("src/components/layout/footer.tsx");
    expect(footer).toContain('{ name: "List Your Event", href: "/list-your-event" }');
    expect(footer).not.toContain('"List Your Event", href: "/register?role=promoter"');
  });

  it("state CTAs link the per-state landing", () => {
    for (const f of [
      "src/components/events/state-events-page.tsx",
      "src/components/events/state-facet-page.tsx",
    ]) {
      expect(read(f)).toContain("href={`/list-your-event/${stateSlug}`}");
    }
  });
});

describe("indexable and in the sitemap", () => {
  it("the hub page is index:true (the #1704 noindex is flipped)", () => {
    const page = read("src/app/list-your-event/page.tsx");
    expect(page).toContain("robots: { index: true, follow: true }");
    expect(page).not.toContain("index: false");
  });

  it("the state pages are index:true and refuse unknown slugs", () => {
    const page = read("src/app/list-your-event/[state]/page.tsx");
    expect(page).toContain("robots: { index: true, follow: true }");
    expect(page).toContain("export const dynamicParams = false;");
  });

  it("sitemap-static lists every landing path", () => {
    const sm = read("src/app/sitemap-static.xml/route.ts");
    expect(sm).toMatch(/\.\.\.LIST_YOUR_EVENT_PATHS\.map\(/);
  });
});

describe("a click emits the declared event", () => {
  // Braced on purpose: an arrow that RETURNS the mock (mockReset returns it)
  // is taken by vitest as a teardown hook and called after each test.
  beforeEach(() => {
    trackSpy.mockReset();
  });

  it("list_cta_click is declared for both sinks, so the beacon allowlist accepts it", () => {
    expect(findTrackedEvent("list_cta_click")?.sinks).toEqual(["ga4", "beacon"]);
    expect(BEACON_EVENT_NAMES).toContain("list_cta_click");
  });

  it("clicking the CTA tracks its placement and href", async () => {
    const { ListEventCtaLink } = await import("@/components/list-your-event/list-event-cta");
    const { getByText } = render(
      <ListEventCtaLink placement="state_page" href="/list-your-event/maine">
        List it free
      </ListEventCtaLink>
    );
    const a = getByText("List it free");
    expect(a.getAttribute("href")).toBe("/list-your-event/maine");
    fireEvent.click(a);
    expect(trackSpy).toHaveBeenCalledWith("list_cta_click", {
      placement: "state_page",
      href: "/list-your-event/maine",
    });
  });

  it("a throwing tracker never blocks the click's own handler", async () => {
    trackSpy.mockImplementation(() => {
      throw new Error("gtag missing");
    });
    const onClick = vi.fn();
    const { ListEventCtaLink } = await import("@/components/list-your-event/list-event-cta");
    const { getByText } = render(
      <ListEventCtaLink placement="nav_mobile" onClick={onClick}>
        Mobile CTA
      </ListEventCtaLink>
    );
    fireEvent.click(getByText("Mobile CTA"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
