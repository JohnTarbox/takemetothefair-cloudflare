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
 * Best-effort and silent by construction. It returns void, never throws, and
 * the caller does not branch on it. A venue that saved but failed to geocode
 * must never fail the tool call that created it — and the 08:30 nightly sweep
 * (`missing_only`) is the retry, so nothing is lost by giving up here.
 */

export interface GeocodeNewVenueEnv {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

export async function geocodeNewVenueViaMainApp(
  env: GeocodeNewVenueEnv | undefined,
  venueId: string
): Promise<void> {
  // Unconfigured (local dev, tests) is a normal state, not an error: the sweep
  // covers the row either way.
  if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) return;

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
    if (env.MAIN_APP) {
      await env.MAIN_APP.fetch(new Request(url, init));
    } else {
      await fetch(url, init);
    }
  } catch {
    // See the contract above. The nightly sweep is the retry.
  }
}
