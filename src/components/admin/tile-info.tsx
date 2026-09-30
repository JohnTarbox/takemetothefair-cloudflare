/**
 * OPE-1159 — a card's ⓘ, fed from the tile-definition registry.
 *
 * Server component: the definition text is looked up here and handed to the
 * client `InfoTip` as plain strings. Pass the tile's `Measurement` when it has
 * one, and the tooltip adds a line saying which OPE-808 render state the tile
 * is in right now (the wording comes from `render-state.ts`, not from here).
 */
import { InfoTip } from "@/components/admin/info-tip";
import {
  TILE_DEFINITIONS,
  tileLines,
  type TileId,
} from "@/lib/analytics-overview/tile-definitions";
import { measurementStateNote, type Measurement } from "@/lib/analytics-overview/render-state";

export function TileInfo({
  id,
  title,
  measurement,
}: {
  id: TileId;
  /** Accessible name; defaults to the tile ID when the title is dynamic. */
  title?: string;
  measurement?: Measurement<unknown> | null;
}) {
  // Touch the registry so an unknown id fails loudly in dev as well as in tsc.
  if (!(id in TILE_DEFINITIONS)) throw new Error(`OPE-1159: no tile definition for "${id}"`);
  return (
    <InfoTip title={title ?? id} lines={tileLines(id)} note={measurementStateNote(measurement)} />
  );
}
