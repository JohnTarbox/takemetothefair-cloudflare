"use client";

/**
 * OPE-157 — reusable click-to-sort table header + a pure client-side sort helper,
 * shared by the admin email lists (/admin/inbound-emails, /admin/sent-emails) and
 * available to future admin tables. Client-side by design: both lists load the
 * full (filtered) result set into state in one fetch — no pagination — so sorting
 * the loaded array is correct and needs no server round-trip. Filters/search still
 * run server-side; sort composes on top of the returned rows.
 */
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

export type SortDir = "asc" | "desc";
export interface SortState {
  col: string | null;
  dir: SortDir;
}

/** Toggle sort state for a header click: same col flips dir; new col starts desc. */
export function nextSort(prev: SortState, col: string): SortState {
  if (prev.col === col) return { col, dir: prev.dir === "asc" ? "desc" : "asc" };
  return { col, dir: "desc" };
}

/**
 * Stable-ish sort by a caller-provided value accessor. Numbers compare
 * numerically, everything else case-insensitively as text; nullish values always
 * sort LAST regardless of direction (so empty cells don't crowd the top).
 */
export function sortBy<T>(
  rows: T[],
  col: string | null,
  dir: SortDir,
  value: (row: T, col: string) => string | number | null | undefined
): T[] {
  if (!col) return rows;
  const mult = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a, col);
    const vb = value(b, col);
    const na = va === null || va === undefined;
    const nb = vb === null || vb === undefined;
    if (na && nb) return 0;
    if (na) return 1; // nulls last, both directions
    if (nb) return -1;
    const cmp =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
    return cmp * mult;
  });
}

/** A clickable, keyboard-accessible sortable column header (`<th>`). */
export function SortHeader({
  label,
  col,
  sort,
  onSort,
  className = "",
}: {
  label: string;
  col: string;
  sort: SortState;
  onSort: (col: string) => void;
  className?: string;
}) {
  const active = sort.col === col;
  return (
    <th
      className={`px-3 py-2 ${className}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className="inline-flex items-center gap-1 uppercase hover:text-foreground focus:outline-none focus:ring-2 focus:ring-navy rounded"
      >
        {label}
        {active ? (
          sort.dir === "asc" ? (
            <ArrowUp className="w-3 h-3" />
          ) : (
            <ArrowDown className="w-3 h-3" />
          )
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-30" />
        )}
      </button>
    </th>
  );
}
