/**
 * `ingest_gsc_milestone_email` admin MCP tool (OPE-108).
 *
 * Parses a Google Search Console "click milestone" congrats email (sender
 * sc-noreply@google.com, subject "Congrats on reaching {N}K clicks in 28 days!")
 * and upserts a `gsc_milestone_emails` row, so the admin "Search clicks
 * milestones" chart stays current without hand-entered SQL. Idempotent — dedupes
 * on (metric, window_days, threshold).
 *
 * Intended drain: an agent with inbox access (or John) reads the congrats email
 * and calls this with the subject/body/received-date; the server parses the
 * K-shorthand + dates and writes the row. Thin shell over the main app's
 * `/api/admin/analytics/gsc-milestone-ingest` endpoint (X-Internal-Key), keeping
 * D1 access in main-app code.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

type IngestResponse = {
  success: boolean;
  inserted?: boolean;
  milestone?: Record<string, unknown>;
  note?: string;
  error?: string;
  status?: number;
  message?: string;
};

export function registerGscMilestoneIngestTool(server: McpServer, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "ingest_gsc_milestone_email",
    "Record a Google Search Console 'click milestone' congrats email into the milestones chart. Paste the email's subject (e.g. 'Congrats on reaching 3K clicks in 28 days!'), optionally its body (for the reached date), and its received date. The server parses the K-shorthand + dates and upserts idempotently (dedupes on metric+window+threshold). Admin only.",
    {
      subject: z
        .string()
        .describe("The email subject, e.g. 'Congrats on reaching 3K clicks in 28 days!'."),
      body: z
        .string()
        .optional()
        .describe("Optional email body — used to extract the 'reached' date (e.g. 'Jul 4, 2026')."),
      email_date: z
        .string()
        .describe(
          "The email's received date. ISO (2026-07-06), 'Jul 6, 2026', or an RFC-2822 date."
        ),
      note: z.string().optional().describe("Optional free-text note stored on the row."),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            jsonContent({
              error: "config",
              message:
                "ingest_gsc_milestone_email requires MAIN_APP_URL and INTERNAL_API_KEY in the MCP server environment.",
            }),
          ],
          isError: true,
        };
      }

      const url = `${env.MAIN_APP_URL}/api/admin/analytics/gsc-milestone-ingest`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "X-Internal-Key": env.INTERNAL_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject: params.subject,
            body: params.body,
            email_date: params.email_date,
            note: params.note,
          }),
        });
      } catch (e) {
        return {
          content: [
            jsonContent({
              error: "fetch_failed",
              message: `Failed to reach main app: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ],
          isError: true,
        };
      }

      let parsed: IngestResponse;
      try {
        parsed = (await response.json()) as IngestResponse;
      } catch {
        return {
          content: [
            jsonContent({
              error: "bad_response",
              status: response.status,
              message: "Main app returned a non-JSON response.",
            }),
          ],
          isError: true,
        };
      }

      if (!parsed.success) {
        return {
          content: [
            jsonContent({
              error: parsed.error ?? "unknown",
              status: parsed.status ?? response.status,
              message: parsed.message ?? `HTTP ${response.status}`,
            }),
          ],
          isError: true,
        };
      }

      return {
        content: [
          jsonContent({
            success: true,
            inserted: parsed.inserted,
            milestone: parsed.milestone,
            note: parsed.note,
          }),
        ],
      };
    }
  );
}
