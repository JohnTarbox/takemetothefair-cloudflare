/**
 * OPE-1159 — the single registry of /admin/analytics card definitions.
 *
 * One module per tab, merged here, keyed by a stable tile ID
 * (`<tab>.<card>`). `TileId` is derived from the keys, so a card cannot name a
 * definition that does not exist — and `tile-definitions-ope1159.test.ts`
 * catches the reverse: a definition whose card was deleted.
 */
import type { TileDefinition } from "./types";
import { OVERVIEW_KPI_TILES } from "./overview-kpis";
import { OVERVIEW_TILES } from "./overview";
import { RECOMMENDATIONS_TILES } from "./recommendations";
import { GOOGLE_TILES } from "./google";
import { BING_TILES } from "./bing";
import { SITE_HEALTH_TILES } from "./site-health";
import { FIRST_PARTY_EVENTS_TILES } from "./first-party-events";
import { INDEXNOW_TILES } from "./indexnow";

export type { TileDefinition } from "./types";

export const TILE_DEFINITIONS = {
  ...OVERVIEW_KPI_TILES,
  ...OVERVIEW_TILES,
  ...RECOMMENDATIONS_TILES,
  ...GOOGLE_TILES,
  ...BING_TILES,
  ...SITE_HEALTH_TILES,
  ...FIRST_PARTY_EVENTS_TILES,
  ...INDEXNOW_TILES,
} satisfies Record<string, TileDefinition>;

export type TileId = keyof typeof TILE_DEFINITIONS;

/** The tooltip's rows, in reading order. Optional fields are omitted, not blank. */
export function tileLines(id: TileId): Array<{ label: string; text: string }> {
  const d: TileDefinition = TILE_DEFINITIONS[id];
  const lines = [
    { label: "Measures", text: d.measures },
    { label: "Source", text: d.source },
    { label: "Window", text: d.window },
  ];
  if (d.caveats) lines.push({ label: "Doesn't count", text: d.caveats });
  if (d.thresholds) lines.push({ label: "Colours", text: d.thresholds });
  return lines;
}
