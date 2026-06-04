/**
 * UR1 C3 (2026-06-04) — POST handler for the web problem-report form.
 *
 * Mirrors the email path (`mcp-server/src/email-handlers/problem-report.ts`)
 * but writes directly to the main app's D1 since this is a same-Worker
 * write — going via the MCP Worker over HTTP would add a 100ms+ hop
 * for a one-row insert.
 *
 * Skips the burst-watch correlation that the email path does because
 * the helper lives in mcp-server only. Instead, severity defaults to
 * LOW and operators can re-correlate via the C5 MCP tool
 * `correlate_problem_report(id)`. The HIGH-severity path remains fully
 * wired via email submissions; this matches the typical case (web form
 * reports are usually feature requests / individual data fixes, not
 * outage alerts — those land via the user clicking "Report a problem"
 * from the error boundary, where path context is the strongest signal).
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

export const runtime = "edge";

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

  // Insert. Severity defaults to LOW — the email path runs burst-watch
  // correlation; the web path defers that to C5's MCP tool.
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

  return NextResponse.redirect(new URL("/report-problem/thanks", req.url), 303);
}

function badRequest(msg: string): Response {
  return new Response(msg, { status: 400, headers: { "Content-Type": "text/plain" } });
}
