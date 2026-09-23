/**
 * OPE-1098 — John's ruling 2026-09-23, Option C (display-only): a TENTATIVE
 * event whose date has passed stays TENTATIVE in the data, but stops PRESENTING
 * as an unconfirmed future event. 238 such rows at filing (198 lifecycle-only,
 * 40 editorial), 36 of them with no end_date.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import {
  isPastUnconfirmed,
  PAST_UNCONFIRMED_GRACE_MS,
  PAST_UNCONFIRMED_LABEL,
} from "@/lib/events/past-unconfirmed";
import { UPCOMING_END_GRACE_MS } from "@/lib/event-dates";
import { EventSchema } from "@/components/seo/EventSchema";
import type { ComponentProps } from "react";

const NOW = new Date("2026-09-23T19:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe("isPastUnconfirmed", () => {
  it("editorial TENTATIVE, ended 3 days ago → past-unconfirmed", () => {
    expect(isPastUnconfirmed({ status: "TENTATIVE", endDate: ago(3) }, NOW)).toBe(true);
  });

  it("lifecycle-only TENTATIVE on an APPROVED event (the 198) → past-unconfirmed", () => {
    expect(
      isPastUnconfirmed(
        { status: "APPROVED", lifecycleStatus: "TENTATIVE", startDate: ago(9), endDate: ago(8) },
        NOW
      )
    ).toBe(true);
  });

  it("no end_date: falls back to start_date (the 36)", () => {
    expect(
      isPastUnconfirmed({ lifecycleStatus: "TENTATIVE", startDate: ago(5), endDate: null }, NOW)
    ).toBe(true);
  });

  it("a FUTURE tentative event is still tentative, not past", () => {
    expect(isPastUnconfirmed({ status: "TENTATIVE", endDate: ago(-10) }, NOW)).toBe(false);
  });

  it("within the listing's 24h end-of-day grace it is not yet past (list and page agree)", () => {
    expect(isPastUnconfirmed({ status: "TENTATIVE", endDate: ago(0.5) }, NOW)).toBe(false);
    expect(PAST_UNCONFIRMED_GRACE_MS).toBe(UPCOMING_END_GRACE_MS);
  });

  it("a past SCHEDULED/OCCURRED event is not this state; nor is a dateless one", () => {
    expect(
      isPastUnconfirmed({ status: "APPROVED", lifecycleStatus: "OCCURRED", endDate: ago(3) }, NOW)
    ).toBe(false);
    expect(isPastUnconfirmed({ status: "TENTATIVE", startDate: null, endDate: null }, NOW)).toBe(
      false
    );
  });
});

describe("JSON-LD: a past-unconfirmed page makes no Event claim at all", () => {
  const props: ComponentProps<typeof EventSchema> = {
    name: "Maynard Country MusicFest",
    slug: "maynard-country-musicfest-2026",
    startDate: ago(40),
    endDate: ago(40),
    url: "https://meetmeatthefair.com/events/maynard-country-musicfest-2026",
    imageUrl: null,
    venue: null,
    stateCode: "MA",
    organizer: null,
    lifecycleStatus: "TENTATIVE",
  };

  it("suppressed when pastUnconfirmed — eventStatus (or its absence) would assert it happened", () => {
    const { container } = render(<EventSchema {...props} pastUnconfirmed />);
    expect(container.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it("control: the same event without the flag still emits", () => {
    const { container } = render(<EventSchema {...props} />);
    expect(container.querySelector('script[type="application/ld+json"]')).not.toBeNull();
  });
});

describe("every public surface reads the one predicate (source)", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  it("event page banner, badge and JSON-LD prop; card; list", () => {
    const page = read("src/app/events/[slug]/page.tsx");
    expect(page).toMatch(/pastUnconfirmed=\{isPastUnconfirmed\(event\)\}/);
    expect(page).toMatch(/event\.status === "TENTATIVE" && !isPastUnconfirmed\(event\)/);
    expect(page.match(/isPastUnconfirmed\(event\)/g)?.length).toBeGreaterThanOrEqual(3);
    for (const f of [
      "src/components/events/event-card.tsx",
      "src/components/events/events-view.tsx",
    ]) {
      expect(read(f)).toMatch(/isPastUnconfirmed\(event\) \?/);
    }
    expect(PAST_UNCONFIRMED_LABEL).toBe("Past event — never confirmed");
  });
});
