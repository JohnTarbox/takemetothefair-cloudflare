/**
 * OPE-1181 — venue history on the public venue page: "Events held here" (all
 * venues) and the FORMER-venue facts, every claim footnoted to its sources.
 *
 * Footnotes are numbered in render order into ONE Sources list per page. A
 * claim with several sources shows all of them — highest certainty first,
 * conflicting ones included, never collapsed to a single "best" source.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { edtfRangeLabel } from "@takemetothefair/utils";
import type {
  HistoryRow,
  PublicCitation,
  VenueHistoryPublic,
} from "@/lib/venues/venue-history-public";

export interface Footnotes {
  cite: (citations: PublicCitation[]) => ReactNode;
  list: PublicCitation[];
}

export function createFootnotes(): Footnotes {
  const list: PublicCitation[] = [];
  const index = new Map<string, number>();
  return {
    list,
    cite(citations) {
      if (citations.length === 0) return null;
      // One number per SOURCE (URL): two claims citing the same page share it.
      const nums = [
        ...new Set(
          citations.map((c) => {
            let n = index.get(c.sourceUrl);
            if (n === undefined) {
              list.push(c);
              n = list.length;
              index.set(c.sourceUrl, n);
            }
            return n;
          })
        ),
      ];
      return (
        <sup className="ml-0.5 text-xs">
          {nums.map((n, i) => (
            <span key={n}>
              {i > 0 && ","}
              <a href={`#source-${n}`} className="text-royal hover:text-navy">
                [{n}]
              </a>
            </span>
          ))}
        </sup>
      );
    },
  };
}

const CERTAINTY_LABEL: Record<string, string> = {
  certain: "",
  "less-certain": " (single source)",
  uncertain: " (uncertain)",
};

export function EventsHeldHere({ rows, fn }: { rows: HistoryRow[]; fn: Footnotes }) {
  if (rows.length === 0) return null;
  return (
    <section data-testid="events-held-here">
      <h2 className="text-xl font-semibold text-foreground mb-3">Events held here</h2>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.key} className="border-l-2 border-stone-200 pl-3">
            <p className="text-foreground">
              {r.seriesSlug ? (
                <Link
                  href={`/events/${r.seriesSlug}`}
                  className="font-medium text-royal hover:text-navy"
                >
                  {r.seriesName}
                </Link>
              ) : (
                <span className="font-medium">{r.seriesName}</span>
              )}
              {r.range && <span className="text-muted-foreground"> · {r.range}</span>}
              {r.certainty && CERTAINTY_LABEL[r.certainty] && (
                <span className="text-muted-foreground text-sm">
                  {CERTAINTY_LABEL[r.certainty]}
                </span>
              )}
              {fn.cite(r.citations)}
              {r.fromListings && (
                <span className="text-muted-foreground text-sm"> (from our listings)</span>
              )}
            </p>
            {r.whereItWent && (
              <p className="text-sm text-muted-foreground mt-1">
                {r.whereItWent.summary.lead}
                {r.whereItWent.summary.targets.map((name, i) => {
                  const v = r.whereItWent!.venues.find((x) => x.name === name);
                  const sep =
                    i === 0
                      ? " "
                      : i === r.whereItWent!.summary.targets.length - 1
                        ? " and "
                        : ", ";
                  return (
                    <span key={name}>
                      {sep}
                      {v && (v.status === "ACTIVE" || v.status === "FORMER") ? (
                        <Link href={`/venues/${v.slug}`} className="text-royal hover:text-navy">
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                    </span>
                  );
                })}
                {r.whereItWent.summary.tail}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const CURRENT_STATE_LABEL: Record<string, string> = {
  REPURPOSED: "Repurposed",
  VACANT: "Vacant",
  DEMOLISHED: "Demolished",
  UNKNOWN: "Current state unknown",
};

export function FormerVenueFacts({
  venue,
  history,
  fn,
}: {
  venue: {
    useStartedEdtf: string | null;
    useEndedEdtf: string | null;
    currentState: string | null;
    currentUse: string | null;
    wikidataQid: string | null;
    nrhpRef: string | null;
  };
  history: VenueHistoryPublic;
  fn: Footnotes;
}) {
  const lc = history.lifecycleCitations;
  const range = edtfRangeLabel(venue.useStartedEdtf, venue.useEndedEdtf);
  return (
    <section data-testid="former-venue-facts" className="space-y-3">
      <p className="text-foreground">
        <span className="font-semibold">Former event venue</span>
        {range && (
          <>
            {" · "}
            {range}
            {fn.cite([...(lc.use_started ?? []), ...(lc.use_ended ?? [])])}
          </>
        )}
      </p>
      {(venue.currentState || venue.currentUse) && (
        <p className="text-foreground">
          <span className="font-semibold">Now: </span>
          {venue.currentState && CURRENT_STATE_LABEL[venue.currentState]}
          {venue.currentState && venue.currentUse && " — "}
          {venue.currentUse}
          {fn.cite([...(lc.current_state ?? []), ...(lc.current_use ?? [])])}
        </p>
      )}
      {history.nameVariants.length > 0 && (
        <div>
          <p className="font-semibold text-foreground">Also known as</p>
          <ul className="list-disc pl-5 text-foreground">
            {history.nameVariants.map((v) => (
              <li key={v.name}>
                {v.name}
                {v.range && <span className="text-muted-foreground"> ({v.range})</span>}
                {fn.cite(v.citations)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(venue.wikidataQid || venue.nrhpRef) && (
        <p className="text-sm text-muted-foreground">
          {venue.wikidataQid && (
            <a
              href={`https://www.wikidata.org/wiki/${venue.wikidataQid}`}
              className="text-royal hover:text-navy"
              rel="noopener noreferrer"
              target="_blank"
            >
              Wikidata {venue.wikidataQid}
            </a>
          )}
          {venue.wikidataQid && venue.nrhpRef && " · "}
          {venue.nrhpRef && <span>National Register of Historic Places #{venue.nrhpRef}</span>}
        </p>
      )}
    </section>
  );
}

export function Sources({ fn }: { fn: Footnotes }) {
  if (fn.list.length === 0) return null;
  return (
    <section data-testid="venue-sources">
      <h2 className="text-xl font-semibold text-foreground mb-3">Sources</h2>
      <ol className="list-decimal pl-5 space-y-1 text-sm text-muted-foreground">
        {fn.list.map((c, i) => (
          <li key={c.id} id={`source-${i + 1}`}>
            <a
              href={c.sourceUrl}
              className="text-royal hover:text-navy break-all"
              rel="noopener noreferrer"
              target="_blank"
            >
              {c.sourceUrl}
            </a>
            {CERTAINTY_LABEL[c.certainty] ?? ""}
            {c.notes && <span> — {c.notes}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
