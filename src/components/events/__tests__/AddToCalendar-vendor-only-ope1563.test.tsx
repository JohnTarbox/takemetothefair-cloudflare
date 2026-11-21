/**
 * OPE-1563 — the Add-to-calendar menu must not put a vendor-setup row on a
 * visitor's calendar. It filtered `closed` only, so GAHS's 07:00–09:00
 * "Vendor setup" row would have been a VEVENT in the .ics, and, as the
 * earliest open-day row, the Google/Outlook start.
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AddToCalendar } from "../AddToCalendar";

const days = (vendorOnly: boolean) => [
  { date: "2026-12-18", openTime: "16:00", closeTime: "20:00", vendorOnly },
  { date: "2026-12-19", openTime: "09:00", closeTime: "14:00" },
];

function hrefs(vendorOnly: boolean): string[] {
  const { getAllByRole, container } = render(
    <AddToCalendar
      title="GAHS Interact Club Holiday Craft Fair 2026"
      description="Craft fair"
      location="Gardiner, ME"
      startDate={new Date("2026-12-19T12:00:00Z")}
      endDate={new Date("2026-12-19T12:00:00Z")}
      url="https://meetmeatthefair.com/events/gahs-interact-club-craft-fair/2026-12"
      eventDays={days(vendorOnly)}
    />
  );
  fireEvent.click(getAllByRole("button", { name: "Add to calendar" })[0]);
  return [...container.querySelectorAll("a")].map((a) => decodeURIComponent(a.href));
}

describe("OPE-1563 — AddToCalendar skips vendor_only days", () => {
  it("no link or .ics carries the 2026-12-18 setup row", () => {
    const links = hrefs(true);
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const h of links) expect(h).not.toContain("20261218");
    expect(links.some((h) => h.includes("20261219"))).toBe(true);
  });

  it("control: the same row without vendorOnly IS on the calendar", () => {
    expect(hrefs(false).some((h) => h.includes("20261218"))).toBe(true);
  });
});
