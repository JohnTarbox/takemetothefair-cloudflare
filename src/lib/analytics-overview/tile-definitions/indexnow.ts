import type { TileDefinition } from "./types";

export const INDEXNOW_TILES = {
  "indexnow.recent-submissions": {
    measures:
      "The newest IndexNow log rows (25, 100 or 250), each with source, URL count, status, HTTP code and error or URLs, optionally filtered to one source.",
    source: "indexnow_submissions.",
    window:
      "Newest first, read live on page load. A retention job deletes rows older than 30 days.",
    caveats:
      "One row per attempt, not per URL. Includes 'skipped' rows the circuit breaker deferred (grey badge, Bing never contacted), plus no_key and no_eligible_urls rows. The source dropdown lists only the first 50 source names alphabetically.",
  },
} satisfies Record<string, TileDefinition>;
