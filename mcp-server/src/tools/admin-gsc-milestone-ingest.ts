/**
 * `ingest_gsc_milestone_email` admin MCP tool (OPE-108).
 *
 * Parses a Google Search Console "click milestone" congrats email (sender
 * sc-noreply@google.com, subject "Congrats on reaching {N}K clicks in 28 days!")
 * and upserts a `gsc_milestone_emails` row, so the admin "Search clicks
 * milestones" chart stays current without hand-entered SQL. Idempotent — dedupes
 * on (metric, window_days, threshold).
 *
 * OPE-1568 — it ALSO ingests Google's monthly "Your <Month> Search performance"
 * report into the OPE-344 external oracle (`gsc_monthly_oracle`). The endpoint
 * has parsed both shapes since OPE-344, but this tool's description and its
 * success payload only spoke milestones: an analyst lane read the description,
 * concluded it could not clear the red `gsc-monthly-oracle` heartbeat, and the
 * September 2026 report sat in Gmail for four weeks. The success payload now
 * passes the monthly result (`kind`, `month`, `oracle`, `comparison`) through
 * instead of answering a bare `success: true` with every field undefined.
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
import { mainAppFetch } from "../main-app-fetch.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

type IngestResponse = {
  success: boolean;
  /** "monthly_oracle" for a monthly report; absent for a milestone. */
  kind?: string;
  month?: string;
  oracle?: Record<string, unknown>;
  comparison?: Record<string, unknown>;
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
    "Ingest an email from Google Search Console (sc-noreply@google.com). Two shapes are accepted: (1) a 'click milestone' congrats email ('Congrats on reaching 3K clicks in 28 days!') → milestones chart, idempotent on metric+window+threshold; (2) the MONTHLY report ('Your September Search performance for meetmeatthefair.com') → the OPE-344 external oracle that keeps the `gsc-monthly-oracle` heartbeat green, upserted per month and compared against our own GSC ingest (alarm at >10% divergence). For a monthly report the BODY IS REQUIRED: paste the plaintext body from the top through at least 'Your content achievements'. Pass the email's received date. K and M shorthand are both parsed. The response says `kind: 'monthly_oracle'` with the month and comparison, or carries a `milestone`. Admin only.",
    {
      subject: z
        .string()
        .describe(
          "The email subject, e.g. 'Congrats on reaching 3K clicks in 28 days!' or 'Your September Search performance for meetmeatthefair.com'."
        ),
      body: z
        .string()
        .optional()
        .describe(
          "Email body (plaintext). Optional for a milestone (used for the 'reached' date, e.g. 'Jul 4, 2026'); REQUIRED for a monthly report, which carries its figures only in the body."
        ),
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

      // OPE-258 service binding, NOT a raw fetch to the public hostname.
      // Measured 2026-08-09: the raw path 404s from this Worker even though the
      // route answers 401 (i.e. exists) from outside — a Worker subrequest to
      // its own zone's apex does not reach the main-app Worker. The binding
      // bypasses zone routing entirely.
      let response: Response;
      try {
        response = await mainAppFetch(env, "/api/admin/analytics/gsc-milestone-ingest", "fetch", {
          method: "POST",
          headers: {
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
          jsonContent(
            parsed.kind === "monthly_oracle"
              ? {
                  success: true,
                  kind: parsed.kind,
                  month: parsed.month,
                  oracle: parsed.oracle,
                  comparison: parsed.comparison,
                }
              : {
                  success: true,
                  inserted: parsed.inserted,
                  milestone: parsed.milestone,
                  note: parsed.note,
                }
          ),
        ],
      };
    }
  );
}
