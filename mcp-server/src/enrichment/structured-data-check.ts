/**
 * OPE-1269 — show a reviewer the evidence the extractor actually read.
 *
 * Every one of the 249 eligible vendor-enrichment candidates on 2026-10-02 was
 * extracted from JSON-LD — `<script type="application/ld+json">`, which a
 * browser does not render and every text/markdown fetch tool strips. So a
 * reviewer confirming a value against "the page" is checking a surface that
 * structurally cannot contain it. 5 of a 20-row random sample got false
 * verdicts that way, all in the responsible-looking direction (NOT_FOUND /
 * MISMATCH on a correct value). The specimen: Bay State Savings Bank's
 * `+15088909640` read as a digit transposition of a visible number, when the
 * bank's JSON-LD publishes it as one of ten branch lines.
 *
 * This re-reads the candidate's `source_url` at review time and reports whether
 * the proposed value is present in that page's STRUCTURED data.
 *
 * ## Why re-fetch at review time, not store at mint (the ticket's item 2)
 *
 * All 249 rows already exist, so a snapshot stored at mint would cover none of
 * them. And an approval writes against today's vendor, so "is it still
 * published" is the question that matters at the moment of review. A mint-time
 * snapshot is the right addition for new rows' history; it is not this fix.
 *
 * ## ⚠️ "Could not look" is never "not found"
 *
 * The ticket's second specimen: a page-fetch tool reported ROBOTS_DISALLOWED
 * for a site whose robots.txt merely TIMED OUT, and that row was a clean match.
 * So every outcome is a distinct status, and a fetch failure says so.
 */

export type StructuredDataStatus =
  /** The proposed value is in the page's JSON-LD. */
  | "found"
  /** The page has JSON-LD with values for this field, none matching. */
  | "not_found"
  /** The page has no JSON-LD values for this field at all. */
  | "no_structured_data"
  /** We could not read the page — NOT evidence about the value. */
  | "fetch_failed"
  /** No structured-data comparison exists for this field (e.g. description). */
  | "not_applicable";

export interface StructuredDataCheck {
  status: StructuredDataStatus;
  /** The values for this field the page's JSON-LD carries (capped). */
  values: string[];
  /** Why, in a few words — for fetch_failed, the actual failure. */
  detail: string;
}

const FIELD_KEYS: Record<string, string[]> = {
  contact_phone: ["telephone", "faxNumber"],
  contact_email: ["email"],
  social_links: ["sameAs"],
  // PostalAddress keys, wherever the address node sits (address, location…).
  address: ["streetAddress"],
  city: ["addressLocality"],
  state: ["addressRegion"],
};

function collect(value: unknown, keys: string[], out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collect(v, keys, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(k)) {
      for (const s of Array.isArray(v) ? v : [v]) {
        if (typeof s === "string" && s.trim()) out.push(s.trim());
      }
    } else if (v && typeof v === "object") {
      // contactPoint, department, @graph, location, subOrganization…
      collect(v, keys, out);
    }
  }
}

/** Every value for the field's JSON-LD keys, anywhere in any ld+json block. */
export function structuredDataValues(html: string, field: string): string[] {
  const keys = FIELD_KEYS[field];
  if (!keys) return [];
  const out: string[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      collect(JSON.parse(m[1].trim()), keys, out);
    } catch {
      // a malformed block on the vendor's site is skipped, not fatal
    }
  }
  return [...new Set(out)];
}

/** NANP-aware digits: the last 10 of whatever was written. */
function phoneKey(s: string): string {
  const d = s.replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}

function normalizeUrl(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/** Does `proposed` appear among `values` under the field's own equality? */
export function valueMatches(field: string, proposed: string, values: string[]): boolean {
  if (field === "contact_phone") {
    const p = phoneKey(proposed);
    return p.length >= 7 && values.some((v) => phoneKey(v) === p);
  }
  if (field === "contact_email") {
    const p = proposed
      .trim()
      .toLowerCase()
      .replace(/^mailto:/, "");
    return values.some(
      (v) =>
        v
          .trim()
          .toLowerCase()
          .replace(/^mailto:/, "") === p
    );
  }
  if (field === "social_links") {
    // Stored as a JSON object/array of URLs; every proposed link must be present.
    let links: string[] = [];
    try {
      const parsed = JSON.parse(proposed) as unknown;
      links = Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string")
        : Object.values(parsed as Record<string, unknown>).filter(
            (x): x is string => typeof x === "string"
          );
    } catch {
      links = [proposed];
    }
    const have = new Set(values.map(normalizeUrl));
    return links.length > 0 && links.every((l) => have.has(normalizeUrl(l)));
  }
  // address / city / state: the same text, ignoring case and spacing.
  const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, " ");
  return values.some((v) => norm(v) === norm(proposed));
}

export function checkAgainstHtml(
  field: string,
  proposed: string,
  html: string
): StructuredDataCheck {
  if (!FIELD_KEYS[field]) {
    return { status: "not_applicable", values: [], detail: `no structured-data key for ${field}` };
  }
  const values = structuredDataValues(html, field);
  if (values.length === 0) {
    return {
      status: "no_structured_data",
      values,
      detail: `page has no JSON-LD ${FIELD_KEYS[field].join("/")}`,
    };
  }
  const found = valueMatches(field, proposed, values);
  return {
    status: found ? "found" : "not_found",
    values: values.slice(0, 15),
    detail: found
      ? "proposed value is published in the page's JSON-LD"
      : `page's JSON-LD carries ${values.length} value(s), none equal to the proposal`,
  };
}

/**
 * Fetch `sourceUrl` and check. Bounded by a timeout; a failure of any kind is
 * `fetch_failed` with the cause, never `not_found`.
 */
export async function checkCandidateStructuredData(
  sourceUrl: string,
  field: string,
  proposed: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}
): Promise<StructuredDataCheck> {
  if (!FIELD_KEYS[field]) {
    return { status: "not_applicable", values: [], detail: `no structured-data key for ${field}` };
  }
  const f = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await f(sourceUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: opts.userAgent ? { "User-Agent": opts.userAgent } : undefined,
    });
    if (!res.ok) {
      return { status: "fetch_failed", values: [], detail: `HTTP ${res.status} from source_url` };
    }
    return checkAgainstHtml(field, proposed, await res.text());
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      status: "fetch_failed",
      values: [],
      detail: aborted
        ? "timed out reading source_url"
        : `fetch threw: ${String(err).slice(0, 120)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The note a review row carries when its value came from JSON-LD. */
export const JSONLD_EVIDENCE_NOTE =
  "Extracted from JSON-LD (<script type=application/ld+json>), which a browser does not render and text/markdown fetch tools strip. Checking the visible page is NOT evidence for or against this value — use structured_data_check (pass verify_structured_data: true). And 'found' proves PROVENANCE, not correctness: site templates publish defaults too (a Squarespace site's JSON-LD can carry Squarespace's own social accounts), so a found value still needs the usual is-this-the-right-business judgment.";

/** How many rows one list call may re-fetch. Each is a live HTTP read. */
export const VERIFY_MAX_ROWS = 25;
const VERIFY_CONCURRENCY = 5;

/**
 * Annotate review rows — used by all three list tools (vendor, promoter,
 * performer) so they cannot drift apart. Every jsonld row gets the evidence
 * note; with `verify`, the first VERIFY_MAX_ROWS also get a live check.
 */
export async function annotateForReview<
  T extends {
    field: string;
    proposed_value: string;
    source_url: string;
    extraction_method: string;
  },
>(
  rows: T[],
  verify: boolean,
  opts: { fetchImpl?: typeof fetch; userAgent?: string } = {}
): Promise<
  Array<T & { evidence_note?: string; structured_data_check?: StructuredDataCheck | "not_checked" }>
> {
  const out = rows.map((r) => ({
    ...r,
    ...(r.extraction_method === "jsonld" ? { evidence_note: JSONLD_EVIDENCE_NOTE } : {}),
  })) as Array<
    T & { evidence_note?: string; structured_data_check?: StructuredDataCheck | "not_checked" }
  >;
  if (!verify) return out;

  const targets = out.slice(0, VERIFY_MAX_ROWS);
  for (let i = 0; i < targets.length; i += VERIFY_CONCURRENCY) {
    await Promise.all(
      targets.slice(i, i + VERIFY_CONCURRENCY).map(async (r) => {
        r.structured_data_check = await checkCandidateStructuredData(
          r.source_url,
          r.field,
          r.proposed_value,
          opts
        );
      })
    );
  }
  for (const r of out) if (!r.structured_data_check) r.structured_data_check = "not_checked";
  return out;
}
