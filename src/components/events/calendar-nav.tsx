"use client";

// OPE-1488 — the navigation every calendar wrapper shares. Each one pushes a URL
// built by `withFocus`, so the focus date (`date=`) survives every view switch and
// browser Back returns to where the visitor was.

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DayPopover, type DayPopoverSlotCtx } from "@jonnyboats/calendar-react";
import { withFocus } from "@/lib/calendar/focus-date";
import type { CalendarShortcutView } from "./use-calendar-day-links";

export function useCalendarNav(focusDate: string) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const pushFocus = useCallback(
    (focus: string, calView?: string, extra?: (p: URLSearchParams) => void) => {
      const p = withFocus(searchParams, focus, calView);
      extra?.(p);
      router.push(`/events?${p.toString()}`);
    },
    [router, searchParams]
  );

  const navigateToDay = useCallback((date: string) => pushFocus(date, "day"), [pushFocus]);
  const switchView = useCallback(
    (view: CalendarShortcutView) => pushFocus(focusDate, view),
    [pushFocus, focusDate]
  );

  return { pushFocus, navigateToDay, switchView };
}

/** Sort key: all-day first, then by start instant. Exported for tests. */
export function dayEntrySortKey(e: { allDay: boolean; occ: { start: string } }): [number, number] {
  const t = Date.parse(e.occ.start);
  return [e.allDay ? 0 : 1, Number.isNaN(t) ? 0 : t];
}

export function sortDayEntries<T extends { allDay: boolean; occ: { start: string } }>(
  entries: T[]
): T[] {
  return [...entries].sort((a, b) => {
    const [ga, ta] = dayEntrySortKey(a);
    const [gb, tb] = dayEntrySortKey(b);
    return ga - gb || ta - tb;
  });
}

/**
 * The module's own DayPopover (focus trap, Escape, a11y unchanged), with its entries
 * in time order — the module listed "8:00 AM Brunswick Farmers Market" after a 5 PM
 * market on Oct 20.
 */
export function renderSortedDayPopover(ctx: DayPopoverSlotCtx) {
  return (
    <DayPopover
      date={ctx.date}
      entries={sortDayEntries(ctx.entries)}
      locale={ctx.locale}
      onClose={ctx.close}
      onSelectEvent={ctx.selectEvent}
      onViewFullDay={ctx.viewFullDay}
    />
  );
}
