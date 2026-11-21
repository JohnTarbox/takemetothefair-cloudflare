"use client";

// OPE-1488 — host-side wiring that makes every visible date a door into Day view.
//
// The calendar module (`@jonnyboats/calendar-react`, a separate repo) already routes
// date-number clicks, "View full day", and week day-headers to `onNavigateToDay`;
// what it does not do is label them for assistive tech, put the date number in the tab
// order (`tabIndex: -1`), or make the day popover's title a link. Those are added here
// by setting ATTRIBUTES on the module's own nodes and by one delegated listener on the
// wrapper. No nodes are inserted, so React's reconciliation is unaffected. A native fix
// belongs in the module; until it ships, this keeps the behaviour in one place.
//
// Also: Google-Calendar-style keyboard shortcuts (d w m y a t n p), ignored while
// typing in a field or with a modifier held.

import { useEffect, type RefObject } from "react";
import { longDateLabel } from "@/lib/calendar/focus-date";

const DAY_TITLE_PREFIX = "cm-day-title-";
const TG_HEADER_PREFIX = "cm-tg-header-";

function labelDayControls(root: HTMLElement, directYearCells: boolean) {
  if (directYearCells) {
    root
      .querySelectorAll<HTMLElement>(".cm-year-cell:not(.cm-muted)[data-date]")
      .forEach((cell) => {
        const date = cell.dataset.date!;
        if (cell.dataset.dayLink === date) return;
        cell.dataset.dayLink = date;
        cell.setAttribute("aria-label", `View all events on ${longDateLabel(date)}`);
      });
  }
  root.querySelectorAll<HTMLButtonElement>(".cm-date-number").forEach((btn) => {
    const date = btn.closest<HTMLElement>("[data-date]")?.dataset.date;
    if (!date || btn.dataset.dayLink === date) return;
    btn.dataset.dayLink = date;
    btn.tabIndex = 0;
    btn.setAttribute("aria-label", `View all events on ${longDateLabel(date)}`);
  });
  root.querySelectorAll<HTMLButtonElement>(".cm-tg-header").forEach((btn) => {
    const date = btn.dataset.testid?.startsWith(TG_HEADER_PREFIX)
      ? btn.dataset.testid.slice(TG_HEADER_PREFIX.length)
      : null;
    if (!date || btn.dataset.dayLink === date) return;
    btn.dataset.dayLink = date;
    btn.setAttribute("aria-label", `View all events on ${longDateLabel(date)}`);
  });
  root
    .querySelectorAll<HTMLElement>(`.cm-popover-title[id^="${DAY_TITLE_PREFIX}"]`)
    .forEach((h) => {
      const date = h.id.slice(DAY_TITLE_PREFIX.length);
      if (h.dataset.dayLink === date) return;
      h.dataset.dayLink = date;
      h.tabIndex = 0;
      h.setAttribute("role", "link");
      h.setAttribute("aria-label", `View all events on ${longDateLabel(date)} in Day view`);
    });
}

function popoverTitleDate(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest<HTMLElement>(".cm-popover-title") : null;
  return el?.id.startsWith(DAY_TITLE_PREFIX) ? el.id.slice(DAY_TITLE_PREFIX.length) : null;
}

export type CalendarShortcutView = "day" | "week" | "month" | "year" | "agenda";
const SHORTCUT_VIEWS: Record<string, CalendarShortcutView> = {
  d: "day",
  w: "week",
  m: "month",
  y: "year",
  a: "agenda",
};

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

/**
 * @param rootRef      wrapper around the module's calendar
 * @param navigateToDay go to Day view for a "YYYY-MM-DD"
 * @param switchView    go to another view at the current focus date
 */
export function useCalendarDayLinks(
  rootRef: RefObject<HTMLElement | null>,
  navigateToDay: (date: string) => void,
  switchView: (view: CalendarShortcutView) => void,
  opts: { directYearCells?: boolean } = {}
) {
  const directYearCells = opts.directYearCells ?? false;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    labelDayControls(root, directYearCells);
    const observer = new MutationObserver(() => labelDayControls(root, directYearCells));
    observer.observe(root, { childList: true, subtree: true });

    const onClick = (e: MouseEvent) => {
      const date = popoverTitleDate(e.target);
      if (date) navigateToDay(date);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const date = popoverTitleDate(e.target);
      if (date) {
        e.preventDefault();
        navigateToDay(date);
      }
    };
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);

    // Enter/Space on a focused date number. The module's grid keydown handler
    // (arrow-key roving) takes Enter on the way up and opens the day popover, so the
    // button's own click never fires — measured in E2E. Capture phase gets there first.
    const onDateNumberKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const btn =
        e.target instanceof Element ? e.target.closest<HTMLElement>(".cm-date-number") : null;
      const date = btn?.dataset.dayLink;
      if (!date) return;
      e.stopPropagation();
      e.preventDefault();
      navigateToDay(date);
    };
    root.addEventListener("keydown", onDateNumberKey, true);

    // Year view: a day cell goes straight to Day view (the cells are too small for a
    // popover-first flow). Capture phase, so the module's own click/Enter handler —
    // which would open the day popover — never runs. Arrow-key roving is untouched.
    const yearCellDate = (t: EventTarget | null) => {
      const cell = t instanceof Element ? t.closest<HTMLElement>(".cm-year-cell[data-date]") : null;
      return cell && !cell.classList.contains("cm-muted") ? cell.dataset.date! : null;
    };
    const onYearClick = (e: MouseEvent) => {
      const date = yearCellDate(e.target);
      if (!date) return;
      e.stopPropagation();
      e.preventDefault();
      navigateToDay(date);
    };
    const onYearKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const date = yearCellDate(e.target);
      if (!date) return;
      e.stopPropagation();
      e.preventDefault();
      navigateToDay(date);
    };
    if (directYearCells) {
      root.addEventListener("click", onYearClick, true);
      root.addEventListener("keydown", onYearKey, true);
    }

    const onShortcut = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // An open dialog owns the keyboard (Escape, focus trap).
      if (root.querySelector(".cm-popover")) return;
      const key = e.key.toLowerCase();
      const view = SHORTCUT_VIEWS[key];
      if (view) {
        e.preventDefault();
        switchView(view);
        return;
      }
      const button = { t: "cm-today", n: "cm-next", p: "cm-prev" }[key];
      if (button) {
        const el = root.querySelector<HTMLButtonElement>(`[data-testid="${button}"]`);
        if (el && !el.disabled) {
          e.preventDefault();
          el.click();
        }
      }
    };
    document.addEventListener("keydown", onShortcut);

    return () => {
      observer.disconnect();
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("keydown", onDateNumberKey, true);
      root.removeEventListener("click", onYearClick, true);
      root.removeEventListener("keydown", onYearKey, true);
      document.removeEventListener("keydown", onShortcut);
    };
  }, [rootRef, navigateToDay, switchView, directYearCells]);
}
