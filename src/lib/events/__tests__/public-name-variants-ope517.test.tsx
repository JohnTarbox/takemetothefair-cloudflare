/**
 * OPE-517 — an event's other names, shown as "Also known as" and emitted as
 * schema.org `alternateName` (John, 2026-10-04).
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps } from "react";
import { EventSchema } from "@/components/seo/EventSchema";
import { selectPublicNameVariants, MAX_PUBLIC_VARIANTS } from "../public-name-variants";

const v = (variant: string, variantType: string) => ({ variant, variantType });

describe("which names are public", () => {
  it("the IAA specimen: the organizer's own name leads", () => {
    expect(
      selectPublicNameVariants(
        [
          v("Island Artisans Craft Fair", "aggregator"),
          v("October Craft Fair at Atlantic Oceanside", "organizer_official"),
        ],
        "Bar Harbor Fall Craft Fair 2026"
      )
    ).toEqual(["October Craft Fair at Atlantic Oceanside", "Island Artisans Craft Fair"]);
  });

  it("NEVER a historical name — a superseded invented name must not be republished", () => {
    expect(
      selectPublicNameVariants(
        [v("Revolutionary Era Artisan Event", "historical")],
        "Revolutionary Fair"
      )
    ).toEqual([]);
  });

  it("drops a variant equal to the canonical name, and case/space duplicates", () => {
    expect(
      selectPublicNameVariants(
        [
          v("bar harbor fall craft fair 2026", "common_usage"),
          v("Blistered Fingers  Family Bluegrass Festival", "organizer_official"),
          v("blistered fingers family bluegrass festival", "aggregator"),
        ],
        "Bar Harbor Fall Craft Fair 2026"
      )
    ).toEqual(["Blistered Fingers Family Bluegrass Festival"]);
  });

  it(`caps the line at ${MAX_PUBLIC_VARIANTS}`, () => {
    const rows = Array.from({ length: 9 }, (_, i) => v(`Name ${i}`, "common_usage"));
    expect(selectPublicNameVariants(rows, "X")).toHaveLength(MAX_PUBLIC_VARIANTS);
  });
});

describe("Event JSON-LD alternateName", () => {
  const base = {
    name: "Bar Harbor Fall Craft Fair 2026",
    slug: "bar-harbor-fall-craft-fair-2026",
    url: "https://meetmeatthefair.com/events/bar-harbor-fall-craft-fair-2026",
    startDate: new Date("2026-10-10T12:00:00Z"),
    endDate: new Date("2026-10-11T12:00:00Z"),
    organizer: null,
    lifecycleStatus: "SCHEDULED",
  } as unknown as ComponentProps<typeof EventSchema>;
  const ld = (c: HTMLElement) =>
    JSON.parse(c.querySelector('script[type="application/ld+json"]')!.textContent || "{}");

  it("one variant → a string, and `name` is untouched", () => {
    const { container } = render(
      <EventSchema {...base} alternateNames={["October Craft Fair at Atlantic Oceanside"]} />
    );
    expect(ld(container).alternateName).toBe("October Craft Fair at Atlantic Oceanside");
    expect(ld(container).name).toBe("Bar Harbor Fall Craft Fair 2026");
  });

  it("several → an array", () => {
    const { container } = render(<EventSchema {...base} alternateNames={["A", "B"]} />);
    expect(ld(container).alternateName).toEqual(["A", "B"]);
  });

  it("none → no alternateName key at all", () => {
    const { container } = render(<EventSchema {...base} alternateNames={[]} />);
    expect("alternateName" in ld(container)).toBe(false);
  });
});

describe("the event page wires both surfaces from the same list", () => {
  const src = readFileSync(join(process.cwd(), "src/app/events/[slug]/page.tsx"), "utf8");
  it("fetches the public variants and passes them to the schema and the AKA line", () => {
    expect(src).toContain("getPublicNameVariants(getCloudflareDb(), event.id, event.name)");
    expect(src).toContain("alternateNames={alsoKnownAs}");
    expect(src).toMatch(/alsoKnownAs\.length > 0 &&[\s\S]{0,200}Also known as \{alsoKnownAs\.join/);
  });
});
