/**
 * OPE-686 — the maintenance half of the gallery MCP surface.
 *
 * OPE-211/212 shipped `upload_image_bytes`, `request_image_upload_slot` and
 * friends: an agent could ADD a photo and could not fix one. On 2026-08-31 a
 * duplicate upload and a photo stored 90° off on `phillips-old-home-days-2026`
 * cost a whole browser session and still needed a human to click a native
 * `window.confirm`.
 *
 * These tools do not reimplement anything. They call
 * `POST /api/internal/gallery-photo`, which runs the SAME functions the admin
 * UI's session routes run. The public photo routes authenticate with a session
 * an MCP tool cannot hold, and giving this Worker its own copy of
 * delete/rotate/feature is exactly the "one fix, two artifacts" defect this
 * codebase keeps rediscovering.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

interface Env extends MainAppEnv {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

async function callGallery(env: Env | undefined, body: Record<string, unknown>) {
  if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
    return {
      ok: false as const,
      payload: {
        error: "config",
        message: "Requires MAIN_APP_URL and INTERNAL_API_KEY in the MCP server environment.",
      },
    };
  }
  let response: Response;
  try {
    response = await mainAppFetch(env, "/api/internal/gallery-photo", "fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false as const,
      payload: {
        error: "fetch_failed",
        message: `Failed to reach main app: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return { ok: false as const, payload: { error: "http", status: response.status, ...data } };
  }
  return { ok: true as const, data };
}

export function registerGalleryPhotoTools(server: McpServer, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  const target = z.enum(["event", "vendor"]).describe("Which gallery the photo belongs to.");

  server.tool(
    "delete_gallery_photo",
    [
      "OPE-686 — remove one photo from an event or vendor gallery.",
      "",
      "SOFT delete: the row is tombstoned, not destroyed, and the R2 object stays,",
      "so an over-eager cleanup is reversible. Deleting the gallery's featured",
      "photo promotes the next one rather than leaving it headless.",
      "",
      "Idempotent — deleting an already-deleted photo returns the current gallery",
      "rather than an error, so a retried call converges.",
      "Returns the remaining gallery, in order, so you can verify without a re-read.",
      "Writes an admin_actions row. Admin only.",
    ].join("\n"),
    { target_type: target, photo_id: z.string().min(1) },
    async ({ target_type, photo_id }) => {
      const res = await callGallery(env, {
        target_type,
        photo_id,
        action: "delete",
        actor: auth.userId ?? undefined,
      });
      return { content: [jsonContent(res.ok ? res.data : res.payload)] };
    }
  );

  server.tool(
    "rotate_gallery_photo",
    [
      "OPE-686 — turn a sideways gallery photo upright.",
      "",
      "`degrees` is a RELATIVE clockwise turn (90 / 180 / 270, or a negative to",
      "turn back), because that is what you can see: a photo lying on its side",
      "that needs a quarter turn. An absolute angle would make every caller read",
      "the current value first, and the one that forgets un-rotates a photo",
      "somebody already fixed.",
      "",
      "The stored object is NOT re-encoded — rotation is applied at render time",
      "through cdn-cgi/image. So photo_id, sort_order, is_featured and the caption",
      "survive by construction, the master never degrades, and rotating back is",
      "lossless. Admin only.",
    ].join("\n"),
    {
      target_type: target,
      photo_id: z.string().min(1),
      degrees: z
        .number()
        .int()
        .refine((n) => Math.abs(n) % 90 === 0, "degrees must be a multiple of 90"),
    },
    async ({ target_type, photo_id, degrees }) => {
      const res = await callGallery(env, {
        target_type,
        photo_id,
        action: "rotate",
        degrees,
        actor: auth.userId ?? undefined,
      });
      return { content: [jsonContent(res.ok ? res.data : res.payload)] };
    }
  );

  server.tool(
    "update_gallery_photo",
    [
      "OPE-686 — caption, alt text, feature and order for one gallery photo.",
      "",
      "Covers the star, arrow and text controls the admin UI already exposes.",
      "`is_featured: true` demotes the others — featured is exclusive per owner,",
      "enforced server-side so two concurrent promotions cannot both stick.",
      "`sort_order` is the absolute position; read the gallery first if you are",
      "moving one photo relative to another.",
      "A deleted photo is refused (410) rather than silently edited. Admin only.",
    ].join("\n"),
    {
      target_type: target,
      photo_id: z.string().min(1),
      caption: z.string().max(300).nullish(),
      alt_text: z.string().max(300).nullish(),
      is_featured: z.boolean().optional(),
      sort_order: z.number().int().min(0).max(9999).optional(),
    },
    async ({ target_type, photo_id, caption, alt_text, is_featured, sort_order }) => {
      const res = await callGallery(env, {
        target_type,
        photo_id,
        action: "update",
        ...(caption !== undefined ? { caption } : {}),
        ...(alt_text !== undefined ? { alt_text } : {}),
        ...(is_featured !== undefined ? { is_featured } : {}),
        ...(sort_order !== undefined ? { sort_order } : {}),
        actor: auth.userId ?? undefined,
      });
      return { content: [jsonContent(res.ok ? res.data : res.payload)] };
    }
  );

  server.tool(
    "list_gallery_photos",
    [
      "OPE-686 — the live gallery for the owner of `photo_id`, in display order.",
      "",
      "Keyed off a photo rather than the owner because that is what you have after",
      "an upload, and it saves a lookup. Tombstones are excluded.",
      "Admin only.",
    ].join("\n"),
    { target_type: target, photo_id: z.string().min(1) },
    async ({ target_type, photo_id }) => {
      const res = await callGallery(env, { target_type, photo_id, action: "read" });
      return { content: [jsonContent(res.ok ? res.data : res.payload)] };
    }
  );
}
