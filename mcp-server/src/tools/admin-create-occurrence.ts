/**
 * EH3 P3.1 — `create_occurrence` MCP tool. Thin X-Internal-Key wrapper over the
 * main-app POST /api/admin/occurrences/create (which owns the insert + series-
 * default inheritance + year-bucketed idempotency + audit). Mirrors the
 * merge_events / backfill_event_series wrapper pattern.
 *
 * Creates a new dated occurrence UNDER a series, never mutating a past one.
 * Skeleton posture (TENTATIVE, dates only if passed). Year is required and is
 * the idempotency key — a second call for the same (series, year) is a no-op.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

export function registerCreateOccurrenceTool(server: McpServer, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "create_occurrence",
    [
      "Create a new dated occurrence (one year's edition) UNDER an event series,",
      "never mutating a past occurrence. Inherits venue/promoter/description/image/",
      "categories/audience from the series; pass overrides to change them. Year is",
      "required and is the idempotency key — calling twice for the same (series, year)",
      "is a no-op (returns created:false, reason:occurrence_exists). The occurrence is",
      "created TENTATIVE + flagged for review; dates are only set if you pass them",
      "(otherwise an operator fills them in later).",
      "EDITIONS (OPE-1327): on a MULTI-EDITION series (edition_mode='multi', e.g. one",
      "that runs in May AND October), the idempotency key is the EDITION, not the year:",
      "edition_key = YYYY-MM of start_date in the venue's time zone (derived when you",
      "pass start_date), or pass edition_key yourself — with a lowercase suffix for a",
      "same-month clash, e.g. 2027-05-xli. Two editions of one year are two",
      "occurrences. A multi-edition call with neither edition_key nor start_date",
      "returns edition_key_required. On an annual series edition_key is ignored.",
    ].join(" "),
    {
      series_id: z.string().min(1).describe("event_series id to create the occurrence under."),
      year: z.number().int().describe("Edition year (idempotency key)."),
      name: z.string().optional().describe("Override the series name for this edition."),
      venue_id: z.string().optional().describe("Override the series default venue."),
      promoter_id: z
        .string()
        .optional()
        .describe("Override/supply the promoter (required if the series has no default)."),
      start_date: z.string().optional().describe("YYYY-MM-DD; omit for a dates-TBD skeleton."),
      end_date: z.string().optional().describe("YYYY-MM-DD."),
      description: z.string().optional(),
      image_url: z.string().optional(),
      rolled_from_event_id: z
        .string()
        .optional()
        .describe("Provenance: the source occurrence this was rolled from (K27)."),
      edition_key: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])(-[a-z0-9]+)*$/)
        .optional()
        .describe(
          "Multi-edition series only: the edition's URL key, YYYY-MM[-suffix]. Omit to derive it from start_date."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [{ type: "text", text: "MAIN_APP_URL or INTERNAL_API_KEY not configured." }],
          isError: true,
        };
      }
      const res = await fetch(`${env.MAIN_APP_URL}/api/admin/occurrences/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": env.INTERNAL_API_KEY },
        body: JSON.stringify(params),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data) {
        const err =
          (data?.error as string | undefined) ?? `create_occurrence failed: HTTP ${res.status}`;
        return { content: [{ type: "text", text: err }], isError: true };
      }
      return { content: [jsonContent(data)] };
    }
  );
}
