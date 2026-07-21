/**
 * OPE-259 — `cpi_fileable_signals` + `cpi_record_filing`.
 *
 * The OPE-76 auto-file rail was deliberately built in two halves: the Worker
 * does reconcile/dedup/rate-cap (`POST /api/internal/cpi/fileable-signals`,
 * `POST /api/internal/cpi/record-filing`), and "a scheduled agent run does the
 * actual filing", because a Worker cannot call Linear.
 *
 * **That companion half was never stood up.** `cpi_signal_filings` was empty —
 * zero rows, ever — from ship until 2026-07-20. Every heartbeat probe and every
 * other fileable signal was being injected, correctly, into a rail nobody
 * drained. And no agent COULD drain it: both routes require `X-Internal-Key`,
 * and the MCP server exposed no tool for either. The auto-file rail was itself
 * an instance of the shipped-but-never-executed class it exists to catch.
 *
 * These two tools are that missing half. They are deliberately thin — all
 * reconcile, dedup and rate-cap logic stays in `src/lib/cpi/auto-file.ts` so
 * there is one implementation, not an agent-side reimplementation that drifts.
 *
 * Entrypoint note (OPE-258): MCP→main-app internal POSTs 401 from the LEGACY
 * `mmatf_` fetch-handler path but succeed from the OAuth Durable Object path
 * that claude.ai tool calls use. These tools are for the analyst's scheduled
 * runs, which use the OAuth path, so they work today; if a call ever returns
 * `unauthorized`, that is OPE-258 and not a bad key.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

/** POST an internal CPI route, returning a structured result rather than throwing. */
async function postInternal(
  env: Env,
  path: string,
  body?: unknown
): Promise<{ ok: true; data: unknown } | { ok: false; payload: Record<string, unknown> }> {
  if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
    return {
      ok: false,
      payload: {
        error: "config",
        message: "Requires MAIN_APP_URL and INTERNAL_API_KEY in the MCP server environment.",
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(`${env.MAIN_APP_URL}${path}`, {
      method: "POST",
      headers: {
        "X-Internal-Key": env.INTERNAL_API_KEY,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    return {
      ok: false,
      payload: {
        error: "fetch_failed",
        message: `Failed to reach main app: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      payload: {
        error: "bad_response",
        status: response.status,
        message: `Main app returned non-JSON: ${text.slice(0, 200)}`,
      },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      payload: {
        error: response.status === 401 ? "unauthorized" : "http_error",
        status: response.status,
        // Name the known cause so the next reader doesn't re-diagnose it.
        ...(response.status === 401
          ? { hint: "See OPE-258 — internal POSTs 401 from the legacy mmatf_ fetch path." }
          : {}),
        body: parsed,
      },
    };
  }

  return { ok: true, data: parsed };
}

export function registerCpiAutoFileTools(server: McpServer, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "cpi_fileable_signals",
    [
      "OPE-76/OPE-259 — read + reconcile the CPI auto-file rail. Rebuilds the §6.3 action",
      "queue, keeps the fileable signals (P0 always; P1 aged past the 72h stale threshold),",
      "reconciles them against the cpi_signal_filings ledger, and returns four buckets:",
      "`toFile` (propose an OPE now), `existing` (already filed — do NOT file again),",
      "`resolved` (signal cleared; ledger row closed), `deferred` (held back by the",
      "per-run rate cap, default 5). Each signal carries fingerprint, priority, title,",
      "href, firstDetectedAt and agentCode.",
      "",
      "CALLING THIS IS A WRITE: it upserts ledger rows (proposes/bumps/resolves) as a",
      "side effect, which is what makes dedup work across runs.",
      "",
      "Workflow: call this → for each `toFile` entry create a Linear issue titled",
      "`[agent instructions][<agentCode>][task] …` with `cpi-sig:<fingerprint>` in the",
      "body → then call `cpi_record_filing` with that fingerprint + the OPE id. Skipping",
      "record_filing means the signal is re-proposed on the next run. Admin only.",
    ].join(" "),
    {},
    async () => {
      const res = await postInternal(env ?? {}, "/api/internal/cpi/fileable-signals");
      return res.ok
        ? { content: [jsonContent(res.data)] }
        : { content: [jsonContent(res.payload)], isError: true };
    }
  );

  server.tool(
    "cpi_record_filing",
    [
      "OPE-76/OPE-259 — write back that a CPI signal has been filed as an OPE. Call this",
      "immediately after creating the Linear issue for a `toFile` entry from",
      "`cpi_fileable_signals`, passing that entry's `fingerprint` and the new issue id",
      "(e.g. 'OPE-263').",
      "",
      "Idempotent and safe: only a row that exists AND is currently 'proposed' is",
      "transitioned, so this cannot resurrect a resolved signal or clobber an",
      "already-filed one. `updated: 0` means there was nothing in 'proposed' state for",
      "that fingerprint — usually a double-call, not an error.",
      "",
      "Omitting this step is the failure that matters: the signal stays 'proposed' and",
      "gets re-proposed on the next reconcile, producing duplicate OPEs. Admin only.",
    ].join(" "),
    {
      fingerprint: z
        .string()
        .min(1)
        .max(256)
        .describe("The signal's `fingerprint` exactly as returned by cpi_fileable_signals."),
      ope_id: z
        .string()
        .min(1)
        .max(64)
        .describe("The Linear issue id just created, e.g. 'OPE-263'."),
    },
    async ({ fingerprint, ope_id }) => {
      const res = await postInternal(env ?? {}, "/api/internal/cpi/record-filing", {
        fingerprint,
        opeId: ope_id,
      });
      return res.ok
        ? { content: [jsonContent(res.data)] }
        : { content: [jsonContent(res.payload)], isError: true };
    }
  );
}
