#!/usr/bin/env tsx
/**
 * GA4 page_view verification script.
 *
 * Loads each URL in a fresh headless Chromium context (no cookie/cache reuse)
 * and counts requests to *.google-analytics.com/g/collect that carry an
 * `en=page_view` event. The expected count is exactly 1 per page load.
 *
 * Why not GA4 DebugView? DebugView groups events and can mask doubles.
 * Network-level counting is the authoritative answer.
 *
 * Why this script exists: inline <script> elements that live in the React
 * tree of `app/layout.tsx` are serialized into BOTH the SSR HTML AND the
 * RSC flight payload, so the install can appear twice in the response and
 * (without an idempotency guard) fire 2x page_view per load. See
 * `src/app/layout.tsx:104-114` for the guard pattern.
 *
 * Usage:
 *   npx tsx scripts/verify-ga4-pageview.ts
 *   npx tsx scripts/verify-ga4-pageview.ts https://meetmeatthefair.com/events
 *   npx tsx scripts/verify-ga4-pageview.ts /events /vendors
 *   BASE_URL=https://staging.example.com npx tsx scripts/verify-ga4-pageview.ts
 *   LOADS_PER_URL=3 WAIT_MS=10000 npx tsx scripts/verify-ga4-pageview.ts
 *
 * Exit codes:
 *   0  every load saw exactly 1 page_view
 *   1  at least one load saw 0 or >1 page_views
 *   2  no GA4 collect requests captured at all (likely blocked / wrong env)
 */

import { chromium, type Request } from "playwright";

const BASE_URL = process.env.BASE_URL || "https://meetmeatthefair.com";
const LOADS_PER_URL = Number(process.env.LOADS_PER_URL || 2);
const WAIT_MS = Number(process.env.WAIT_MS || 8000);

const DEFAULT_PATHS = ["/", "/events", "/vendors", "/admin"];

const COLLECT_RE = /google-analytics\.com\/(g\/)?collect/;
const URL_PV_RE = /[?&]en=page_view/g;
const BODY_PV_RE = /(^|\n)en=page_view(&|\n|$)/g;

interface CapturedReq {
  url: string;
  method: string;
  body: string | null;
}

interface LoadResult {
  url: string;
  load: number;
  collectCount: number;
  pageViews: number;
  pass: boolean;
}

function parseTargets(args: string[]): string[] {
  const targets = args.length > 0 ? args : DEFAULT_PATHS;
  return targets.map((t) => {
    if (t.startsWith("http://") || t.startsWith("https://")) return t;
    return BASE_URL.replace(/\/+$/, "") + (t.startsWith("/") ? t : "/" + t);
  });
}

function countPageViews(reqs: CapturedReq[]): number {
  let count = 0;
  for (const r of reqs) {
    count += (r.url.match(URL_PV_RE) || []).length;
    if (r.method === "POST" && r.body) {
      count += (r.body.match(BODY_PV_RE) || []).length;
    }
  }
  return count;
}

async function main() {
  const targets = parseTargets(process.argv.slice(2));
  console.log(
    `Verifying GA4 page_view count: ${targets.length} URL(s) x ${LOADS_PER_URL} load(s), ${WAIT_MS}ms wait\n`
  );

  const browser = await chromium.launch({ headless: true });
  const results: LoadResult[] = [];
  let anyCollect = false;

  try {
    for (const url of targets) {
      for (let i = 1; i <= LOADS_PER_URL; i++) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const reqs: CapturedReq[] = [];

        page.on("request", (req: Request) => {
          const u = req.url();
          if (!COLLECT_RE.test(u)) return;
          let body: string | null = null;
          try {
            body = req.postData();
          } catch {
            /* postData() can throw on requests with no body; ignore */
          }
          reqs.push({ url: u, method: req.method(), body });
        });

        process.stdout.write(`Load ${i}: ${url} ... `);
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
        await page.waitForTimeout(WAIT_MS);

        const collectCount = reqs.length;
        const pageViews = countPageViews(reqs);
        const pass = pageViews === 1;
        if (collectCount > 0) anyCollect = true;
        console.log(`collectReqs=${collectCount} pageViews=${pageViews} ${pass ? "PASS" : "FAIL"}`);
        results.push({ url, load: i, collectCount, pageViews, pass });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  const allPass = results.every((r) => r.pass);

  console.log("\n=== summary ===");
  for (const r of results) {
    const status = r.pass ? "OK " : "BAD";
    console.log(
      `  ${status} pv=${r.pageViews} collect=${r.collectCount}  ${r.url} (load ${r.load})`
    );
  }

  if (!anyCollect) {
    console.log(
      "\nINCONCLUSIVE: no GA4 collect requests captured. GA may be blocked, env may be wrong, or NEXT_PUBLIC_GA_ID is unset."
    );
    process.exit(2);
  }
  console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
