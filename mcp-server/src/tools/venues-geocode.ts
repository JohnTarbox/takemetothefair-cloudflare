/**
 * OPE-207 — `venues_geocode`: fill venues.latitude/longitude/google_place_id
 * from a venue's stored address.
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
 * Non-destructive: existing coordinates are never silently overwritten
 * (`force: true` opts in). Low-confidence answers are reported, not written —
 * Google's fallback for a miss is a city centroid, which inside a 1.5-mile
 * radius is worse than a blank.
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
    "Geocode venues from their stored address, filling latitude/longitude/google_place_id/google_maps_url. " +
      "Pass venue_id (single), venue_ids (batch, max 25), or missing_only:true to work through venues that " +
      "have no coordinates. Non-destructive: a venue that already has coords returns 'already-geocoded' and " +
      "is skipped unless force:true. A low-confidence match (multiple candidates, partial match, or a " +
      "city-centroid 'APPROXIMATE' pin) is reported with its candidate address and NOT written — re-run with " +
      "force:true if the candidate looks right. Returns a per-venue outcome record. Admin only.",
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
        .describe("Re-geocode venues that already have coordinates, overwriting them."),
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
