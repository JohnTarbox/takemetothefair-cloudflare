/**
 * OPE-29 — derive a human-facing provenance descriptor from an event's
 * `ingestion_method`, so the admin submissions queue can tell bot-found events
 * (daily discovery, web research, aggregator imports, scrapers) apart from
 * genuine human submissions.
 *
 * Why this is needed: the daily-discovery scheduled task authenticates as the
 * admin user, so every event it creates is stamped
 * `submitted_by_user_id = 'admin-user-001'` and renders as "Submitted by Admin
 * User" — identical to a human submission. `ingestion_method` already encodes
 * the real distinction; this maps it to a queue badge.
 *
 * Pure + unit-tested; no DB or UI imports so it stays trivially testable.
 */

export type ProvenanceKind = "bot" | "human" | "system";

/** Badge variant — mirrors the union in `src/components/ui/badge.tsx`. */
export type ProvenanceVariant = "default" | "success" | "warning" | "danger" | "info";

export interface Provenance {
  /** Short label for the queue badge. */
  label: string;
  kind: ProvenanceKind;
  variant: ProvenanceVariant;
}

/**
 * Known `ingestion_method` values (the typed `IngestionMethod` union from
 * `@takemetothefair/utils`, plus `admin_manual`). Unlisted values (e.g.
 * `annual_rollover`, `manual_*`) fall through to a neutral system badge.
 */
const PROVENANCE_BY_METHOD: Record<string, Provenance> = {
  // Machine-found — the events that were silently masquerading as human subs.
  discovery: { label: "Discovery bot", kind: "bot", variant: "info" },
  web_research: { label: "Web research", kind: "bot", variant: "info" },
  aggregator_import: { label: "Aggregator", kind: "bot", variant: "info" },
  direct_scrape: { label: "Scraper", kind: "bot", variant: "info" },
  // Genuine human-origin submissions.
  community_suggestion: { label: "Public submission", kind: "human", variant: "success" },
  email_submission: { label: "Email submission", kind: "human", variant: "success" },
  vendor_submission: { label: "Vendor submission", kind: "human", variant: "success" },
  // Internal / operator-driven.
  admin_manual: { label: "Admin entry", kind: "system", variant: "default" },
};

/** Title-case a snake_case method for a readable fallback label ("annual_rollover" → "Annual Rollover"). */
function prettifyMethod(method: string): string {
  return method
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function getIngestionProvenance(ingestionMethod: string | null | undefined): Provenance {
  if (!ingestionMethod) {
    return { label: "Unknown source", kind: "system", variant: "default" };
  }
  const known = PROVENANCE_BY_METHOD[ingestionMethod];
  if (known) return known;
  // Unlisted but present (annual_rollover, manual_*, …) — system-internal. Show
  // the raw method readably rather than guessing bot vs human.
  return { label: prettifyMethod(ingestionMethod), kind: "system", variant: "default" };
}
