/**
 * `submit@` legs — orchestrated by InboundEmailWorkflow as three
 * separate `step.do` calls so each external API failure is checkpointed
 * independently.
 *
 * Why split: the previous single `step.do("dispatch")` re-ran fetch +
 * AI extract on every retry of the submit step. With Workers AI at the
 * 20s end of the latency distribution, repeating that work on a transient
 * submit-endpoint blip costs real money. After this split:
 *
 *   submit/fetch-url   → fetched content (cached on retry)
 *   submit/ai-extract  → extracted event JSON (cached on retry)
 *   submit/submit-event → POST /api/suggest-event/submit
 *
 * Failure semantics (the workflow's run() catches and maps to reply kinds):
 *   - 4xx fetch / extract / submit          → NonRetryableError prefixed
 *                                             "fetch-", "extract-", "submit-"
 *   - 5xx / network on fetch / submit       → plain Error, step retries
 *   - AI extract failure (any cause)        → NonRetryableError — audit
 *                                             showed Workers AI load
 *                                             timeouts don't recover on
 *                                             tight retries; one shot only
 *
 * The missing-URL case is handled in the workflow BEFORE calling
 * submitFetch (no throw, just early return with replyKind: "no-url").
 */

import { NonRetryableError } from "cloudflare:workflows";
import type { HandlerEnv } from "./types.js";

const SOURCE_FETCH = "mcp:email-handler:extract:fetch";
const SOURCE_EXTRACT = "mcp:email-handler:extract:ai";
const SOURCE_DEDUP = "mcp:email-handler:check-duplicate";
const SOURCE_SUBMIT = "mcp:email-handler:submit";

/** Cap the fetched content stored as step output. CF Workflows allows
 *  1 MiB per step output but smaller is better — and the AI prompt
 *  already caps below this. 100 KB is well under both. */
const MAX_FETCH_CONTENT_LEN = 100_000;

/**
 * Step output shape. The workflow's `Serializable<T>` constraint trips
 * on `unknown` and recursive JsonValue types (TS2589: type instantiation
 * excessively deep), so JSON-LD is forwarded as a serialized string and
 * parsed back in submitExtract. Round-trip is cheap; the alternative was
 * keeping the field out of the step boundary entirely, but the AI prompt
 * benefits from it for higher-accuracy extraction.
 */
export interface SubmitFetchResult {
  url: string;
  content: string;
  title: string | null;
  description: string | null;
  ogImage: string | null;
  /** JSON-stringified `jsonLd`, or null if the page had none. */
  jsonLdSerialized: string | null;
  /** Which fetch path the main app used. `'standard'` for the cheap path,
   *  `'browser-rendering'` for the Cloudflare Browser Rendering escalation
   *  on 401/403/429/timeout. Forwarded to workflow's mark-done step which
   *  persists it to inbound_emails.fetch_method (drizzle/0078). */
  fetchMethod: "standard" | "browser-rendering";
}

export interface SubmitExtractResult {
  /** URL the event came from. Empty string in the B2 free-text path
   *  where there's no source URL — the workflow's submit-event leg
   *  omits sourceUrl from the API call in that case. */
  url: string;
  event: ExtractedEvent;
  /** Per-field confidence from the extract endpoint, keyed by field
   *  name ("name", "startDate", "venueName", ...). Used by the workflow
   *  to pick HIGH/MEDIUM/LOW reply tier (B3). Sparsely populated —
   *  fields the extractor didn't return are simply absent. */
  fieldConfidence?: Record<string, "high" | "medium" | "low">;
  /** Which extraction strategy produced the event:
   *  - 'json-ld'    — page's schema.org Event JSON-LD was complete enough
   *                   to skip the AI call entirely (PR-B path).
   *  - 'ai'         — fetch-then-AI-extract on a URL (default path).
   *  - 'free-text'  — no URL; body text fed directly to AI (PR-E B2 path).
   *  Forwarded to the workflow's mark-done step which persists it to
   *  inbound_emails.extraction_method (drizzle/0083). */
  extractionMethod: "json-ld" | "ai" | "free-text";
}

/**
 * Strip the most common sender-signature blocks before feeding body text
 * to AI extraction. Signature lines confuse the extractor — it'll happily
 * pull "Bob Smith\nbob@example.com" into the event description if the
 * body is short. Two cuts:
 *
 *   1. Standard RFC 3676 signature delimiter: "-- " on its own line
 *      (trailing space optional per Gmail/Apple Mail practice).
 *   2. iOS/Android/Outlook default signatures. Cut from match onward.
 *
 * Conservative on purpose — a false cut on legitimate event text is worse
 * than leaving a few signature lines in. The 3000-char body cap upstream
 * limits the damage either way.
 *
 * Exported for unit tests.
 */
export function stripSignature(bodyText: string): string {
  let out = bodyText;
  // Cut 1: standard signature delimiter (must be on its own line).
  const sigDelim = out.search(/(^|\n)-- ?(\r?\n|$)/);
  if (sigDelim >= 0) {
    out = out.slice(0, sigDelim);
  }
  // Cut 2: mobile-mailer signatures.
  const mobileSig = out.search(
    /(^|\n)(Sent from my |Get Outlook for |Get the Outlook app|Sent via )/i
  );
  if (mobileSig >= 0) {
    out = out.slice(0, mobileSig);
  }
  return out.trim();
}

export interface SubmitEventResult {
  /** ID of the newly-created event. Workflow writes this to
   *  inbound_emails.resulting_event_id at mark-done. */
  id: string;
  slug: string;
  eventName: string;
}

export interface SubmitCheckDuplicateResult {
  isDuplicate: boolean;
  /** Match type when isDuplicate is true: "exact_url" or "similar_name_date".
   *  Empty when isDuplicate is false. Used by the workflow to pick the right
   *  reply phrasing. */
  matchType?: string;
  /** Existing event's id — workflow persists this as
   *  inbound_emails.resulting_event_id so /admin/inbound-emails can show
   *  "matched against" link without needing a name+date JOIN. */
  existingEventId?: string;
  /** Existing event's display name. Empty when isDuplicate is false. */
  existingEventName?: string;
  /** Existing event's slug — used to build the public URL in the reply. */
  existingEventSlug?: string;
  /** Existing event's status (PENDING | APPROVED | REJECTED | ...).
   *  The "already-exists" reply branches on this: only suggest the public
   *  URL when the matched event is publicly visible (APPROVED). PENDING
   *  matches just say "your submission is already in review" without
   *  linking — the public URL 404s until approval. */
  existingEventStatus?: string;
  /** Existing event's source URL. Passed to the B5 dedup-enrichment
   *  branch (Phase 1 log-only) so the workflow can classify whether the
   *  incoming source is a higher tier than what's already on file.
   *  See src/lib/source-tier.ts for the tier rules. */
  existingEventSourceUrl?: string | null;
}

interface ExtractedEvent {
  name: string;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
  ticketUrl?: string | null;
  imageUrl?: string | null;
  categories?: string[] | null;
  // Recurring / multi-date support. `specificDates` flows from the main-app
  // extract endpoint (either AI-enumerated or cadence-expander-backstop) and
  // the submit endpoint expands it into eventDays rows on its side. Set
  // `discontinuousDates=true` to mark the resulting event row.
  specificDates?: string[] | null;
  discontinuousDates?: boolean;
}

/**
 * Step A: fetch URL via main-app /api/admin/import-url/fetch.
 *
 * Errors:
 *   - 4xx response → NonRetryableError "fetch-${status}"
 *   - upstream {success:false}  → NonRetryableError with upstream message
 *   - 5xx response or network   → plain Error, workflow retries
 */
export async function submitFetch(env: HandlerEnv, url: string): Promise<SubmitFetchResult> {
  let res: Response;
  try {
    res = await fetch(
      `${env.MAIN_APP_URL}/api/admin/import-url/fetch?url=${encodeURIComponent(url)}`,
      { headers: { "x-internal-key": env.INTERNAL_API_KEY } }
    );
  } catch (err) {
    // Network error — retryable
    throw new Error(`fetch-network: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const msg = `fetch-${res.status}`;
    if (res.status >= 400 && res.status < 500) {
      throw new NonRetryableError(msg);
    }
    throw new Error(msg);
  }
  const body = (await res.json().catch(() => null)) as
    | {
        success: true;
        content: string;
        title?: string | null;
        description?: string | null;
        ogImage?: string | null;
        jsonLd?: unknown;
        fetchMethod?: "standard" | "browser-rendering";
      }
    | { success: false; error: string; fetchMethod?: "failed" }
    | null;
  if (!body || !body.success) {
    const upstream = body && "error" in body ? body.error : "no-body";
    throw new NonRetryableError(`fetch-upstream: ${upstream}`);
  }
  return {
    url,
    content: body.content.slice(0, MAX_FETCH_CONTENT_LEN),
    title: body.title ?? null,
    description: body.description ?? null,
    ogImage: body.ogImage ?? null,
    jsonLdSerialized:
      body.jsonLd === undefined || body.jsonLd === null ? null : JSON.stringify(body.jsonLd),
    // Default to 'standard' for the (rare) case where the main app is on an
    // older deploy that doesn't return the field. Better to under-count
    // browser-rendering than fail the workflow.
    fetchMethod: body.fetchMethod ?? "standard",
  };
}

/**
 * Step B: AI extract via main-app /api/admin/import-url/extract.
 *
 * Errors:
 *   - any failure mode → NonRetryableError. Audit doc finding: Workers
 *     AI load-timeouts don't recover on tight retries (same colo, same
 *     overloaded model). One shot, surface the upstream error to the
 *     workflow's catch.
 */
export async function submitExtract(
  env: HandlerEnv,
  fetched: SubmitFetchResult
): Promise<SubmitExtractResult> {
  let res: Response;
  try {
    res = await fetch(`${env.MAIN_APP_URL}/api/admin/import-url/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": env.INTERNAL_API_KEY },
      body: JSON.stringify({
        content: fetched.content,
        url: fetched.url,
        metadata: {
          title: fetched.title,
          description: fetched.description,
          ogImage: fetched.ogImage,
          jsonLd: fetched.jsonLdSerialized ? JSON.parse(fetched.jsonLdSerialized) : null,
        },
      }),
    });
  } catch (err) {
    throw new NonRetryableError(
      `extract-network: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    throw new NonRetryableError(`extract-${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as
    | {
        success: true;
        events: (ExtractedEvent & { _extractId?: string })[];
        count: number;
        confidence?: Record<string, Record<string, "high" | "medium" | "low">>;
        extractionMethod?: "json-ld" | "ai";
      }
    | { success: false; error: string }
    | null;
  if (!body || !body.success || body.events.length === 0) {
    const upstream =
      body && "error" in body ? body.error : body && body.success ? "zero-events" : "no-body";
    throw new NonRetryableError(`extract-upstream: ${upstream}`);
  }
  // Default extractionMethod to 'ai' when the upstream doesn't return the
  // field (older deploy / fallback path). The endpoint returns 'json-ld'
  // when the schema.org bypass triggered. fieldConfidence is keyed by the
  // event's _extractId — sparse when the extractor didn't surface
  // confidence for every field.
  const event = body.events[0];
  const extractId = event._extractId;
  return {
    url: fetched.url,
    event,
    fieldConfidence: extractId && body.confidence ? body.confidence[extractId] : undefined,
    extractionMethod: body.extractionMethod ?? "ai",
  };
}

/**
 * B2: free-text extraction. Called when classifier returned
 * sub_intent='free_text' AND there's no parsedUrl. Calls the same
 * /api/admin/import-url/extract endpoint with body text as content and
 * NO URL — the extractor doesn't care whether content came from a fetch
 * or an email body. Signature is stripped first to keep the AI from
 * dragging signature blocks into the event description.
 *
 * Minimum result (gated in the workflow): event.name + (startDate OR
 * venueName). Below that we fall back to the existing "no-url" reply
 * since we couldn't pull a usable event from the prose.
 *
 * Errors: same NonRetryableError model as submitExtract — Workers AI
 * load timeouts don't recover on tight retries.
 */
export async function submitFreeTextExtract(
  env: HandlerEnv,
  bodyText: string
): Promise<SubmitExtractResult> {
  const stripped = stripSignature(bodyText).slice(0, MAX_FETCH_CONTENT_LEN);
  let res: Response;
  try {
    res = await fetch(`${env.MAIN_APP_URL}/api/admin/import-url/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": env.INTERNAL_API_KEY },
      body: JSON.stringify({
        content: stripped,
        // No URL — extractor handles missing url gracefully (skip
        // ticketUrl fallback that defaults to sourceUrl on AI path).
        metadata: { title: null, description: null, ogImage: null, jsonLd: null },
      }),
    });
  } catch (err) {
    throw new NonRetryableError(
      `extract-network: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    throw new NonRetryableError(`extract-${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as
    | {
        success: true;
        events: (ExtractedEvent & { _extractId?: string })[];
        count: number;
        confidence?: Record<string, Record<string, "high" | "medium" | "low">>;
      }
    | { success: false; error: string }
    | null;
  if (!body || !body.success || body.events.length === 0) {
    const upstream =
      body && "error" in body ? body.error : body && body.success ? "zero-events" : "no-body";
    throw new NonRetryableError(`extract-upstream: ${upstream}`);
  }
  const event = body.events[0];
  const extractId = event._extractId;
  return {
    url: "",
    event,
    fieldConfidence: extractId && body.confidence ? body.confidence[extractId] : undefined,
    extractionMethod: "free-text",
  };
}

/**
 * Step C-pre: duplicate check via main-app /api/suggest-event/submit/
 * check-duplicate. Two-stage detection runs server-side (exact source_url
 * match, then name+date Levenshtein); we just relay the result. Fails
 * OPEN — if the dedup call errors out, we proceed to submit (same risk
 * profile as the pre-2026-05-18 behavior where no dedup ran at all).
 * Failing closed would block all emails while dedup is down.
 *
 * On true duplicate: returns isDuplicate=true with the existing event's
 * slug + name. The workflow short-circuits before submit-event and
 * sends an "already-exists" auto-reply pointing to the existing event.
 */
export async function submitCheckDuplicate(
  env: HandlerEnv,
  extracted: SubmitExtractResult
): Promise<SubmitCheckDuplicateResult> {
  const body: { sourceUrl?: string; name?: string; startDate?: string } = {
    sourceUrl: extracted.url,
  };
  if (extracted.event.name) body.name = extracted.event.name;
  if (extracted.event.startDate) body.startDate = extracted.event.startDate;

  let res: Response;
  try {
    res = await fetch(`${env.MAIN_APP_URL}/api/suggest-event/check-duplicate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": env.INTERNAL_API_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { isDuplicate: false };
  }
  if (!res.ok) {
    return { isDuplicate: false };
  }
  const data = (await res.json().catch(() => null)) as
    | {
        success: true;
        isDuplicate: boolean;
        matchType?: string;
        existingEvent?: {
          id?: string;
          name?: string;
          slug?: string;
          status?: string;
          sourceUrl?: string | null;
        };
      }
    | { success: false; error: string }
    | null;
  if (!data || !data.success || !data.isDuplicate) {
    return { isDuplicate: false };
  }
  return {
    isDuplicate: true,
    matchType: data.matchType,
    existingEventId: data.existingEvent?.id,
    existingEventName: data.existingEvent?.name,
    existingEventSlug: data.existingEvent?.slug,
    existingEventStatus: data.existingEvent?.status,
    existingEventSourceUrl: data.existingEvent?.sourceUrl ?? null,
  };
}

/**
 * Step C: submit via main-app /api/suggest-event/submit.
 *
 * Errors:
 *   - 4xx response → NonRetryableError "submit-${status}"
 *   - 5xx response or network → plain Error, workflow retries
 */
export async function submitEvent(
  env: HandlerEnv,
  extracted: SubmitExtractResult,
  fromAddress: string
): Promise<SubmitEventResult> {
  let res: Response;
  try {
    const submitBody: Record<string, unknown> = {
      ...extracted.event,
      source: "email",
      suggesterEmail: fromAddress,
    };
    // Omit sourceUrl entirely when free-text-extracted (no source URL
    // exists). The submitEventSchema requires sourceUrl to be a valid
    // URL when present, so passing empty-string would fail validation.
    if (extracted.url) {
      submitBody.sourceUrl = extracted.url;
    }
    res = await fetch(`${env.MAIN_APP_URL}/api/suggest-event/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": env.INTERNAL_API_KEY },
      body: JSON.stringify(submitBody),
    });
  } catch (err) {
    throw new Error(`submit-network: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await res.json().catch(() => null)) as
    | { success: true; event: { id: string; slug: string } }
    | { success: false; error: string }
    | null;
  if (!res.ok || !body || !body.success) {
    const upstream = body && "error" in body ? body.error : `submit-${res.status}`;
    if (res.status >= 400 && res.status < 500) {
      throw new NonRetryableError(`submit-${res.status}: ${upstream}`);
    }
    throw new Error(`submit-${res.status}: ${upstream}`);
  }
  return { id: body.event.id, slug: body.event.slug, eventName: extracted.event.name };
}

// SOURCE_* constants exported for the workflow's error-log calls.
export const SUBMIT_SOURCES = {
  fetch: SOURCE_FETCH,
  extract: SOURCE_EXTRACT,
  dedup: SOURCE_DEDUP,
  submit: SOURCE_SUBMIT,
} as const;
