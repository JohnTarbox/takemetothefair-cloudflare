export const dynamic = "force-dynamic";
/**
 * OPE-294 — move venue imagery off borrowed hosts and onto bytes we own.
 *
 * 172 of 177 venue images are Google Places photos hotlinked from
 * `lh3.googleusercontent.com`, all written by one line in
 * `venues/google-backfill/route.ts` (now gated behind
 * `ALLOW_GOOGLE_PLACES_PHOTOS`, shipped unset, so the population is flat:
 * 172 on 08-18 and 172 on 08-31).
 *
 * John's ruling, 2026-08-27:
 *   1. Google Places photos stay OFF — do not store or hotlink them.
 *   2. The existing hotlinks come off. Replace where owned bytes can be
 *      sourced; **clear `image_url` to null** where they cannot. Never
 *      substitute a different third-party image — clear or hold, never guess.
 *   3. No attribution surface — moot, since the photos are not being kept.
 *   4. No rush-delete. The flag-off already stopped the growth.
 *
 * The events sweep could not be reused: it iterates `events`, keys off
 * `source_url`, and re-hosts under `events/`. Venues have `website` instead and
 * are a different table. What IS reused is every judgement in `@/lib/og-image`
 * — the same fetch, the same og:image extraction, the same quality gate — so
 * the two sweeps cannot disagree about what makes an acceptable image.
 *
 * ── Why clearing is behind its own flag ──────────────────────────────────
 * "No rush-delete" is a real constraint, and this route honours it by
 * separating the two acts. A default run only ever REPLACES: a venue whose
 * website is briefly down keeps its image and is retried next run. Clearing —
 * which destroys the only image a venue page has — happens only when the
 * operator passes `clear_unsourceable`, after the replace passes have run and
 * `held` has stopped shrinking. Folding the two together would mean one
 * timeout permanently blanked a venue page.
 *
 * A cleared row is not a loss to be recovered later: null is a truer state than
 * a borrowed image, and the og:image path can fill it with owned bytes when one
 * becomes available.
 *
 * Auth: admin session OR X-Internal-Key, matching the events sweep.
 */
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { recordMutation } from "@/lib/audit/record-mutation";
import {
  acceptCandidateImage,
  extensionForContentType,
  extractOgImage,
  fetchPageHtml,
  urlLooksLikeJunk,
} from "@/lib/og-image";
import { classifyImageHost } from "@takemetothefair/utils";
import { borrowedVenueImagePredicate } from "@/lib/images/borrowed";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const CDN_BASE = "https://cdn.meetmeatthefair.com";
const IMAGE_FETCH_TIMEOUT_MS = 20_000;

interface VenueOutcome {
  venue_id: string;
  slug: string;
  previous_host: string | null;
  was_google_places: boolean;
  outcome:
    | "replaced"
    | "would_replace"
    | "cleared"
    | "would_clear"
    /** Borrowed, unsourceable, and deliberately left alone this run. */
    | "held"
    | "skipped_owned_image"
    | "skipped_no_website"
    | "skipped_r2_failed";
  image_url?: string;
  reason?: string;
}

export const GET = withAuthorized(async ({ db }) => {
  const rows = await db
    .select({ id: venues.id, imageUrl: venues.imageUrl, website: venues.website })
    .from(venues)
    .where(borrowedVenueImagePredicate());

  // Counted in TypeScript against the real classifier rather than in SQL, so
  // this number and the number the POST acts on cannot disagree.
  let borrowed = 0;
  let googlePlaces = 0;
  let sourceable = 0;
  for (const r of rows) {
    const verdict = classifyImageHost(r.imageUrl);
    if (verdict.kind !== "third_party") continue;
    borrowed += 1;
    if (verdict.isGooglePlaces) googlePlaces += 1;
    if ((r.website ?? "").trim() !== "") sourceable += 1;
  }

  return NextResponse.json({
    borrowed,
    google_places: googlePlaces,
    other_third_party: borrowed - googlePlaces,
    /** Have a website to try an og:image against. The rest can only be held or cleared. */
    sourceable,
    unsourceable: borrowed - sourceable,
  });
});

export const POST = withAuthorized(async ({ request, db, userId }) => {
  const env = getCloudflareEnv() as unknown as { VENDOR_ASSETS?: R2Bucket };
  const actorId = userId ?? "internal";

  let body: { apply?: boolean; limit?: number; offset?: number; clear_unsourceable?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body is a dry run of the default page — the safest reading.
  }

  const apply = body.apply === true;
  const clearUnsourceable = body.clear_unsourceable === true;
  const limit = Math.min(Math.max(body.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  // Failures are not marked (venues carry no attempted-at column), so without
  // an offset a run would retry the same leading unsourceable rows forever and
  // never reach the tail. Paging is the operator's, deliberately: it keeps a
  // retry cheap for the transient case, which is the whole point of `held`.
  const offset = Math.max(body.offset ?? 0, 0);

  const candidates = await db
    .select({
      id: venues.id,
      slug: venues.slug,
      name: venues.name,
      imageUrl: venues.imageUrl,
      website: venues.website,
    })
    .from(venues)
    .where(borrowedVenueImagePredicate())
    .orderBy(asc(venues.id))
    .limit(limit)
    .offset(offset);

  const outcomes: VenueOutcome[] = [];

  for (const v of candidates) {
    const verdict = classifyImageHost(v.imageUrl);
    const base = {
      venue_id: v.id,
      slug: v.slug,
      previous_host: verdict.host,
      was_google_places: verdict.isGooglePlaces,
    };

    if (verdict.kind !== "third_party") {
      outcomes.push({ ...base, outcome: "skipped_owned_image", reason: v.imageUrl ?? "" });
      continue;
    }

    const website = (v.website ?? "").trim();

    // ── Try to source owned bytes ────────────────────────────────────
    let sourced: { url: string; contentType: string; source: string } | null = null;
    if (website) {
      const html = await fetchPageHtml(website);
      const candidate = html ? extractOgImage(html, website) : null;
      if (candidate && !urlLooksLikeJunk(candidate.url)) {
        const gate = await acceptCandidateImage(candidate.url);
        if (gate.ok) {
          sourced = {
            url: candidate.url,
            contentType: gate.contentType,
            source: candidate.source,
          };
        }
      }
    }

    // ── Nothing to replace it with ───────────────────────────────────
    if (!sourced) {
      const reason = website ? "no acceptable og:image on the venue website" : "no website";
      if (!clearUnsourceable) {
        outcomes.push({
          ...base,
          outcome: website ? "held" : "skipped_no_website",
          reason: `${reason} — held, not cleared (pass clear_unsourceable to clear)`,
        });
        continue;
      }
      if (!apply) {
        outcomes.push({ ...base, outcome: "would_clear", reason });
        continue;
      }
      // The ruling's explicit instruction: clear to null, never substitute.
      //
      // Audited, and this is the write that most needs it: it destroys the only
      // image a venue page has, and the OPE-433 specimen is a production venue
      // that changed at 04:00:20Z with the candidate causes indistinguishable
      // from the evidence. Six weeks from now "why did this venue lose its
      // photo?" must be answerable from the row, not reconstructed.
      await db.update(venues).set({ imageUrl: null }).where(eq(venues.id, v.id));
      await recordMutation(db, {
        entityType: "venue",
        entityId: v.id,
        verb: "update",
        actor: `venue-image-heal:${actorId}`,
        before: { imageUrl: v.imageUrl },
        after: { imageUrl: null },
        note: `OPE-294 cleared borrowed image from ${verdict.host ?? "unknown host"} — ${reason}`,
      });
      outcomes.push({ ...base, outcome: "cleared", reason });
      continue;
    }

    if (!apply) {
      outcomes.push({
        ...base,
        outcome: "would_replace",
        image_url: sourced.url,
        reason: `${sourced.source} · ${sourced.contentType}`,
      });
      continue;
    }

    // ── Apply: download → R2 → point the row at bytes we own ─────────
    const ext = extensionForContentType(sourced.contentType);
    const bucket = env.VENDOR_ASSETS;
    if (!ext || !bucket) {
      outcomes.push({
        ...base,
        outcome: "skipped_r2_failed",
        reason: !bucket
          ? "VENDOR_ASSETS binding missing"
          : `no_extension_for_${sourced.contentType}`,
      });
      continue;
    }

    let bytes: ArrayBuffer;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(sourced.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!res.ok) {
        outcomes.push({ ...base, outcome: "held", reason: `download HTTP ${res.status}` });
        continue;
      }
      bytes = await res.arrayBuffer();
    } catch (e) {
      outcomes.push({
        ...base,
        outcome: "held",
        reason: `download failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    } finally {
      clearTimeout(timer);
    }

    const key = `venues/${v.id}/og-${Date.now()}.${ext}`;
    try {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: sourced.contentType },
        customMetadata: {
          uploadedBy: actorId,
          source: "venue-image-heal",
          originUrl: sourced.url,
          replacedHost: verdict.host ?? "",
        },
      });
    } catch (e) {
      outcomes.push({
        ...base,
        outcome: "skipped_r2_failed",
        reason: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    const cdnUrl = `${CDN_BASE}/${key}`;
    try {
      await db.update(venues).set({ imageUrl: cdnUrl }).where(eq(venues.id, v.id));
      // Audited too, though it is the benign direction: it still changes what a
      // public page shows, and an audit trail with only the destructive half
      // recorded cannot answer "when did this venue's image last change?".
      await recordMutation(db, {
        entityType: "venue",
        entityId: v.id,
        verb: "update",
        actor: `venue-image-heal:${actorId}`,
        before: { imageUrl: v.imageUrl },
        after: { imageUrl: cdnUrl },
        note: `OPE-294 re-hosted ${verdict.host ?? "unknown host"} image as owned bytes from ${sourced.url}`,
      });
    } catch (e) {
      // R2 holds the object but the row still points at the borrowed host.
      // Loud, because the next run will re-download and re-upload it.
      await logError(db, {
        message: "venue-image-heal: DB update failed (R2 has the file)",
        error: e,
        source: "venue-image-heal",
        context: { venueId: v.id, key, candidateUrl: sourced.url },
      });
      outcomes.push({ ...base, outcome: "skipped_r2_failed", reason: "db_update_failed" });
      continue;
    }

    outcomes.push({
      ...base,
      outcome: "replaced",
      image_url: cdnUrl,
      reason: `${sourced.source} · ${sourced.contentType}`,
    });
  }

  const summary = {
    apply,
    clear_unsourceable: clearUnsourceable,
    offset,
    scanned: candidates.length,
    by_outcome: outcomes.reduce<Record<string, number>>((acc, o) => {
      acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
      return acc;
    }, {}),
  };

  return NextResponse.json({ summary, outcomes });
});
