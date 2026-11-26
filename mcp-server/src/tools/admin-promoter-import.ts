/**
 * OPE-1618 — `import_promoter_spreadsheet`: the operator path for a promoter who
 * EMAILS us a season spreadsheet (submit@). It runs the very same import the
 * promoter portal runs (main app, /api/admin/promoters/<id>/import), recorded
 * with channel `operator`:
 *   - source: an inbound email's attachment (inbound_email_id + attachment_index,
 *     read through the authenticated attachment route), or file_base64;
 *   - action `preview` (the default) writes nothing and returns every row as
 *     new / match / already_imported / error;
 *   - action `commit` commits the listed rows (≤ 25 per call): new rows become
 *     PENDING events (review), matches are STAGED on the event for review.
 * Sends nothing. Admin only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";
import type { AuthContext } from "../auth.js";

const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function registerPromoterImportTool(server: McpServer, auth: AuthContext, env?: MainAppEnv) {
  if (auth.role !== "ADMIN") return;
  server.tool(
    "import_promoter_spreadsheet",
    "OPE-1618 — import a promoter's season spreadsheet (CSV or XLSX, the portal template's columns) on their behalf — e.g. one they emailed to submit@. Give EITHER inbound_email_id (+ attachment_index from get_inbound_email's attachment_refs) OR file_base64. action 'preview' (default) writes nothing: each row comes back as new / match (the promoter's own event, with the fields it would change) / already_imported / error. action 'commit' commits the listed rows (max 25 per call; loop for more): new rows become PENDING events for review, every value cited to the upload (provenance promoter_portal); a match writes nothing to the event — its changes are staged with a promoter_import_update review flag. Re-committing the same file is a no-op. Preview pages 50 rows at a time (offset). Sends nothing. Admin only.",
    {
      promoter_id: z.string().min(1),
      inbound_email_id: z.string().min(1).optional(),
      attachment_index: z.number().int().min(0).default(0),
      file_base64: z.string().min(1).optional(),
      file_name: z.string().max(200).optional(),
      action: z.enum(["preview", "commit"]).default("preview"),
      offset: z.number().int().min(0).default(0),
      rows: z.array(z.number().int().min(2)).max(25).optional(),
    },
    async (p) => {
      if (!env?.INTERNAL_API_KEY && !env?.MAIN_APP)
        return err("unconfigured: no MAIN_APP binding or INTERNAL_API_KEY");
      if (!!p.inbound_email_id === !!p.file_base64)
        return err("give exactly one of inbound_email_id or file_base64");
      if (p.action === "commit" && !p.rows?.length)
        return err("commit needs rows (row numbers from the preview)");
      let fileBase64 = p.file_base64 ?? "";
      let fileName = p.file_name ?? null;
      if (p.inbound_email_id) {
        const res = await mainAppFetch(
          env,
          `/api/admin/inbound-emails/${encodeURIComponent(p.inbound_email_id)}/attachments/${p.attachment_index}`,
          "fetch"
        );
        if (!res.ok) return err(`could not read the attachment: HTTP ${res.status}`);
        fileBase64 = toBase64(new Uint8Array(await res.arrayBuffer()));
        const disposition = res.headers.get("content-disposition") ?? "";
        fileName =
          fileName ?? disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? null;
      }
      const res = await mainAppFetch(
        env,
        `/api/admin/promoters/${encodeURIComponent(p.promoter_id)}/import`,
        "fetch",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file_base64: fileBase64,
            file_name: fileName,
            action: p.action,
            offset: p.offset,
            rows: p.rows ?? [],
            actorUserId: auth.userId ?? null,
          }),
        }
      );
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok && res.status !== 422)
        return err(`import failed: ${body?.error ?? `HTTP ${res.status}`}`);
      return {
        content: [
          jsonContent({
            source: p.inbound_email_id
              ? { inbound_email_id: p.inbound_email_id, attachment_index: p.attachment_index }
              : "file_base64",
            ...body,
          }),
        ],
      };
    }
  );
}
