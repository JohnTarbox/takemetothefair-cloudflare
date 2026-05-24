#!/usr/bin/env tsx
/**
 * Scans every published blog post body for internal-link slug references
 * and validates them against live rows in production D1. Covers all four
 * content-link target types: BLOG_POST (/blog/<slug>), EVENT (/events/),
 * VENDOR (/vendors/), VENUE (/venues/). Exits non-zero if any broken
 * links are found so this can be wired into CI later.
 *
 * Drives the analyst's 2026-05-24 ask: "A lightweight scheduled check
 * that audits published post bodies for unresolvable internal links
 * would also catch drift." Previously /blog/-only; extended here to
 * catch the four observed broken-link patterns (prefix-suffix year swap,
 * fabricated name-venue slugs, ordinal prefixes, singular-path typos).
 *
 * Usage:
 *   npx tsx scripts/check-blog-links.ts            # published only
 *   npx tsx scripts/check-blog-links.ts --all      # include drafts
 */

import { spawn } from "node:child_process";

function runWrangler(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "wrangler",
      "d1",
      "execute",
      "takemetothefair-db",
      "--remote",
      "--json",
      "--command",
      sql,
    ];
    const proc = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (c) => chunks.push(c as Buffer));
    proc.stderr.on("data", (c) => errChunks.push(c as Buffer));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } else {
        reject(new Error(`wrangler exited ${code}: ${Buffer.concat(errChunks).toString("utf8")}`));
      }
    });
  });
}

async function d1Query<T = unknown>(sql: string): Promise<T[]> {
  const stdout = await runWrangler(sql);
  const parsed = JSON.parse(stdout) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

// Same regex as src/lib/blog-links.ts — kept in lockstep. Captures the
// canonical URL prefix and the slug it routes to.
const CONTENT_LINK_RE = /\/(events|vendors|venues|blog)\/([a-z0-9][a-z0-9-]*)(?=[^a-z0-9-]|$)/gi;

// Same filter as src/lib/constants.ts EVENT_LISTING_SLUGS. Static
// /events/<sub-route> pages that look like event slugs but aren't.
const EVENT_LISTING_SLUGS = new Set([
  "all",
  "past",
  "maine",
  "vermont",
  "new-hampshire",
  "massachusetts",
  "connecticut",
  "rhode-island",
  "fairs",
  "festivals",
  "craft-shows",
  "craft-fairs",
  "markets",
  "farmers-markets",
]);

type TargetType = "EVENT" | "VENDOR" | "VENUE" | "BLOG_POST";
interface Ref {
  targetType: TargetType;
  targetSlug: string;
}

function extractContentLinks(body: string | null | undefined): Ref[] {
  if (!body) return [];
  const seen = new Set<string>();
  const out: Ref[] = [];
  const re = new RegExp(CONTENT_LINK_RE.source, CONTENT_LINK_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const kind = m[1].toLowerCase();
    const slug = m[2].toLowerCase();
    if (!slug) continue;
    if (kind === "events" && EVENT_LISTING_SLUGS.has(slug)) continue;
    const targetType: TargetType =
      kind === "events"
        ? "EVENT"
        : kind === "vendors"
          ? "VENDOR"
          : kind === "venues"
            ? "VENUE"
            : "BLOG_POST";
    const key = `${targetType}|${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ targetType, targetSlug: slug });
  }
  return out;
}

async function loadLiveSlugs(): Promise<Record<TargetType, Set<string>>> {
  const [eventRows, vendorRows, venueRows, blogRows] = await Promise.all([
    d1Query<{ slug: string }>("SELECT slug FROM events"),
    d1Query<{ slug: string }>("SELECT slug FROM vendors WHERE deleted_at IS NULL"),
    d1Query<{ slug: string }>("SELECT slug FROM venues"),
    d1Query<{ slug: string }>("SELECT slug FROM blog_posts"),
  ]);
  return {
    EVENT: new Set(eventRows.map((r) => r.slug.toLowerCase())),
    VENDOR: new Set(vendorRows.map((r) => r.slug.toLowerCase())),
    VENUE: new Set(venueRows.map((r) => r.slug.toLowerCase())),
    BLOG_POST: new Set(blogRows.map((r) => r.slug.toLowerCase())),
  };
}

async function loadSlugHistory(): Promise<Set<string>> {
  // PR #223 added blog_slug_history; an earlier PR added event_slug_history.
  // Old slugs that 301 to a new one shouldn't count as broken — the
  // middleware will redirect on visit. Tables may not exist in older
  // envs; treat absence as "no history" rather than failing the audit.
  try {
    const [blogHist, eventHist] = await Promise.all([
      d1Query<{ old_slug: string }>("SELECT old_slug FROM blog_slug_history"),
      d1Query<{ old_slug: string }>("SELECT old_slug FROM event_slug_history"),
    ]);
    const out = new Set<string>();
    for (const r of blogHist) out.add(`BLOG_POST|${r.old_slug.toLowerCase()}`);
    for (const r of eventHist) out.add(`EVENT|${r.old_slug.toLowerCase()}`);
    return out;
  } catch {
    return new Set();
  }
}

async function main() {
  const includeDrafts = process.argv.includes("--all");
  const filter = includeDrafts ? "" : "WHERE status = 'PUBLISHED'";

  console.log("→ Loading blog posts from production D1 …");
  const posts = await d1Query<{ slug: string; title: string; body: string | null }>(
    `SELECT slug, title, body FROM blog_posts ${filter}`
  );
  console.log(`  ${posts.length} post${posts.length === 1 ? "" : "s"}`);

  console.log("→ Loading live entity slugs (events / vendors / venues / blog posts) …");
  const live = await loadLiveSlugs();
  const redirectableSlugs = await loadSlugHistory();
  console.log(
    `  events=${live.EVENT.size}, vendors=${live.VENDOR.size}, venues=${live.VENUE.size}, blog=${live.BLOG_POST.size}`
  );
  if (redirectableSlugs.size > 0) {
    console.log(`  ${redirectableSlugs.size} slug(s) covered by slug-history (will 301, not 404)`);
  }

  let total = 0;
  const brokenByPost: Array<{ slug: string; title: string; broken: Ref[] }> = [];

  for (const post of posts) {
    const referenced = extractContentLinks(post.body);
    const broken = referenced.filter((r) => {
      const key = `${r.targetType}|${r.targetSlug}`;
      if (redirectableSlugs.has(key)) return false;
      return !live[r.targetType].has(r.targetSlug);
    });
    if (broken.length > 0) {
      brokenByPost.push({ slug: post.slug, title: post.title, broken });
      total += broken.length;
    }
  }

  if (brokenByPost.length === 0) {
    console.log("✓ No broken internal links.");
    return;
  }

  console.log(
    `\n✗ Found ${total} broken link${total === 1 ? "" : "s"} across ${brokenByPost.length} post${brokenByPost.length === 1 ? "" : "s"}:\n`
  );
  const pathByType: Record<TargetType, string> = {
    EVENT: "/events/",
    VENDOR: "/vendors/",
    VENUE: "/venues/",
    BLOG_POST: "/blog/",
  };
  for (const p of brokenByPost) {
    console.log(`  /blog/${p.slug}  (${p.title})`);
    for (const bad of p.broken) {
      console.log(`    → ${pathByType[bad.targetType]}${bad.targetSlug}  ← missing`);
    }
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("Error running check:", err);
  process.exit(2);
});
