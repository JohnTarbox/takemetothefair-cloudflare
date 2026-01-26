"use client";

import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";

export type SortDirection = "asc" | "desc" | null;

export interface SortConfig {
  column: string;
  direction: SortDirection;
}

interface SortableHeaderProps {
  column: string;
  label: string;
  sortConfig: SortConfig;
  onSort: (column: string) => void;
  className?: string;
}

export function SortableHeader({
  column,
  label,
  sortConfig,
  onSort,
  className = "",
}: SortableHeaderProps) {
  const isActive = sortConfig.column === column;
  const direction = isActive ? sortConfig.direction : null;

  return (
    <th
      className={`text-left py-3 px-4 text-sm font-medium text-gray-600 cursor-pointer hover:bg-gray-50 select-none ${className}`}
      onClick={() => onSort(column)}
    >
      <div className="flex items-center gap-1">
        {label}
        <span className="text-gray-400">
          {direction === "asc" ? (
            <ChevronUp className="w-4 h-4" />
          ) : direction === "desc" ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronsUpDown className="w-4 h-4 opacity-50" />
          )}
        </span>
      </div>
    </th>
  );
}

// Generic sort function for arrays
export function sortData<T>(
  data: T[],
  sortConfig: SortConfig,
  getters: Record<string, (item: T) => string | number | boolean | null | undefined>
): T[] {
  if (!sortConfig.column || !sortConfig.direction) {
    return data;
  }

  const getter = getters[sortConfig.column];
  if (!getter) {
    return data;
  }

  return [...data].sort((a, b) => {
    const aVal = getter(a);
    const bVal = getter(b);

    // Handle null/undefined
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return sortConfig.direction === "asc" ? 1 : -1;
    if (bVal == null) return sortConfig.direction === "asc" ? -1 : 1;

    // Compare values
    let comparison = 0;
    if (typeof aVal === "string" && typeof bVal === "string") {
      comparison = aVal.localeCompare(bVal, undefined, { sensitivity: "base" });
    } else if (typeof aVal === "boolean" && typeof bVal === "boolean") {
      comparison = aVal === bVal ? 0 : aVal ? -1 : 1;
    } else {
      comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    }

    return sortConfig.direction === "asc" ? comparison : -comparison;
  });
}

// Hook-like function to handle sort toggling
export function getNextSortDirection(
  currentConfig: SortConfig,
  column: string
): SortConfig {
  if (currentConfig.column !== column) {
    return { column, direction: "asc" };
  }
  if (currentConfig.direction === "asc") {
    return { column, direction: "desc" };
  }
  return { column: "", direction: null };
}
