export const dynamic = "force-dynamic";
/**
 * OPE-1625 phase 2 — `POST /api/v1/preview-event` `{ "fields": { … } }`: the
 * backend for the suggest-form and promoter-portal **Preview** button. Takes the
 * event form's fields (the OPE-1618 template's keys: name, start_date, end_date,
 * daily_hours, venue_name, address, city, state, zip, …) and returns the same
 * report every test channel returns — what we read, what would happen
 * (new / match / skip, with the reason), and the problems — for ONE event.
 *
 * Public and unauthenticated, like /api/v1/check-calendar, so: a per-IP cap
 * (fail-closed BurstCounter), a capped body, and NO WRITES — the engine gets a
 * read-only database handle, and failures go to the Worker log, not error_logs.
 * It fetches nothing outside our own database.
 *
 * Not linked from any page yet: the Preview buttons are a later PR, and their
 * on-screen wording goes to John first (OPE-1625 acceptance 6 / OPE-1624).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  PREVIEW_EVENT_RATE,
  clientIp,
  publicRateLimit,
} from "@/lib/test-submission/check-calendar";
import { assessFormFields, type Cells } from "@/lib/test-submission/engine";
import { readOnlyDb } from "@/lib/test-submission/read-only-db";
import { TEMPLATE_COLUMNS } from "@/lib/promoter-import/rows";

const MAX_BODY_CHARS = 16_384;

const fieldsSchema = z.strictObject(
  Object.fromEntries(
    TEMPLATE_COLUMNS.map((c) => [
      c.key,
      z
        .string()
        .max(c.key === "description" ? 5000 : 500)
        .optional(),
    ])
  ) as Record<keyof Cells, z.ZodOptional<z.ZodString>>
);
const bodySchema = z.strictObject({ fields: fieldsSchema });

const error = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  NextResponse.json({ error: { code, message } }, { status, headers });

export async function POST(request: Request) {
  const limit = await publicRateLimit("preview-event", PREVIEW_EVENT_RATE, clientIp(request));
  if (!limit.allowed)
    return error(
      limit.status,
      limit.status === 429 ? "rate_limited" : "unavailable",
      limit.status === 429
        ? "Too many previews from your address. Try again later."
        : "Preview is unavailable right now. Try again shortly.",
      { "Retry-After": String(limit.retryAfterSeconds) }
    );

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return error(413, "too_large", "That is too much to preview.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return error(400, "invalid_json", 'Send JSON: { "fields": { "name": "…", … } }.');
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success)
    return error(
      422,
      "invalid_fields",
      "Send the event's form fields as fields; unknown or over-long fields are refused."
    );

  // Blank strings are "not filled in", not values.
  const cells: Cells = {};
  for (const [k, v] of Object.entries(parsed.data.fields) as Array<[keyof Cells, string?]>)
    if (v?.trim()) cells[k] = v.trim();

  try {
    const item = await assessFormFields(readOnlyDb(getCloudflareDb()), cells, {
      now: new Date(),
      source: "from the form",
    });
    return NextResponse.json({ dry_run: true, item }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // Worker log only: this route writes nothing, error_logs included.
    console.error("[preview-event] failed", e);
    return error(500, "internal_error", "Something went wrong on our side.");
  }
}
