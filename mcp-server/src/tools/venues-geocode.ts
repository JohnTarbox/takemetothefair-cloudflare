/**
 * OPE-207 — `venues_geocode`: fill venues.latitude/longitude/google_place_id
 * from a venue's stored address, or (OPE-213) from a name+city+state Places
 * text search when it has no address — which back-fills the address too.
 *
 * Thin proxy to `POST /api/admin/venues/geocode-venues` on the main app. The
 * Google Places client lives in `src/lib/google-maps.ts` and the MCP Worker is
 * a separate build with no path into `src/`, so the tool crosses over
 * X-Internal-Key — same shape as `request_image_upload_slot`.
 *
 * WHY THIS EXISTS: OPE-206's audit found 233/908 venues (26%) with no
 * coordinates. The analyst can spot the gaps and set coords one-by-one via
 * `update_venue`, but had no way to geocode from an address. This closes that,
 * and it matters beyond tidiness: OPE-203 attributes on-site photos to a fair
 * by finding venues within 1.5 miles of the photo's GPS, so an ungeocoded venue
 * can NEVER match a photo — coverage here is the ceiling on that feature.
 *
 * Non-destructive: existing coordinates are never silently overwritten, and
 * low-confidence answers are reported, not written — Google's fallback for a
 * miss is a city centroid, which inside a 1.5-mile radius is worse than a
 * blank. `force: true` opts out of both (OPE-215), storing a reviewed candidate
 * as `forced` with an `admin_actions` row.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

export function registerVenuesGeocodeTool(server: McpServer, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "venues_geocode",
    "Geocode venues, filling latitude/longitude/google_place_id/google_maps_url. Uses the venue's stored " +
      "street address when it has one; a venue with NO address but a name + city + state (Tanglewood, MASS " +
      "MoCA) is looked up BY NAME via a Places text search, which also back-fills the missing street " +
      "address. The outcome record reports which method produced the pin ('address' or 'name'). " +
      "Pass venue_id (single), venue_ids (batch, max 25), or missing_only:true to work through venues that " +
      "have no coordinates. Non-destructive: a venue that already has coords returns 'already-geocoded' and " +
      "is skipped unless force:true. A low-confidence match (multiple candidates, partial match, a " +
      "city-centroid 'APPROXIMATE' pin, or — on the name path — a hit whose city/state/name disagrees with " +
      "the row) is reported with its candidate address and NOT written — re-run with " +
      "force:true to store a candidate you have reviewed and believe is right: it returns status 'forced' " +
      "(keeping the reason the gate objected) and is logged to admin_actions. force only overrides the " +
      "confidence verdict — it never stores an 'insufficient-address' or 'no-match' venue, because there is " +
      "no candidate to store. Returns a per-venue outcome record. Admin only.",
    {
      venue_id: z.string().optional().describe("Geocode a single venue by id."),
      venue_ids: z
        .array(z.string())
        .optional()
        .describe("Geocode several venues by id (capped at 25 per call)."),
      missing_only: z
        .boolean()
        .optional()
        .describe("With no ids: work through venues that have no coordinates (capped at 25)."),
      limit: z
        .number()
        .min(1)
        .max(25)
        .optional()
        .describe("Max venues this call (default/cap 25 — each is one Google round-trip)."),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Override the safety defaults: re-geocode a venue that already has coordinates (overwriting " +
            "them), AND store a reviewed low-confidence candidate (reported as 'forced'). Never stores an " +
            "insufficient-address or no-match venue."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            jsonContent({
              error: "MAIN_APP_URL + INTERNAL_API_KEY must be configured on the MCP Worker.",
            }),
          ],
          isError: true,
        };
      }

      if (!params.venue_id && !params.venue_ids?.length && !params.missing_only) {
        return {
          content: [
            jsonContent({
              error: "Provide venue_id, venue_ids, or missing_only:true.",
            }),
          ],
          isError: true,
        };
      }

      let response: Response;
      try {
        const url = `${env.MAIN_APP_URL}/api/admin/venues/geocode-venues`;
        const init: RequestInit = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": env.INTERNAL_API_KEY,
          },
          body: JSON.stringify({
            venue_id: params.venue_id ?? undefined,
            venue_ids: params.venue_ids ?? undefined,
            missing_only: params.missing_only ?? undefined,
            limit: params.limit ?? undefined,
            force: params.force ?? false,
          }),
        };
        response = env.MAIN_APP
          ? await env.MAIN_APP.fetch(new Request(url, init))
          : await fetch(url, init);
      } catch (err) {
        return {
          content: [
            jsonContent({
              error: "main_app_fetch_failed",
              detail: err instanceof Error ? err.message : "unknown",
            }),
          ],
          isError: true,
        };
      }

      const text = await response.text();
      if (!response.ok) {
        return {
          content: [jsonContent({ error: "geocode_failed", status: response.status, body: text })],
          isError: true,
        };
      }

      try {
        return { content: [jsonContent(JSON.parse(text))] };
      } catch {
        return {
          content: [jsonContent({ error: "bad_response", body: text })],
          isError: true,
        };
      }
    }
  );
}
