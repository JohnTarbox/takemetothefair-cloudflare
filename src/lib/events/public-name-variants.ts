/**
 * OPE-517 — which of an event's other names are shown publicly, as the "Also
 * known as" line and schema.org `alternateName` (John, 2026-10-04: yes to both).
 *
 * `historical` is deliberately NOT public. It holds names the event no longer
 * goes by — including names we got WRONG and superseded (the classifier's
 * invented "Revolutionary Era Artisan Event" is exactly the seed case). Telling
 * visitors and search engines the event is "also known as" a name nobody ever
 * used would republish the error the variant exists to record.
 */
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@/lib/db/schema";
import { eventNameVariants } from "@/lib/db/schema";

export const PUBLIC_VARIANT_TYPES = ["organizer_official", "aggregator", "common_usage"] as const;
/** The organizer's own name leads; the line is a list, not a ranking beyond that. */
const ORDER: Record<string, number> = { organizer_official: 0, aggregator: 1, common_usage: 2 };
export const MAX_PUBLIC_VARIANTS = 5;

const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function selectPublicNameVariants(
  rows: ReadonlyArray<{ variant: string; variantType: string }>,
  canonicalName: string
): string[] {
  const seen = new Set([key(canonicalName)]);
  const out: string[] = [];
  const sorted = rows
    .filter((r) => (PUBLIC_VARIANT_TYPES as readonly string[]).includes(r.variantType))
    .slice()
    .sort((a, b) => ORDER[a.variantType] - ORDER[b.variantType]);
  for (const r of sorted) {
    const v = r.variant.replace(/\s+/g, " ").trim();
    if (!v || seen.has(key(v))) continue;
    seen.add(key(v));
    out.push(v);
    if (out.length >= MAX_PUBLIC_VARIANTS) break;
  }
  return out;
}

export async function getPublicNameVariants(
  db: DrizzleD1Database<typeof schema>,
  eventId: string,
  canonicalName: string
): Promise<string[]> {
  const rows = await db
    .select({ variant: eventNameVariants.variant, variantType: eventNameVariants.variantType })
    .from(eventNameVariants)
    .where(eq(eventNameVariants.eventId, eventId));
  return selectPublicNameVariants(rows, canonicalName);
}
