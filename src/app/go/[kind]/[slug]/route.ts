export const dynamic = "force-dynamic";
/**
 * OPE-1496 — `GET|HEAD /go/<apply|tickets>/<event-slug>?c=&s=&m=&l=`
 *
 * Logs a newsletter click on an off-site Apply / ticket button first-party,
 * then 302s to the destination stored on the EVENT. The request can only name
 * an event, never a URL — there is no open redirect to sign against.
 *
 * Contract (pinned by the tests):
 *  - always a 302 (never 301: a cached redirect would skip the log next time),
 *    `Cache-Control: no-store`, `X-Robots-Tag: noindex`; `/go/` is disallowed
 *    in robots.txt as well;
 *  - retired slugs resolve through event_slug_history, as event pages do;
 *  - unknown / non-public event → 302 to /events, logged `resolved: false`;
 *  - the log write runs in `waitUntil` and can fail without touching the
 *    redirect.
 */
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventSlugHistory, promoters } from "@/lib/db/schema";
import { isPubliclyVisible, type EventLifecycle } from "@/lib/event-lifecycle";
import { trackServerEvent } from "@/lib/server-analytics";
import {
  parseGaClientId,
  safeHostname,
  sendGa4MeasurementProtocol,
} from "@/lib/ga4-measurement-protocol";
import { classifyDevice } from "@/lib/analytics/funnel-steps";
import {
  classifyGoRequest,
  goEventName,
  isGoKind,
  readGoParams,
  resolveGoDestination,
  type GoEventRow,
  type GoKind,
  type ResolvedFrom,
} from "@/lib/go-redirect";
import { unsafeSlug } from "@/lib/utils";

const MAX_SLUG_HOPS = 5;

function redirect(url: string): NextResponse {
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

type Db = ReturnType<typeof getCloudflareDb>;

async function selectEvent(db: Db, slug: string) {
  const [row] = await db
    .select({
      slug: events.slug,
      status: events.status,
      lifecycleStatus: events.lifecycleStatus,
      applicationUrl: events.applicationUrl,
      ticketUrl: events.ticketUrl,
      sourceUrl: events.sourceUrl,
      promoterWebsite: promoters.website,
    })
    .from(events)
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(eq(events.slug, unsafeSlug(slug)))
    .limit(1);
  return row ?? null;
}

/** The event at `slug`, following event_slug_history (max 5 hops) when no
 *  event holds that slug today. Null when nothing public is at the end. */
async function findPublicEvent(db: Db, slug: string): Promise<GoEventRow | null> {
  let row = await selectEvent(db, slug);
  if (!row) {
    let cursor = slug;
    const seen = new Set([cursor]);
    for (let hop = 0; hop < MAX_SLUG_HOPS; hop++) {
      const [h] = await db
        .select({ newSlug: eventSlugHistory.newSlug })
        .from(eventSlugHistory)
        .where(eq(eventSlugHistory.oldSlug, unsafeSlug(cursor)))
        .orderBy(desc(eventSlugHistory.changedAt))
        .limit(1);
      if (!h || seen.has(h.newSlug)) break;
      cursor = h.newSlug;
      seen.add(cursor);
    }
    if (cursor !== slug) row = await selectEvent(db, cursor);
  }
  if (!row || !isPubliclyVisible(row.status, row.lifecycleStatus as EventLifecycle)) return null;
  return {
    slug: row.slug,
    applicationUrl: row.applicationUrl,
    ticketUrl: row.ticketUrl,
    sourceUrl: row.sourceUrl,
    promoterWebsite: row.promoterWebsite,
  };
}

function schedule(work: Promise<unknown>): void {
  const guarded = work.catch(() => {});
  try {
    getCloudflareContext().ctx.waitUntil(guarded);
  } catch {
    // No request context (tests, local dev): the promise still runs.
  }
}

async function handle(
  request: Request,
  { params }: { params: Promise<{ kind: string; slug: string }> }
): Promise<NextResponse> {
  const { kind, slug: rawSlug } = await params;
  const url = new URL(request.url);
  const origin = url.origin;
  const slug = rawSlug.trim().toLowerCase();

  if (!isGoKind(kind)) return redirect(`${origin}/events`);
  const goKind: GoKind = kind;

  let db: Db | null = null;
  let event: GoEventRow | null = null;
  try {
    db = getCloudflareDb();
    event = await findPublicEvent(db, slug);
  } catch {
    // A failed lookup still sends the reader somewhere useful; logged below.
  }

  let destinationUrl: string;
  let resolvedFrom: ResolvedFrom;
  if (event) {
    ({ url: destinationUrl, resolvedFrom } = resolveGoDestination(goKind, event, origin));
  } else {
    destinationUrl = `${origin}/events`;
    resolvedFrom = "events_index";
  }

  const ua = request.headers.get("user-agent");
  const { uaClass, uaReason } = classifyGoRequest({
    method: request.method,
    userAgent: ua,
    purpose: request.headers.get("sec-purpose") ?? request.headers.get("purpose"),
  });
  const { device, os } = classifyDevice(ua);
  const goParams = readGoParams(url.searchParams);
  const eventName = goEventName(goKind, uaClass);

  schedule(
    trackServerEvent(db, {
      eventName,
      eventCategory: "conversion",
      source: "redirect",
      properties: {
        eventSlug: event?.slug ?? slug,
        destinationUrl,
        resolvedFrom,
        resolved: event !== null,
        campaign: goParams.campaign,
        trafficSource: goParams.trafficSource,
        trafficMedium: goParams.trafficMedium,
        linkLabel: goParams.linkLabel,
        ua_class: uaClass,
        ...(uaReason ? { ua_reason: uaReason } : {}),
        device,
        os,
      },
    })
  );

  // Same server-side GA4 mirror the on-site beacon sends (ENG1.8), for a
  // person's resolved click only — a scanner hit is not a conversion.
  if (uaClass === "human" && event) {
    const clientId = parseGaClientId(request.headers.get("cookie")) ?? crypto.randomUUID();
    schedule(
      sendGa4MeasurementProtocol(clientId, [
        {
          name: `${eventName}_server`,
          params: {
            transport: "server",
            target_url: destinationUrl,
            target_domain: safeHostname(destinationUrl),
            entity_type: "event",
            entity_id: event.slug,
            application_or_ticket: goKind === "apply" ? "application" : "ticket",
          },
        },
      ])
    );
  }

  return redirect(destinationUrl);
}

export const GET = handle;
export const HEAD = handle;
