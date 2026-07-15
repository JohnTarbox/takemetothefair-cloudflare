export const dynamic = "force-dynamic";
/**
 * OPE-197 — one-time cleanup: strip the trailing edition year from legacy
 * `event_series` names so landing hubs render evergreen titles.
 *
 * WHY: the series landing renders `${series.name} — Meet Me at the Fair`, so a
 * year-stamped series name makes the evergreen hub a near-duplicate of its own
 * /YYYY occurrence — which is what lets both URLs rank for the same dated query
 * (GSC 2026-07-14: Whaling City Festival, Cambridge Arts River Festival). The
 * two-page model itself is deliberate (Option A / EH3 P2.3); collapsing the
 * canonicals was proposed and REJECTED (OPE-89). This endpoint touches names
 * ONLY — never canonical, slug, or routing.
 *
 * The builder is already correct (backfill/route.ts:280 strips on insert, and
 * no other series-name writer exists), so this is a one-shot correction of rows
 * created before that guard shipped — not a recurring job.
 *
 * THE WRITE IS DOUBLE-GATED (customer-facing: ~1,146 page titles + JSON-LD):
 *   1. `dry_run` defaults TRUE — you must explicitly send `dry_run:false`.
 *   2. `confirm` must equal "GO" — a second, deliberate keystroke.
 * Anything else previews and writes nothing.
 *
 * Bulk-mutation discipline (docs/bulk-mutation-discipline.md, OPE-53):
 *   - single-writer  — reuses the builder's own `stripNameEditionSuffix`, so a
 *                      cleaned row equals what a fresh insert would mint today
 *   - idempotent     — re-running proposes nothing (that emptiness IS acceptance)
 *   - read-back      — re-reads + re-plans after writing and FAILS LOUD if any
 *                      row still carries a trailing year
 *   - rollback       — the admin_actions payload is the undo manifest
 *                      (id + from + to per row)
 *
 * Dual auth: admin session OR X-Internal-Key.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { internalKeyMatches } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { eventSeries, adminActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { planEvergreenNames, type EvergreenRename } from "@/lib/series/evergreen-names";
import { pingIndexNow } from "@/lib/indexnow";

/** Rows per `db.batch` — mirrors the series-backfill endpoint's chunking. */
const WRITE_CHUNK = 50;
/** Preview rows returned when the caller doesn't ask for the full diff. */
const SAMPLE_SIZE = 20;

interface Body {
  dry_run?: boolean;
  confirm?: string;
  /** Series ids to spare — a confirmed 19xx false positive. */
  exclude_ids?: string[];
  /** Return every proposed rename, not just the 19xx set + a sample. */
  include_diff?: boolean;
  /**
   * Canonical slugs to re-ping IndexNow for after a successful write. A
   * D1-direct UPDATE bypasses the IndexNow hook, so recrawl needs a nudge —
   * but pinging all ~1,146 would burn quota, so this is an explicit,
   * operator-chosen shortlist (the top hubs from the GSC finding). Note the
   * REL4 breaker may suppress pings while `indexnow:paused` is set in KV.
   */
  reping_slugs?: string[];
}

async function authorize(request: NextRequest): Promise<boolean> {
  if (await internalKeyMatches(request)) return true;
  const session = await auth();
  return session?.user?.role === "ADMIN";
}

function serialize(r: EvergreenRename) {
  return { id: r.id, canonical_slug: r.canonicalSlug, from: r.from, to: r.to, token: r.token };
}

export async function POST(request: NextRequest) {
  try {
    if (!(await authorize(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getCloudflareDb();
    const body = (await request.json().catch(() => ({}))) as Body;
    const excludeIds = Array.isArray(body.exclude_ids) ? body.exclude_ids : [];

    const rows = await db
      .select({
        id: eventSeries.id,
        canonicalSlug: eventSeries.canonicalSlug,
        name: eventSeries.name,
      })
      .from(eventSeries);

    const plan = planEvergreenNames(rows, { excludeIds });

    // ── Preview (default) ──────────────────────────────────────────────────
    // Explicit dry_run:false AND confirm:"GO" are both required to write, so
    // any other shape — including a bare {} — lands here and touches nothing.
    if (body.dry_run !== false) {
      return NextResponse.json({
        dry_run: true,
        total_series: plan.totalSeries,
        would_change: plan.renames.length,
        excluded: plan.excluded.map(serialize),
        // The interpretive edge — always surfaced, however the diff is trimmed.
        nineteen_xx_review: plan.nineteenXx.map(serialize),
        sample: plan.renames.slice(0, SAMPLE_SIZE).map(serialize),
        diff: body.include_diff ? plan.renames.map(serialize) : undefined,
        hint: 'Re-send with {"dry_run":false,"confirm":"GO"} to apply.',
      });
    }

    if (body.confirm !== "GO") {
      return NextResponse.json(
        {
          error: 'Refusing to write: dry_run:false requires confirm:"GO".',
          would_change: plan.renames.length,
        },
        { status: 400 }
      );
    }

    // ── Confirmed pass ─────────────────────────────────────────────────────
    if (plan.renames.length === 0) {
      // Idempotent no-op: a prior pass already cleaned these.
      return NextResponse.json({
        dry_run: false,
        updated: 0,
        remaining: 0,
        note: "Nothing to do — every series name is already evergreen.",
      });
    }

    const now = new Date();
    const statements = plan.renames.map((r) =>
      db.update(eventSeries).set({ name: r.to, updatedAt: now }).where(eq(eventSeries.id, r.id))
    );
    for (let i = 0; i < statements.length; i += WRITE_CHUNK) {
      const chunk = statements.slice(i, i + WRITE_CHUNK);
      await db.batch(chunk as unknown as Parameters<typeof db.batch>[0]);
    }

    // ── Read-back verify (OPE-53) ──────────────────────────────────────────
    // Re-read from D1 and re-plan. Anything still proposed means a write didn't
    // land — report it instead of claiming success.
    const after = await db
      .select({
        id: eventSeries.id,
        canonicalSlug: eventSeries.canonicalSlug,
        name: eventSeries.name,
      })
      .from(eventSeries);
    const verify = planEvergreenNames(after, { excludeIds });
    const verified = verify.renames.length === 0;

    const session = await auth();
    await db.insert(adminActions).values({
      action: "event.series.evergreen_names",
      actorUserId: session?.user?.id ?? null,
      targetType: "event_series",
      targetId: "evergreen-names",
      // Payload IS the undo manifest: restore `from` for each id to revert.
      payloadJson: JSON.stringify({
        updated: plan.renames.length,
        excluded_ids: excludeIds,
        verified,
        remaining: verify.renames.map(serialize),
        manifest: plan.renames.map((r) => ({ id: r.id, from: r.from, to: r.to })),
      }),
      createdAt: now,
    });

    // ── Recrawl signal ─────────────────────────────────────────────────────
    // Best-effort: a failed ping must not report the (already-committed) write
    // as failed. Landing pages are no-store dynamic, so they serve the new
    // title immediately — this only accelerates Google/Bing noticing.
    let repinged: string[] = [];
    const slugs = Array.isArray(body.reping_slugs) ? body.reping_slugs : [];
    if (verified && slugs.length > 0) {
      try {
        const env = getCloudflareEnv() as unknown as Parameters<typeof pingIndexNow>[2];
        const urls = slugs.map((s) => `https://meetmeatthefair.com/events/${s}`);
        await pingIndexNow(db, urls, env, "series.evergreen_names");
        repinged = slugs;
      } catch (e) {
        await logError(db, {
          message: "IndexNow re-ping failed after evergreen-names pass (write already committed)",
          error: e,
          source: "app/api/admin/series/evergreen-names/route.ts:POST",
        });
      }
    }

    return NextResponse.json(
      {
        dry_run: false,
        updated: plan.renames.length,
        verified,
        remaining: verify.renames.length,
        remaining_rows: verify.renames.map(serialize),
        excluded: plan.excluded.map(serialize),
        repinged,
      },
      // Read-back mismatch is a real failure, not a warning.
      { status: verified ? 200 : 500 }
    );
  } catch (e) {
    const db = getCloudflareDb();
    await logError(db, {
      message: "Error in series evergreen-names endpoint",
      error: e,
      source: "app/api/admin/series/evergreen-names/route.ts:POST",
    });
    return NextResponse.json({ error: "Series evergreen-names pass failed" }, { status: 500 });
  }
}
