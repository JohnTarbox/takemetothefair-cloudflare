import type { TileDefinition } from "./types";

export const FIRST_PARTY_EVENTS_TILES = {
  "first-party-events.event-counts": {
    measures: "How many rows of each event name were recorded in the last 30 days, largest first.",
    source:
      "analytics_events: browser beacon events plus server-side admin events such as event_status_change.",
    window: "Rolling 30 days from page load, read live.",
    caveats:
      "Counts rows, not visitors or sessions. No bot filtering on beacon events. Admin status-change events are mixed in with visitor events.",
    thresholds:
      "Orange 'beacon' warning when the newest row in the 30 days is more than 6 hours old, or there are none.",
  },
  "first-party-events.recent-events": {
    measures:
      "The 100 newest first-party analytics rows from the last 30 days, with category, event name, user ID prefix and properties.",
    source: "analytics_events.",
    window: "Rolling 30 days from page load, newest first, capped at 100 rows. Read live.",
    caveats:
      "Raw rows with no bot filtering; server-side admin events appear alongside visitor beacons. User is blank for signed-out visitors.",
  },
} satisfies Record<string, TileDefinition>;
