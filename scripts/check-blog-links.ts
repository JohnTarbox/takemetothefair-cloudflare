#!/usr/bin/env tsx
/**
 * Scans every published blog post body for /blog/<slug> references and
 * validates them against the set of known slugs in production D1. Exits
 * non-zero if any broken links are found so this can be wired into CI later.
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

// Same regex as src/lib/blog-links.ts — kept in lockstep.
const BLOG_LINK_RE = /\/blog\/([a-z0-9][a-z0-9-]*)(?=[^a-z0-9-]|$)/gi;

function extractBlogLinks(body: string | null | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(BLOG_LINK_RE.source, BLOG_LINK_RE.flags);
  while ((match = re.exec(body)) !== null) {
    const slug = match[1].toLowerCase();
    if (slug) found.add(slug);
  }
  return Array.from(found);
}

async function main() {
  const includeDrafts = process.argv.includes("--all");
  const filter = includeDrafts ? "" : "WHERE status = 'PUBLISHED'";

  console.log("→ Loading blog posts from production D1 …");
  const posts = await d1Query<{ slug: string; title: string; body: string | null }>(
    `SELECT slug, title, body FROM blog_posts ${filter}`
  );
  console.log(`  ${posts.length} post${posts.length === 1 ? "" : "s"}`);

  const knownSlugs = new Set(posts.map((p) => p.slug.toLowerCase()));

  let total = 0;
  const brokenByPost: Array<{ slug: string; title: string; broken: string[] }> = [];

  for (const post of posts) {
    const referenced = extractBlogLinks(post.body);
    const broken = referenced.filter((s) => !knownSlugs.has(s));
    if (broken.length > 0) {
      brokenByPost.push({ slug: post.slug, title: post.title, broken });
      total += broken.length;
    }
  }

  if (brokenByPost.length === 0) {
    console.log("✓ No broken /blog/ links.");
    return;
  }

  console.log(
    `\n✗ Found ${total} broken link${total === 1 ? "" : "s"} across ${brokenByPost.length} post${brokenByPost.length === 1 ? "" : "s"}:\n`
  );
  for (const p of brokenByPost) {
    console.log(`  /blog/${p.slug}  (${p.title})`);
    for (const bad of p.broken) {
      console.log(`    → /blog/${bad}  ← missing`);
    }
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("Error running check:", err);
  process.exit(2);
});
