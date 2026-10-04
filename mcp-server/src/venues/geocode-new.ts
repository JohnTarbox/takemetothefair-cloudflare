/**
 * OPE-408 — geocode a venue the MCP Worker just created.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * OPE-207 shipped `venues_geocode` "for OPE-206 batch backfill AND every future
 * new venue". Only the backfill half was wired. OPE-408 then wired the gate
 * into the four MAIN-APP venue writers (2026-08-16) — and left the two writers
 * that live in THIS worker untouched, plus `src/lib/venue-minting.ts`, which
 * OPE-541 added eight days later and which forgot again.
 *
 * The measured cost, read from prod on 2026-08-28: of 29 venues created since
 * the OPE-408 fix landed, 3 still have no pin and 2 of those carry a perfectly
 * resolvable street address — `MGM Springfield` (One MGM Way) created 08-21 and
 * `Hilton Garden Inn Auburn Riverwatch` (14 Great Falls Plaza) created 08-25.
 * Both have `updated_at == created_at`: nothing has touched them since birth.
 *
 * A venue with no pin cannot match a photo (OPE-203 attributes on-site photos
 * by GPS within 1.5 mi), cannot appear in distance/near-me, and cannot go on a
 * map. The failure is silent in all three.
 *
 * ── Why a proxy and not a second implementation ─────────────────────────────
 * The confidence gate has been corrected five times (OPE-213/214/215/219/228)
 * and it governs what may be written to a public record. A second copy would
 * drift, and the failure mode of a drifted confidence gate is a WRONG pin on a
 * real venue — OPE-219 exists because forcing low-confidence results produced
 * four wrong pins that had to be reverted.
 *
 * The MCP Worker is a separate build with no path into `src/`, so it crosses
 * over X-Internal-Key to the one gate, exactly as `venues_geocode` already
 * does. One gate, now four callers.
 *
 * ── Contract ────────────────────────────────────────────────────────────────
 * Best-effort: it never throws, and a venue that saved but failed to geocode
 * must never fail the tool call that created it. The 08:30 nightly sweep
 * (`missing_only`) is the retry.
 *
 * Best-effort is NOT the same as silent. Until 2026-10-04 this returned void
 * and discarded the gate's answer, so a refusal never reached the caller.
 * Specimen (OPE-408, 10-01): `create_venue` made "Hilton Garden Inn Freeport
 * Downtown" (`dd7c30cb`); the gate refused it (`low-confidence`, "2
 * candidates", with the CORRECT address as the candidate); the same session
 * created and approved an event there 20 seconds later; and the next day seven
 * on-site photos matched nothing. The nightly sweep cannot fix a refusal — it
 * gets the same answer every night. So the verdict is now RETURNED, for the
 * caller to show, and a refusal is RECORDED (`recordNewVenueGeocodeRefusal`).
 */

import { mainAppBindingRequest } from "../main-app-fetch.js";
import type { Db } from "../db.js";
import { adminActions } from "../schema.js";

export interface GeocodeNewVenueEnv {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

/**
 * What happened to a just-created venue's pin. `pinned` is the one bit a caller
 * acts on; the rest says why and what to do about it.
 *
 * `status` is the gate's own vocabulary (`ok`, `low-confidence`, `no-match`,
 * `not-a-point`, `insufficient-address`, `duplicate-with`, …) or `unavailable`
 * when the gate could not be asked at all (unconfigured, network, non-JSON).
 */
export interface NewVenueGeocodeVerdict {
  pinned: boolean;
  status: string;
  /** Why it is not pinned, in the gate's words; null when pinned. */
  reason: string | null;
  /** Google's top hit, so a reviewer can confirm a low-confidence match and
   *  re-run `venues_geocode` with `force` — the `dd7c30cb` candidate was right. */
  candidate: string | null;
}

interface GateResultRow {
  status?: string;
  error?: string;
  candidate?: string;
  after?: { lat?: number | null; lng?: number | null };
  duplicate?: { venue_id?: string; name?: string };
}

/** Pure: read the gate endpoint's JSON body into a verdict. Exported for tests. */
export function verdictFromGateBody(body: unknown): NewVenueGeocodeVerdict {
  const row = (body as { results?: GateResultRow[] } | null)?.results?.[0];
  if (!row || typeof row.status !== "string") {
    return {
      pinned: false,
      status: "unavailable",
      reason: "geocode gate returned no result",
      candidate: null,
    };
  }
  const pinned = row.after?.lat != null && row.after?.lng != null;
  const reason = pinned
    ? null
    : (row.error ??
      (row.status === "duplicate-with" && row.duplicate?.name
        ? `same Google place as venue "${row.duplicate.name}" (${row.duplicate.venue_id}) — a merge_venue candidate`
        : row.status));
  return { pinned, status: row.status, reason, candidate: row.candidate ?? null };
}

export async function geocodeNewVenueViaMainApp(
  env: GeocodeNewVenueEnv | undefined,
  venueId: string
): Promise<NewVenueGeocodeVerdict> {
  // Unconfigured (local dev, tests) is a normal state, not an error: the sweep
  // covers the row either way.
  if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
    return {
      pinned: false,
      status: "unavailable",
      reason: "geocode gate not configured",
      candidate: null,
    };
  }

  try {
    const url = `${env.MAIN_APP_URL}/api/admin/venues/geocode-venues`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.INTERNAL_API_KEY,
      },
      // `force` stays false: a low-confidence answer must still refuse to
      // write, exactly as it does everywhere else. Google's fallback for a
      // miss is a city centroid, which inside the photo matcher's 1.5-mile
      // radius is worse than a blank.
      body: JSON.stringify({ venue_id: venueId, force: false }),
    };
    // Prefer the service binding (no public hop); fall back to fetch, the same
    // order `venues_geocode` and `main-app-fetch.ts` use.
    const res = env.MAIN_APP
      ? await env.MAIN_APP.fetch(mainAppBindingRequest(url, init))
      : await fetch(url, init);
    if (!res.ok) {
      return {
        pinned: false,
        status: "unavailable",
        reason: `geocode gate HTTP ${res.status}`,
        candidate: null,
      };
    }
    return verdictFromGateBody(await res.json());
  } catch (e) {
    // See the contract above. The nightly sweep is the retry.
    return {
      pinned: false,
      status: "unavailable",
      reason: e instanceof Error ? e.message : "geocode gate unreachable",
      candidate: null,
    };
  }
}

/**
 * Record that a just-created venue came out WITHOUT a pin, and why. One row per
 * creation, never per sweep night (the sweep re-asks nightly; a row per night
 * would be ~40 rows of the same answer). Never throws: an audit row must not
 * fail the creation it describes.
 */
export async function recordNewVenueGeocodeRefusal(
  db: Db,
  venueId: string,
  verdict: NewVenueGeocodeVerdict,
  source: string,
  actorUserId: string | null = null
): Promise<void> {
  if (verdict.pinned) return;
  try {
    await db.insert(adminActions).values({
      action: "venue.geocode.refused",
      actorUserId,
      targetType: "venue",
      targetId: venueId,
      payloadJson: JSON.stringify({
        status: verdict.status,
        reason: verdict.reason,
        candidate: verdict.candidate,
        source,
      }),
      createdAt: new Date(),
    });
  } catch {
    // Contract: never fail the creation over its own audit row.
  }
}
