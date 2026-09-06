/**
 * OPE-740 — CI guard: a rolled edition keeps saying it was rolled.
 *
 * ## Why a guard on code that is currently correct
 *
 * `mcp-server/src/event-rollover.ts` sets every invariant right today —
 * OPE-483 fixed the provenance fields there in August. The problem is what
 * happens if that stops being true: **`auto_rollover` has zero rows in
 * production**. The writer has never executed. A regression on this path
 * produces no wrong page, no bad query result, and no alert, because nothing
 * runs it. It would be found the day it first runs, on live rows.
 *
 * That is precisely the condition under which an invariant rots unnoticed, and
 * precisely why the protection has to be static rather than behavioural.
 *
 * ## The seam this exists for
 *
 * The one that unit tests cannot see is the **cross-file agreement**: the
 * writer's `ingestionMethod` string must be a member of
 * `ROLLOVER_INGESTION_METHODS` in `src/lib/events/derived-date.ts`, or the
 * "Projected from last year" copy silently stops appearing on exactly the rows
 * it was written for. Rename the method in the writer and both files still look
 * entirely reasonable on their own; the badge just quietly never fires.
 *
 * The other four are the claims the copy makes on the reader's behalf:
 *
 *   - `datesConfirmed: false` — we did not confirm these dates with anyone.
 *   - `sourceUrl: null`       — no external page published this edition. (The
 *                               OPE-483 defect: 20 live `*-me-2027` rows carry
 *                               an inherited `mainefairs.net` URL that 404s.)
 *   - `status` / `lifecycleStatus: "TENTATIVE"` — not an announced event.
 *   - `rolledFromEventId` set — the lineage the live cohort is recognised by.
 *
 * ⚠️ What this guard does NOT do: assert that any of it is *rendered*. That is
 * `derived-date-ope740.test.ts`'s job, and the split matters — a guard that
 * greps the served HTML would have passed on the defect this ticket is about,
 * because the false copy lived in a `title=` attribute and was present in the
 * response the whole time.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const WRITER = join(ROOT, "mcp-server", "src", "event-rollover.ts");
const PREDICATE = join(ROOT, "src", "lib", "events", "derived-date.ts");

function fail(msg: string): never {
  console.error(`Rollover invariants guard FAILED (OPE-740):\n\n${msg}\n`);
  process.exit(1);
}

const writer = readFileSync(WRITER, "utf8");
const predicate = readFileSync(PREDICATE, "utf8");

// ---------------------------------------------------------------------------
// 1. Locate the insert payload.
//
// Scoping to the payload matters: `sourceUrl` appears in the OPE-483 comment
// block too, so a bare file-wide search for `sourceUrl: null` would go green
// against prose. Anchor on the values object the writer builds.
// ---------------------------------------------------------------------------
const payloadStart = writer.indexOf("datesConfirmed:");
if (payloadStart === -1) {
  fail(
    `Could not find the insert payload in ${WRITER}.\n` +
      `Expected a \`datesConfirmed:\` key. If the writer was restructured, this\n` +
      `guard needs updating alongside it — do NOT delete it, or the five\n` +
      `invariants below go unprotected on a path that never executes.`
  );
}
const payloadEnd = writer.indexOf("createdAt:", payloadStart);
const payload = writer.slice(payloadStart, payloadEnd === -1 ? writer.length : payloadEnd);

// ---------------------------------------------------------------------------
// 2. The four value invariants.
// ---------------------------------------------------------------------------
const INVARIANTS: Array<{ pattern: RegExp; label: string; why: string }> = [
  {
    pattern: /\bdatesConfirmed:\s*false\b/,
    label: "datesConfirmed: false",
    why: "A projected date is not a confirmed one. Setting this true would make the row indistinguishable from an organizer-supplied date — the exact state the two worst rows in the 121-row cohort are already in.",
  },
  {
    pattern: /\bsourceUrl:\s*null\b/,
    label: "sourceUrl: null",
    why: "No external page published this edition. OPE-483 fixed this after the prior edition's URL was being inherited onto rows no source had published — a provenance pointer that cannot be followed is worse than none, because it looks sourced.",
  },
  {
    pattern: /\bstatus:\s*"TENTATIVE"/,
    label: 'status: "TENTATIVE"',
    why: "APPROVED would put a machine-guessed date into the main listings with no hedge at all.",
  },
  {
    pattern: /\blifecycleStatus:\s*"TENTATIVE"/,
    label: 'lifecycleStatus: "TENTATIVE"',
    why: "Keeps the lifecycle consistent with `status`. ⚠️ NOT what the detail page reads — the amber projected-dates box branches on `event.status === 'TENTATIVE'` (src/app/events/[slug]/page.tsx:628), and all 124 live rollover rows carry lifecycle_status=SCHEDULED because they came from the offline script, not this writer.",
  },
  {
    // ⚠️ NOT `\s*\w` — `null` starts with a word character, so that pattern
    // read "set to nothing" as "set". Caught by driving this branch to failure
    // (v3.8): the M5 mutation `rolledFromEventId: null` passed the guard.
    pattern: /\brolledFromEventId:\s*(?!null\b|undefined\b)[A-Za-z_$]/,
    label: "rolledFromEventId: <source id>",
    why: "The lineage the live cohort is recognised by. hasDerivedDate() has a second tell (ingestion_method) so the badge survives losing this, but nothing else records which edition a date was projected FROM.",
  },
];

const missing = INVARIANTS.filter((i) => !i.pattern.test(payload));
if (missing.length > 0) {
  fail(
    `The auto-rollover writer no longer sets:\n\n` +
      missing.map((m) => `  • ${m.label}\n      ${m.why}`).join("\n\n") +
      `\n\nFile: ${WRITER}\n\n` +
      `⚠️ auto_rollover has never produced a row in production, so nothing else\n` +
      `will catch this. It would surface the first time the writer runs, on real\n` +
      `public rows.`
  );
}

// ---------------------------------------------------------------------------
// 3. The cross-file seam — the one no unit test can see.
// ---------------------------------------------------------------------------
const methodMatch = payload.match(/\bingestionMethod:\s*"([^"]+)"/);
if (!methodMatch) {
  fail(
    `The auto-rollover writer no longer sets a literal \`ingestionMethod\`.\n` +
      `It is one of the two tells hasDerivedDate() reads. If it became a\n` +
      `variable, this guard can no longer verify the two files agree — wire the\n` +
      `check to whatever the new source of truth is.`
  );
}
const method = methodMatch[1];

// Parse the declaration array, not the whole file: the method names appear in
// derived-date.ts's own doc comment, so a substring search over the file would
// pass with the array emptied.
const listMatch = predicate.match(
  /export const ROLLOVER_INGESTION_METHODS\s*=\s*\[([\s\S]*?)\]\s*as const/
);
if (!listMatch) {
  fail(`Could not parse ROLLOVER_INGESTION_METHODS in ${PREDICATE}.`);
}
const declared = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

if (!declared.includes(method)) {
  fail(
    `The rollover writer writes ingestion_method="${method}", which is NOT in\n` +
      `ROLLOVER_INGESTION_METHODS: [${declared.map((d) => `"${d}"`).join(", ")}]\n\n` +
      `${PREDICATE}\n\n` +
      `Effect: hasDerivedDate() returns false for every row this writer creates,\n` +
      `so the "Projected from last year — not yet published by the organizer"\n` +
      `copy silently stops appearing, and those pages fall back to claiming the\n` +
      `dates were submitted. Both files look correct in isolation.\n\n` +
      `Fix: add "${method}" to ROLLOVER_INGESTION_METHODS (and to the list\n` +
      `pinned in derived-date-ope740.test.ts).`
  );
}

// The offline cohort is only recognisable by ingestion_method — it recorded no
// lineage. 121 live rows depend on this string being present.
if (!declared.includes("annual_rollover")) {
  fail(
    `"annual_rollover" is missing from ROLLOVER_INGESTION_METHODS.\n\n` +
      `That is the 121-row cohort minted by the offline script on 2026-06-13..15.\n` +
      `rolled_from_event_id is NULL on EVERY row in the table, so ingestion_method\n` +
      `is the only way to recognise them. Removing it un-hedges 121 indexed pages.`
  );
}

console.log(
  `✓ Rollover invariants intact (OPE-740): ` +
    `${INVARIANTS.length} writer invariants, ingestion_method="${method}" ∈ ` +
    `[${declared.join(", ")}]`
);
