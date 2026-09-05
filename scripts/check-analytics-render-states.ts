/**
 * OPE-808 — CI guard: the A4 convention cannot quietly narrow again.
 *
 * A4 shipped in OPE-310 as `UnavailableBadge` on three GSC tiles, covering one
 * failure mode (a fetch returning null). It was correct and it stayed exactly
 * that wide, while every tile added since was free to invent its own fallback.
 * By the 2026-09-05 audit, **two of the four items in the dashboard's own
 * action queue were artefacts of this fault class rather than real defects** —
 * the page was generating work against its own rendering bugs.
 *
 * Two things are enforced, and both are things a reviewer cannot see by
 * reading a diff:
 *
 *  1. **Freshness on `time_to_index_log` is judged on the ADMISSION column.**
 *     `indexnow_submitted_at` is what puts a row in the table and it froze on
 *     2026-06-13; `first_crawl_at` is when a row resolves and keeps advancing
 *     (2026-09-04) as stragglers from the closed June cohort land. Judging
 *     freshness on the second reports a healthy feed while the median climbs
 *     mechanically — which is why that KPI read "breached · 70d" and could
 *     only ever worsen. Swapping the column back is a one-word edit that looks
 *     harmless and silently restores a permanent false P0.
 *
 *  2. **The render-state helper stays wired.** A helper nothing imports is the
 *     inert-control shape this repo has shipped repeatedly.
 *
 * ⚠️ This does NOT try to grep for every `?? 0` in the analytics tree. That
 * acceptance criterion is about tile VALUES, and a text search cannot tell a
 * tile value from a loop counter or a default page size — it would be a guard
 * that fires on correct code, which is how guards get deleted. The typed
 * `Measurement` return on the cards is what actually enforces it: a card field
 * that must express "not measured" cannot be satisfied by a bare number.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const KPI_STATES = join(ROOT, "src", "lib", "kpi-states.ts");
const RENDER_STATE = join(ROOT, "src", "lib", "analytics-overview", "render-state.ts");
const HEALTH = join(ROOT, "src", "lib", "analytics-overview", "health.ts");

function fail(msg: string): never {
  console.error(`Analytics render-state guard FAILED (OPE-808):\n\n${msg}\n`);
  process.exit(1);
}

const kpiStates = readFileSync(KPI_STATES, "utf8");
const renderState = readFileSync(RENDER_STATE, "utf8");
const health = readFileSync(HEALTH, "utf8");

// Positive landmark first — every check below is a substring test.
if (!kpiStates.includes("readTimeToIndex")) {
  fail(
    `  ${KPI_STATES}\n  does not define readTimeToIndex. The guard is pointed at the wrong file.`
  );
}
if (!renderState.includes("export function freshness")) {
  fail(`  ${RENDER_STATE}\n  does not export freshness(). The helper is missing or renamed.`);
}

// 1. The staleness column.
const ttiBlock = kpiStates.slice(kpiStates.indexOf("async function readTimeToIndex"));
const scoped = ttiBlock.slice(0, 2500);
if (!scoped.includes("indexnowSubmittedAt")) {
  fail(
    `  readTimeToIndex no longer judges freshness on \`indexnowSubmittedAt\`.\n\n` +
      `  That column ADMITS rows and froze on 2026-06-13 when the IndexNow\n` +
      `  breaker paused. \`firstCrawlAt\` keeps advancing as stragglers from the\n` +
      `  closed June cohort resolve, so judging freshness on it reports a healthy\n` +
      `  feed while the median climbs on its own.\n\n` +
      `  That is the exact configuration that produced a "breached · 70d" P0 which\n` +
      `  could only ever worsen, regardless of real indexing performance.`
  );
}
if (/max\(\$\{timeToIndexLog\.firstCrawlAt\}\)/.test(scoped)) {
  fail(
    `  readTimeToIndex is back to \`max(firstCrawlAt)\` for its staleness signal.\n` +
      `  See above — that is the resolution column, not the admission column.`
  );
}

// 2. The helper is actually used.
if (!health.includes("freshness(") || !health.includes("rate(")) {
  fail(
    `  src/lib/analytics-overview/health.ts no longer calls the render-state\n` +
      `  helpers (\`freshness\` and \`rate\`).\n\n` +
      `  The helper would exist, its unit tests would pass, and every tile would\n` +
      `  be back to inventing its own fallback — which is precisely how the A4\n` +
      `  convention narrowed to three tiles the first time.`
  );
}

// 3. The card must be able to SAY it was truncated.
if (!health.includes("truncated:")) {
  fail(
    `  The time-to-index card no longer reports \`truncated\`.\n` +
      `  Its query samples with a LIMIT; without this flag the sample size gets\n` +
      `  rendered as the population, which read "1,000 resolved" against 5,501.`
  );
}

console.log(
  "Analytics render-state guard passed — freshness judged on the admission column, " +
    "helpers wired, truncation reportable."
);
