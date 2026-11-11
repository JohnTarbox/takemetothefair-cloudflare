/**
 * OPE-1625 — `dry_run` on the promoter API: the same auth, signature and rate
 * limit, the same decision code (service.ts with `caller.dryRun`), a read-only
 * database, and the test-submission engine's report in place of a write.
 *
 * Asked for with `?dry_run=true` (or `1`) on the URL, or `"dry_run": true` in
 * the JSON body. The request id IS consumed, exactly as on a real call: the
 * replay ledger records that this signed request was seen, so replaying a
 * captured dry run is refused like any other replay. Nothing else is written:
 * no ref claim, no import-ledger row, no event, no review flag, no citation.
 * (The key's `last_used_at` is still stamped: the key was used.)
 *
 * A body the schema refuses (unknown key, wrong type) is still a 422: the
 * request is malformed whether or not it is a test. A body that parses but
 * that the real call would refuse (a missing field, another organizer's event)
 * answers 200 with the report, and `would_return` names the real status.
 */
import { NextResponse } from "next/server";
import type { getCloudflareDb } from "@/lib/cloudflare";
import type { ImportField } from "@/lib/promoter-import/rows";
import { describeCells } from "@/lib/test-submission/engine";
import { publicChanges, publicListing } from "@/lib/test-submission/public-listing";
import { readOnlyDb } from "@/lib/test-submission/read-only-db";
import type { ItemReport, Outcome, SkipReason } from "@/lib/test-submission/types";
import { apiError } from "./handler";
import type { Caller, ServiceResult } from "./service";

type Db = ReturnType<typeof getCloudflareDb>;

/**
 * Whether this request is a dry run, and the body without the `dry_run` key
 * (the field schemas are strict, so it must not reach them).
 */
export function readDryRun(
  request: Request,
  json: unknown
): { ok: true; dryRun: boolean; value: unknown } | { ok: false; response: Response } {
  const q = new URL(request.url).searchParams.get("dry_run");
  const fromQuery = q !== null && /^(true|1)$/i.test(q);
  if (!json || typeof json !== "object" || Array.isArray(json) || !("dry_run" in json))
    return { ok: true, dryRun: fromQuery, value: json };
  const { dry_run, ...rest } = json as Record<string, unknown>;
  if (typeof dry_run !== "boolean")
    return {
      ok: false,
      response: apiError(422, "validation_failed", "Invalid fields.", {
        errors: [{ field: "dry_run", message: "Must be true or false." }],
      }),
    };
  return { ok: true, dryRun: fromQuery || dry_run, value: rest };
}

/** The dry run's database and caller: writes throw, and the service gates its own. */
export function dryRunContext(db: Db, caller: Caller): { db: Db; caller: Caller } {
  return { db: readOnlyDb(db), caller: { ...caller, dryRun: true } };
}

const SKIP_FOR_CODE: Record<string, SkipReason> = {
  validation_failed: "invalid",
  conflict_other_promoter: "listed_by_another_organizer",
  conflict_external_id: "external_id_conflict",
  in_progress: "in_progress",
  not_found: "not_found",
};

const MATCH_SUMMARY: Record<string, string> = {
  update_staged: "Matches your listing: these changes would be sent to review.",
  unchanged: "Matches your listing: nothing would change.",
  cancel_staged: "Matches your listing: the cancellation would be sent to review.",
};

async function outcomeFor(db: Db, caller: Caller, r: ServiceResult): Promise<Outcome> {
  if (!r.ok) {
    return {
      kind: "skip",
      reason: SKIP_FOR_CODE[r.code] ?? "invalid",
      summary: `Would be refused (${r.httpStatus} ${r.code}): ${r.message}`,
    };
  }
  if (r.body.outcome === "created" || !r.body.event_id)
    return {
      kind: "new",
      summary: "New: this would create a listing that goes to our review queue first.",
    };
  const listing = await publicListing(db, r.body.event_id, { ownerPromoterId: caller.promoterId });
  return {
    kind: "match",
    summary: MATCH_SUMMARY[r.body.outcome] ?? "Matches your listing.",
    listing: { url: listing.url, name: listing.name, public: listing.public },
    changes: publicChanges(r.body.changes, listing),
  };
}

/** The 200 a dry run answers: what the real call would return, and the engine's report. */
export async function dryRunResponse(
  db: Db,
  caller: Caller,
  externalId: string,
  cells: Partial<Record<ImportField, string>>,
  result: ServiceResult,
  opts: { partial?: boolean } = {}
): Promise<Response> {
  const described = describeCells(cells, {
    now: caller.now,
    source: "from your API request",
    externalId,
    partial: opts.partial,
  });
  const report: ItemReport = { ...described, outcome: await outcomeFor(db, caller, result) };
  const would_return = result.ok
    ? {
        status: result.httpStatus,
        outcome: result.body.outcome,
        event_id: result.body.event_id,
        ...(result.body.not_compared ? { not_compared: result.body.not_compared } : {}),
        ...(result.body.warnings ? { warnings: result.body.warnings } : {}),
      }
    : {
        status: result.httpStatus,
        error: {
          code: result.code,
          message: result.message,
          ...(result.errors ? { errors: result.errors } : {}),
        },
      };
  return NextResponse.json(
    { dry_run: true, external_id: externalId, would_return, report },
    { status: 200 }
  );
}
