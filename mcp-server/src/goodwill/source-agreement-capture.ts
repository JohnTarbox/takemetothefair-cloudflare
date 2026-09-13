/**
 * OPE-988 — file the source-agreement sweep's disagreements as discrepancies.
 *
 * The main-app sweep (`/api/admin/url-health/source-agreement/sweep`) fetches
 * and judges; it does not write `event_discrepancies`. This does, through
 * `captureDiscrepancy` — the one writer of that table, which already owns the
 * open-row dedup (a disagreement seen again tomorrow refreshes `last_seen_at`
 * on the open row instead of filing a second one) and the initial score.
 *
 * ## Why `existence`, not `venue`
 *
 * The Fort Wayne page does not claim our Leominster festival is in Indiana. It
 * is a different event. A `venue` row reads, to an operator and to every
 * consumer keyed on field class, as "the venue we hold is wrong — here is the
 * other source's venue", and the obvious resolution of that row is to move a
 * Massachusetts event to Fort Wayne. What is actually unsupported is the claim
 * that this source evidences THIS event at all — which is what `existence` is
 * for (it is already where `source_tabular_*` source-quality gates land).
 *
 * ## Never an outreach candidate
 *
 * A wrong `source_url` is almost always OUR attribution error, not the
 * organizer's. `forceOutreachCandidate: false`, the same one-directional
 * override OPE-815 uses for aggregator-caused rows.
 */
import type { Db } from "../db.js";
import { captureDiscrepancy } from "./capture.js";

/** Mirrors `SourceDisagreement` in src/lib/goodwill/source-agreement.ts. */
export interface SourceDisagreementFinding {
  eventId: string;
  slug: string;
  sourceUrl: string;
  city: string | null;
  state: string | null;
  venueName: string | null;
  otherStates: string[];
  signals: string[];
  detail: string;
}

/** Report-only evidence: town absent AND another state present, never a fetch of truth. */
const CONFIDENCE = 0.7;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isFinding(x: unknown): x is SourceDisagreementFinding {
  const f = x as SourceDisagreementFinding;
  return (
    !!f &&
    typeof f.eventId === "string" &&
    typeof f.sourceUrl === "string" &&
    Array.isArray(f.otherStates) &&
    Array.isArray(f.signals)
  );
}

export async function captureSourceAgreementDisagreements(
  db: Db,
  findings: unknown[]
): Promise<{ filed: number; refreshedOrFailed: number; malformed: number }> {
  let filed = 0;
  let refreshedOrFailed = 0;
  let malformed = 0;
  for (const f of findings) {
    if (!isFinding(f)) {
      malformed += 1;
      continue;
    }
    const where = [f.venueName, f.city, f.state].filter(Boolean).join(", ");
    const id = await captureDiscrepancy(db, {
      eventId: f.eventId,
      fieldClass: "existence",
      detectedBy: "source_agreement",
      authoritativeValue: where || null,
      authoritativeSourceKey: null,
      authoritativeSourceUrl: null,
      divergentValue: f.otherStates.length > 0 ? f.otherStates.join(",") : null,
      divergentSourceKey: hostOf(f.sourceUrl),
      divergentSourceUrl: f.sourceUrl,
      confidence: CONFIDENCE,
      forceOutreachCandidate: false,
      notes:
        `OPE-988 source_url does not describe this event: ${f.detail} [${f.signals.join(", ")}]`.slice(
          0,
          1000
        ),
    });
    if (id) filed += 1;
    else refreshedOrFailed += 1;
  }
  return { filed, refreshedOrFailed, malformed };
}
