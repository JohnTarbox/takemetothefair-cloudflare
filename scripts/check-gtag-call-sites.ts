/**
 * OPE-392 Ask C — `gtag(...)` may only be called from the analytics module.
 *
 * The drift this prevents: an event added with a `gtag` call alone reaches GA4
 * and never reaches the durable first-party store, so it is invisible to every
 * admin surface, cannot be trended past GA4's retention, and cannot be joined
 * to a fair. `add_to_calendar`, `add_to_favorites` and `share` all lived in
 * that state until this ticket — 106, 64 and 72 events per 90 days that no
 * operator tool could see.
 *
 * A guard rather than a convention because the failure is invisible at every
 * stage that would normally catch it: TypeScript is happy, the component
 * renders, the click works, GA4 shows the event, and only a person querying
 * `analytics_events` months later notices the gap.
 *
 * The exemptions are deliberate, not grandfathered:
 *
 *   src/lib/analytics.ts        the module itself — `trackEvent` IS the wrapper
 *   src/components/WebVitals.tsx  Web Vitals stay GA4-only per ADR-001 (GA4
 *                                 keeps acquisition/audience/Web Vitals; D1 is
 *                                 the source of truth for behavioural events)
 *   src/app/layout.tsx          the GA4 bootstrap snippet — defines gtag, does
 *                               not emit a behavioural event
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Files permitted to call gtag directly. See the header for why each. */
const EXEMPT = new Set([
  "src/lib/analytics.ts",
  "src/components/WebVitals.tsx",
  "src/app/layout.tsx",
]);

/**
 * A gtag CALL in any of the forms it is actually written.
 *
 * The first version of this was decorative and mutation testing caught it: it
 * used `(?<![\w.])gtag\s*\(`, whose lookbehind excluded `window.gtag(` — the
 * very form the module uses — and matched neither `gtag?.(` nor
 * `window.gtag?.(`. Injecting `window.gtag?.("event", …)` into a component,
 * i.e. the exact drift this guard exists to stop, left it GREEN. All it ever
 * caught was the bare `gtag(` spelling, which is the one nobody writes.
 *
 * Covers: gtag( · gtag?.( · window.gtag( · window.gtag?.( · globalThis.gtag(
 * The leading boundary still rejects `mygtag(` and `.someGtag(`.
 */
const GTAG_CALL =
  /(?:^|[^\w.$])(?:(?:window|globalThis|self)\s*(?:\?\.|\.)\s*)?gtag\s*(?:\?\.)?\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const offenders: string[] = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).split("\\").join("/");
  if (EXEMPT.has(rel)) continue;
  // Tests may reference gtag to stub it.
  if (/__tests__|\.test\.(ts|tsx)$/.test(rel)) continue;
  const source = readFileSync(file, "utf8");
  // Track BLOCK-comment state across lines. A first cut stripped only `//` and
  // single-line `/* */`, and immediately flagged this guard's own sibling file
  // for the phrase "the only `gtag(` call sites" inside a JSDoc block — a
  // documentation mention reported as a call site. A guard that cries wolf on
  // prose about itself gets disabled, so the stripping has to be real.
  let inBlockComment = false;
  source.split("\n").forEach((line, i) => {
    let code = line;
    if (inBlockComment) {
      const end = code.indexOf("*/");
      if (end === -1) return;
      code = code.slice(end + 2);
      inBlockComment = false;
    }
    // Single-line block comments first, then an unterminated opener.
    code = code.replace(/\/\*.*?\*\//g, "");
    const open = code.indexOf("/*");
    if (open !== -1) {
      inBlockComment = true;
      code = code.slice(0, open);
    }
    code = code.replace(/\/\/.*$/, "");
    if (GTAG_CALL.test(code)) {
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    }
  });
}

if (offenders.length > 0) {
  console.error(
    "Direct gtag() calls found outside the analytics module.\n" +
      "Route the event through track() in src/lib/analytics.ts and declare its\n" +
      "sinks in src/lib/analytics/event-sinks.ts, so it cannot reach GA4 while\n" +
      "silently missing the first-party store (OPE-392).\n"
  );
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}

console.log(
  `gtag call-site guard passed — no direct calls outside the ${EXEMPT.size} exempt files.`
);
