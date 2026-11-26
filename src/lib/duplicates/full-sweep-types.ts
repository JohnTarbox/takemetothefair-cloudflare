import type { DuplicateEntityType } from "./types";

/** OPE-1597 — every entity type the daily full-table sweep covers. */
export const FULL_SWEEP_TYPES: readonly DuplicateEntityType[] = [
  "venues",
  "events",
  "vendors",
  "promoters",
];
