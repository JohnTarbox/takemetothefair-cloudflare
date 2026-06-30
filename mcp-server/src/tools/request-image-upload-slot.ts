/**
 * K17 (2026-06-07): MCP tool that mints a one-shot URL the caller can
 * POST image bytes to, sidestepping the ~500KB ceiling on base64-in-
 * tool-argument that upload_image_bytes hit in practice.
 *
 * The MCP server doesn't run the upload itself — it proxies a
 * /api/admin/upload-image-slot call to the main app (the same way
 * upload_image_bytes proxies /api/admin/upload-image-bytes) and surfaces
 * the slot URL + expiry back to the model. The bytes go directly from
 * the model's local environment to the main app over HTTPS, never
 * round-tripping through the MCP channel.
 *
 * Pairs with /api/admin/upload-image-direct/[token] — see
 * docs/mcp-k17-upload-slot.md for the full flow + smoke procedure.
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

export function registerRequestImageUploadSlotTool(
  server: McpServer,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "request_image_upload_slot",
    [
      "Request a one-shot URL for uploading an image directly via HTTPS, bypassing the base64-in-tool-argument size ceiling that upload_image_bytes hits in practice.",
      "Use this when you have a local image file (a photo on disk, a banner downloaded to /tmp, an image in a connected folder) and want to attach it to an event / vendor / venue without first hosting it on a public URL.",
      "Flow: (1) call this tool to get {upload_url, expires_at}; (2) POST the raw image bytes (or multipart with field 'file') to upload_url within 5 minutes; (3) the response shape matches upload_image_bytes (CDN URL, key, phase2b metadata).",
      "The URL is one-shot — consumed on the first successful POST. The slot fixes the target_type + target_id at mint time so a leaked URL can only ever upload to the row it was minted for.",
      "Admin only.",
    ].join(" "),
    {
      target_type: z
        .enum(["event", "vendor", "venue", "promoter"])
        .describe("Which table to update. The slot can only upload to this target."),
      target_id: z.string().min(1).describe("UUID of the target row. Verified at slot-mint time."),
      image_role: z
        .enum(["logo", "hero"])
        .optional()
        .describe(
          "Only for target_type 'promoter': which image to set — 'logo' (default, the small square avatar) or 'hero' (the full-bleed banner). Ignored for other targets."
        ),
      caption: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Optional human-readable caption stored in R2 customMetadata for debugging. Captured at mint time; the POST may override via a `caption` multipart field."
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

      let response: Response;
      try {
        const url = `${env.MAIN_APP_URL}/api/admin/upload-image-slot`;
        const init: RequestInit = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": env.INTERNAL_API_KEY,
          },
          body: JSON.stringify({
            target_type: params.target_type,
            target_id: params.target_id,
            image_role: params.image_role ?? null,
            caption: params.caption ?? null,
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

      const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        return {
          content: [
            jsonContent({
              error: "slot_mint_failed",
              status: response.status,
              detail: result,
            }),
          ],
          isError: true,
        };
      }

      return { content: [jsonContent(result)] };
    }
  );
}
