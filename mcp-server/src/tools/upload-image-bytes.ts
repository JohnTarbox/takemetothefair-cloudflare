import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

// MAX_INPUT_BASE64_CHARS: ~7.5 MB of base64 ≈ ~10 MB decoded. Mirror the
// main-app endpoint's MAX_BYTES; reject early on the MCP side so callers
// get a clear error before paying for the multipart POST round-trip.
const MAX_INPUT_BASE64_CHARS = 10_000_000;

const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/svg+xml"] as const;

interface Env {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

/**
 * Decode a base64 string into a Uint8Array without relying on Node's
 * Buffer (Workers runtime). atob handles standard base64; we strip the
 * data-URL prefix if the caller wrapped the bytes that way.
 */
function decodeBase64(input: string): Uint8Array {
  const stripped = input.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function registerUploadImageBytesTool(server: McpServer, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "upload_image_bytes",
    [
      "Upload an image directly via base64-encoded bytes (no source URL needed).",
      "Closes the gap with upload_event_image, which requires a publicly-fetchable URL.",
      "Use this for photos taken in-person at events where the file only exists on a local device.",
      "",
      "Generic across target types: event / vendor / venue. The bytes land in R2 at the",
      "appropriate prefix (events/, vendors/, venues/) and the target row's image column",
      "(events.image_url, vendors.logo_url, venues.image_url) updates to the CDN URL.",
      "",
      "Pipeline (analyst 2026-05-22 P5a, Phases 2a + 2b):",
      "  • Phase 2a: EXIF/XMP/IPTC stripped from JPEGs before R2 put — guarantees no GPS coordinates from phone photos hit the public CDN.",
      "  • Phase 2b: auto-orient (EXIF Orientation applied to pixels) + resize to 2000px longest edge + re-encode to WebP q85 via Cloudflare Image Resizing. Skipped for SVG and inputs < 50KB.",
      "Response includes `phase2b.status` ('applied' | 'skipped' | 'fallback'), `width`, `height`, `compression_ratio`, and `bytes_removed_by_exif_strip` so callers can observe each pipeline stage. `fallback` means the cf.image transform failed (zone not enabled, timeout, etc.) and the Phase-2a-stripped original was kept — worst case is identical to Phase-2a-only behavior.",
    ].join(" "),
    {
      image_base64: z
        .string()
        .min(100)
        .max(MAX_INPUT_BASE64_CHARS)
        .describe(
          "Base64-encoded image bytes. Data-URL prefix (e.g. 'data:image/jpeg;base64,') is stripped automatically. Decoded byte cap: 10MB. Larger inputs get a 413."
        ),
      content_type: z
        .enum(ALLOWED_CONTENT_TYPES)
        .describe(
          "MIME type of the image. Server verifies magic bytes match — a misdeclared SVG-as-JPEG is rejected."
        ),
      target_type: z
        .enum(["event", "vendor", "venue", "promoter"])
        .describe(
          "Which table to update. Determines the R2 key prefix + which column gets the URL."
        ),
      target_id: z.string().min(1).describe("UUID of the target row."),
      image_role: z
        .enum(["logo", "hero"])
        .optional()
        .describe(
          "Only for target_type 'promoter': 'logo' (default, small square avatar) or 'hero' (full-bleed banner). Ignored for other targets."
        ),
      caption: z
        .string()
        .max(200)
        .optional()
        .describe("Optional human-readable caption stored in R2 customMetadata for debugging."),
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

      // Decode early so we can fail fast on garbage input.
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(params.image_base64);
      } catch (err) {
        return {
          content: [
            jsonContent({
              error: "base64_decode_failed",
              detail: err instanceof Error ? err.message : "unknown",
            }),
          ],
          isError: true,
        };
      }

      if (bytes.length === 0) {
        return {
          content: [jsonContent({ error: "decoded_to_empty_bytes" })],
          isError: true,
        };
      }
      if (bytes.length > 10 * 1024 * 1024) {
        return {
          content: [
            jsonContent({
              error: "input_too_large",
              decoded_bytes: bytes.length,
              max_bytes: 10 * 1024 * 1024,
            }),
          ],
          isError: true,
        };
      }

      // Build the multipart body. The main-app endpoint reads
      // formData.get("file") + target_type/target_id/caption fields.
      const blob = new Blob([bytes], { type: params.content_type });
      const filename = params.caption ? params.caption.slice(0, 60) : "upload";
      const formData = new FormData();
      formData.append("file", blob, filename);
      formData.append("target_type", params.target_type);
      formData.append("target_id", params.target_id);
      if (params.image_role) formData.append("image_role", params.image_role);
      if (params.caption) formData.append("caption", params.caption);

      let response: Response;
      try {
        const url = `${env.MAIN_APP_URL}/api/admin/upload-image-bytes`;
        const init: RequestInit = {
          method: "POST",
          headers: { "X-Internal-Key": env.INTERNAL_API_KEY },
          body: formData,
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
              error: "upload_failed",
              status: response.status,
              detail: result,
            }),
          ],
          isError: true,
        };
      }

      return {
        content: [jsonContent(result)],
      };
    }
  );
}
