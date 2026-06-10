export const dynamic = "force-dynamic";
/**
 * UR1 C3 (2026-06-04) — POST handler for the web problem-report form.
 *
 * Mirrors the email path (`mcp-server/src/email-handlers/problem-report.ts`)
 * but writes directly to the main app's D1 since this is a same-Worker
 * write — going via the MCP Worker over HTTP would add a 100ms+ hop
 * for a one-row insert.
 *
 * D — UR1 Phase 2 (Dev backlog 2026-06-05): after the local insert, fires
 * a fire-and-forget HTTP correlation call to mcp-server's
 * `/api/admin/internal/correlate-problem-report` endpoint. Pre-D, the web
 * form left severity=LOW and waited for the operator to manually re-run
 * the `correlate_problem_report` MCP tool. Post-D, the at-intake call
 * turns "user reports broken page during outage" into a real-time HIGH
 * alert routed through B3 within ~10s of submit. The call has a 5s
 * timeout and fails open — if mcp-server is unreachable, the report still
 * lands (severity=LOW) and the operator path still works as the
 * backstop. The HIGH-severity path remains fully wired via email
 * submissions; D closes the corresponding gap on the web form.
 *
 * Anti-spam:
 *   - Honeypot `website` field — must be empty.
 *   - Per-IP rate-limit via RATE_LIMIT_KV: max 5 reports per minute.
 *   - Required body field with min length.
 */

import { NextResponse } from "next/server";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { problemReports } from "@/lib/db/schema";
import { logError } from "@/lib/logger";

const SOURCE = "app/api/report-problem/route.ts:POST";
const MAX_BODY_CHARS = 5000;
const MIN_BODY_CHARS = 5;
const RATE_LIMIT_MAX = 5; // reports per IP per window
const RATE_LIMIT_WINDOW_SEC = 60;

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    await logError(getCloudflareDb(), {
      message: "Failed to parse report-problem form",
      error: e,
      source: SOURCE,
    });
    return badRequest("Could not parse form data.");
  }

  // Honeypot
  const honeypot = (form.get("website") as string | null)?.trim() ?? "";
  if (honeypot.length > 0) {
    // Silently accept (don't tip off the bot) but write nothing.
    return NextResponse.redirect(new URL("/report-problem/thanks", req.url), 303);
  }

  const body = ((form.get("body") as string | null) ?? "").trim();
  if (body.length < MIN_BODY_CHARS) {
    return badRequest("Please describe what's wrong (at least a few words).");
  }
  if (body.length > MAX_BODY_CHARS) {
    return badRequest(`Report is too long (max ${MAX_BODY_CHARS} characters).`);
  }

  const reporterEmailRaw = ((form.get("reporter_email") as string | null) ?? "").trim();
  const reporterEmail = reporterEmailRaw.length > 0 ? reporterEmailRaw.slice(0, 254) : null;
  const path = ((form.get("path") as string | null) ?? "").trim().slice(0, 500) || null;
  const sourceTag = ((form.get("source_tag") as string | null) ?? "footer").slice(0, 40);
  const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;

  // Rate-limit by IP — CF sets `cf-connecting-ip`.
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  const env = getCloudflareEnv();
  if (env.RATE_LIMIT_KV) {
    const key = `problem-report:${ip}`;
    try {
      const current = parseInt((await env.RATE_LIMIT_KV.get(key)) ?? "0", 10);
      if (current >= RATE_LIMIT_MAX) {
        return new Response("Rate limit exceeded. Please try again in a minute.", {
          status: 429,
        });
      }
      await env.RATE_LIMIT_KV.put(key, String(current + 1), {
        expirationTtl: RATE_LIMIT_WINDOW_SEC,
      });
    } catch {
      // RATE_LIMIT_KV outage → fail-open (still accept the report).
    }
  }

  // Insert. Severity defaults to LOW. D (Dev backlog 2026-06-05) wires
  // an at-intake correlation call below; pre-D, severity could only be
  // bumped by an operator running the correlate_problem_report MCP tool.
  const db = getCloudflareDb();
  const id = crypto.randomUUID();
  try {
    await db.insert(problemReports).values({
      id,
      reporterEmail,
      body: body + (sourceTag !== "footer" ? `\n\n[source: ${sourceTag}]` : ""),
      source: "web",
      path,
      userAgent,
      inboundEmailId: null,
      severity: "LOW",
      correlatedErrorCount: 0,
      createdAt: new Date(),
    });
  } catch (e) {
    await logError(db, {
      message: "Failed to insert problem_reports row",
      error: e,
      source: SOURCE,
      context: { id, sourceTag, hasEmail: reporterEmail !== null, path },
    });
    return new Response(
      "Sorry, we couldn't save your report. Please try again or email report@meetmeatthefair.com.",
      { status: 500 }
    );
  }

  // D — Phase 2: fire-and-forget burst-watch correlation against
  // mcp-server. Fails open on any error (timeout, 5xx, network) — the
  // operator's correlate_problem_report MCP tool remains the backstop.
  // We don't await this; the user's redirect should not block on
  // mcp-server availability.
  triggerCorrelation(id).catch(async (e) => {
    await logError(db, {
      level: "warn",
      message: "triggerCorrelation threw",
      error: e,
      source: SOURCE,
      context: { id },
    });
  });

  return NextResponse.redirect(new URL("/report-problem/thanks", req.url), 303);
}

const MCP_DEFAULT_URL = "https://mcp.meetmeatthefair.com";
const CORRELATION_TIMEOUT_MS = 5000;

/**
 * POST to mcp-server's correlate-problem-report endpoint. Fire-and-forget
 * from the route; bounded timeout so a hanging mcp-server doesn't pin a
 * Worker until the 30s cap.
 *
 * Failure modes that fall through cleanly:
 *   - Network error / 5xx       → logged as warn, severity stays LOW.
 *   - 5s timeout                → AbortError, logged as warn.
 *   - Missing INTERNAL_API_KEY  → endpoint returns 401, treated as
 *                                 misconfig and logged as error.
 */
async function triggerCorrelation(problemReportId: string): Promise<void> {
  const env = getCloudflareEnv() as unknown as {
    MCP_SERVER_URL?: string;
    INTERNAL_API_KEY?: string;
  };
  const baseUrl = env.MCP_SERVER_URL || MCP_DEFAULT_URL;
  const apiKey = env.INTERNAL_API_KEY;
  if (!apiKey) {
    // Misconfig — the endpoint would 401. Log and bail.
    await logError(getCloudflareDb(), {
      level: "error",
      message: "INTERNAL_API_KEY missing; cannot trigger problem-report correlation",
      source: SOURCE,
      context: { problemReportId },
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CORRELATION_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/admin/internal/correlate-problem-report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": apiKey,
      },
      body: JSON.stringify({ id: problemReportId }),
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 404) {
      // 404 means the row vanished — race with deletion or another
      // operator. Don't treat as an outage. Other non-2xx is worth
      // a log line.
      await logError(getCloudflareDb(), {
        level: "warn",
        message: `correlate-problem-report returned ${res.status}`,
        source: SOURCE,
        context: { problemReportId, status: res.status },
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

function badRequest(msg: string): Response {
  return new Response(msg, { status: 400, headers: { "Content-Type": "text/plain" } });
}
