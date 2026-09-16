export const dynamic = "force-dynamic";
/**
 * OPE-227 increment A — stage hero-image PROPOSALS for the most-seen imageless
 * event pages. Writes `admin_actions` rows and R2 objects under
 * `events/<id>/proposed/`; never writes `events.image_url`.
 *
 * Auth: admin session OR X-Internal-Key (the daily MCP cron, increment C).
 * `?limit=` 1–10 (default 10). `?dry_run=true` returns the selection only —
 * no fetches, no writes — so an operator can see what the next run would look
 * at before it does.
 *
 * See `src/lib/photo-flywheel/hero-proposals.ts` for the rail and the ruling it
 * implements.
 */
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { urlDomainClassifications } from "@/lib/db/schema";
import { acceptCandidateImage } from "@/lib/og-image";
import { fetchHtmlWithSsrfGuard, isBlockedSsrfHost } from "@takemetothefair/site-fetch";
import {
  MAX_PER_CALL,
  proposeEventHeroes,
  selectHeroCandidates,
  type HeroProposalDeps,
} from "@/lib/photo-flywheel/hero-proposals";

const PAGE_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 20_000;
/** Mirrors the upload pipeline's cap; a bigger og:image is not a hero we can use. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_UA = "MeetMeAtTheFair/1.0 (+https://meetmeatthefair.com)";

function hostAllowed(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return (u.protocol === "https:" || u.protocol === "http:") && !isBlockedSsrfHost(u.hostname);
  } catch {
    return false;
  }
}

export const POST = withAuthorized(async ({ request, db, userId }) => {
  const env = getCloudflareEnv();
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") || `${MAX_PER_CALL}`, 10) || MAX_PER_CALL),
    MAX_PER_CALL
  );
  const dryRun = url.searchParams.get("dry_run") === "true";
  const now = new Date();

  const candidates = await selectHeroCandidates(db, limit, now);
  if (dryRun) {
    return NextResponse.json({ dry_run: true, selected: candidates.length, candidates });
  }

  const bucket = env.VENDOR_ASSETS;
  if (!bucket) {
    return NextResponse.json({ error: "VENDOR_ASSETS binding missing" }, { status: 500 });
  }

  const classificationRows = await db
    .select({
      domain: urlDomainClassifications.domain,
      useAsTicketUrl: urlDomainClassifications.useAsTicketUrl,
      useAsApplicationUrl: urlDomainClassifications.useAsApplicationUrl,
      useAsSource: urlDomainClassifications.useAsSource,
    })
    .from(urlDomainClassifications);
  const classMap = new Map(
    classificationRows.map((r) => [
      r.domain,
      {
        useAsTicketUrl: r.useAsTicketUrl,
        useAsApplicationUrl: r.useAsApplicationUrl,
        useAsSource: r.useAsSource,
      },
    ])
  );

  const deps: HeroProposalDeps = {
    async fetchHtml(pageUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
      try {
        const res = await fetchHtmlWithSsrfGuard(pageUrl, controller.signal);
        return res.ok ? res.html : null;
      } finally {
        clearTimeout(timer);
      }
    },
    async acceptCandidate(imageUrl) {
      // The quality gate issues HEAD + Range requests to this URL, so the
      // candidate's host is SSRF-checked first — it came from a third-party page.
      if (!hostAllowed(imageUrl))
        return { ok: false, reason: "junk_url_pattern", detail: "blocked host" };
      return acceptCandidateImage(imageUrl);
    },
    async downloadImage(imageUrl) {
      if (!hostAllowed(imageUrl)) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
      try {
        const res = await fetch(imageUrl, {
          headers: { "User-Agent": IMAGE_UA },
          signal: controller.signal,
          redirect: "manual",
        });
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        return bytes.byteLength > MAX_IMAGE_BYTES ? null : bytes;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    async putObject(key, bytes, contentType, metadata) {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType },
        customMetadata: { ...metadata, uploadedBy: userId ?? "internal" },
      });
    },
    now: () => now,
  };

  const outcomes = await proposeEventHeroes(db, deps, candidates, classMap, userId ?? "internal");
  const byOutcome = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({
    selected: candidates.length,
    proposed: byOutcome.proposed ?? 0,
    by_outcome: byOutcome,
    outcomes,
  });
});
