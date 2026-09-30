export const dynamic = "force-dynamic";
/**
 * OPE-1058 scope 2 — the one-time category rewrite, as a single writer.
 *
 * POST { apply?: boolean, limit?: number }. Auth: admin session OR
 * X-Internal-Key. **Dry-run by default**: `apply` must be sent explicitly, so a
 * mis-click reports rather than writes.
 *
 * Ratified by John in session 2026-09-17 ("OPE-1058 approved"), with the mapping
 * and per-value row counts posted on the ticket beforehand.
 *
 * Follows docs/bulk-mutation-discipline.md:
 *  - **single-writer** — one Worker invocation walks the rows; no fan-out.
 *  - **idempotent** — `cleanupEventCategories` maps every target to itself, and
 *    the audit insert is keyed `ope1058-<event id>` with ON CONFLICT DO NOTHING,
 *    so a re-run after a partial failure finishes the job rather than doubling it.
 *  - **read-back verified** — the response reports what is still off-list, read
 *    after the writes rather than inferred from them.
 *  - **rollback-planned** — every changed row's before/after lands in
 *    `event_category_migration_log` in the same batch as its UPDATE.
 *
 * Batched at 20 rows: each row binds 7 audit columns plus 3 update params, and
 * D1 refuses a statement carrying more than 100 bound parameters.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, isNull } from "drizzle-orm";
import { withAuthorized } from "@/lib/api/with-auth";
import { events, eventCategoryMigrationLog } from "@/lib/db/schema";
import { partitionEventCategories } from "@takemetothefair/constants";
import { cleanupEventCategories } from "@/lib/events/category-cleanup";
import { logError } from "@/lib/logger";

const Body = z.object({
  apply: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(5000).optional().default(5000),
});

const BATCH = 20;

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const POST = withAuthorized(async ({ request, db }) => {
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const { apply, limit } = parsed.data;

  const rows = await db
    .select({
      id: events.id,
      slug: events.slug,
      categories: events.categories,
      tags: events.tags,
    })
    .from(events)
    .where(isNull(events.mergedInto))
    .limit(limit);

  interface Change {
    id: string;
    slug: string;
    before: string[];
    after: string[];
    tagsBefore: string[];
    tagsAfter: string[];
  }
  const changes: Change[] = [];
  const perValue: Record<string, number> = {};

  for (const row of rows) {
    const before = parseArray(row.categories);
    // An event with NO categories is not an off-list category, and this rewrite
    // was approved as an off-list mapping. `cleanupEventCategories([])` returns
    // ["Other"] so that a row the map empties is never left blank — but reaching
    // rows that were already empty would label 92 live events "Other", which is
    // a content decision nobody has made. Leave them to their own ticket.
    if (before.length === 0) continue;
    const result = cleanupEventCategories(before);
    const tagsBefore = parseArray(row.tags);
    const tagsAfter = [...tagsBefore];
    for (const t of result.addTags) if (!tagsAfter.includes(t)) tagsAfter.push(t);

    const categoriesChanged = JSON.stringify(result.categories) !== JSON.stringify(before);
    const tagsChanged = JSON.stringify(tagsAfter) !== JSON.stringify(tagsBefore);
    if (!categoriesChanged && !tagsChanged) continue;

    for (const value of before) {
      if (!result.categories.includes(value)) perValue[value] = (perValue[value] ?? 0) + 1;
    }
    changes.push({
      id: row.id,
      slug: row.slug,
      before,
      after: result.categories,
      tagsBefore,
      tagsAfter,
    });
  }

  let written = 0;
  let batchError: string | null = null;
  if (apply) {
    const now = new Date();
    for (let i = 0; i < changes.length; i += BATCH) {
      const batch = changes.slice(i, i + BATCH);
      const statements = batch.flatMap((c) => [
        // The audit row first: an interrupted batch still records what it meant
        // to change, which is the only route back.
        db
          .insert(eventCategoryMigrationLog)
          .values({
            id: `ope1058-${c.id}`,
            eventId: c.id,
            categoriesBefore: JSON.stringify(c.before),
            categoriesAfter: JSON.stringify(c.after),
            tagsBefore: JSON.stringify(c.tagsBefore),
            tagsAfter: JSON.stringify(c.tagsAfter),
            migratedAt: now,
          })
          .onConflictDoNothing(),
        db
          .update(events)
          .set({ categories: JSON.stringify(c.after), tags: JSON.stringify(c.tagsAfter) })
          .where(eq(events.id, c.id)),
      ]);
      try {
        await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
        written += batch.length;
      } catch (error) {
        batchError = error instanceof Error ? error.message : String(error);
        await logError(db, {
          source: "app/api/admin/events/category-cleanup",
          message: `category cleanup batch failed at offset ${i}`,
          error,
        });
        break; // a re-run resumes; the audit table says what already landed
      }
    }
  }

  // Read BACK, after writing — the end state, not what we believe we wrote.
  const after = await db
    .select({ id: events.id, slug: events.slug, categories: events.categories })
    .from(events)
    .where(isNull(events.mergedInto));
  const stillOffList: Array<{ slug: string; values: string[] }> = [];
  for (const row of after) {
    const dropped = partitionEventCategories(parseArray(row.categories)).dropped;
    if (dropped.length > 0) stillOffList.push({ slug: row.slug, values: dropped });
  }

  await logError(db, {
    level: "info",
    source: "app/api/admin/events/category-cleanup",
    message: apply
      ? `category cleanup applied to ${written} of ${changes.length} planned rows; ${stillOffList.length} rows still carry an off-list value`
      : `category cleanup DRY RUN — ${changes.length} rows would change`,
    context: { apply, planned: changes.length, written, stillOffList: stillOffList.length },
  });

  return NextResponse.json({
    ok: batchError === null,
    apply,
    scanned: rows.length,
    planned: changes.length,
    written,
    error: batchError,
    per_value: perValue,
    still_off_list: stillOffList,
    changes: changes.slice(0, 200),
  });
});
