// Compose UTM-tagged URLs for outbound posts (Facebook, newsletter,
// partner links, etc.) so GA4 trafficSources can distinguish manual
// posts from organic referrals.
//
// Pure module — no D1, no fetch — so the unit tests can exercise it
// directly without spinning up the MCP transport. The build_utm_url
// MCP tool in tools/analytics.ts is a thin wrapper around buildUtmUrl().
//
// Design constraints:
// - Host-restricted to meetmeatthefair.com (and www.) so the tool can't
//   accidentally tag a competitor or arbitrary URL.
// - UTM param values sanitized via createSlug so casing/spacing
//   differences don't fragment the same campaign into multiple GA4 rows.
// - Existing utm_* params on the input URL are REPLACED (not appended)
//   so re-tagging an already-tagged link doesn't produce duplicates.
// - Non-utm query params are preserved.

import { createSlug } from "./helpers.js";

const ALLOWED_HOSTS = new Set(["meetmeatthefair.com", "www.meetmeatthefair.com"]);

export type BuildUtmUrlInput = {
  url: string;
  source: string;
  medium: string;
  campaign: string;
  content?: string | null;
  term?: string | null;
};

export type BuildUtmUrlResult =
  | {
      ok: true;
      url: string;
      source: string;
      medium: string;
      campaign: string;
      content: string | null;
      term: string | null;
    }
  | { ok: false; error: string };

export function buildUtmUrl(input: BuildUtmUrlInput): BuildUtmUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, error: `Invalid URL: ${input.url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `URL scheme must be http or https; got ${parsed.protocol}`,
    };
  }
  if (!ALLOWED_HOSTS.has(parsed.host.toLowerCase())) {
    return {
      ok: false,
      error: `URL host must be meetmeatthefair.com (or www.meetmeatthefair.com); got ${parsed.host}`,
    };
  }

  const source = createSlug(input.source);
  const medium = createSlug(input.medium);
  const campaign = createSlug(input.campaign);
  if (!source || !medium || !campaign) {
    return {
      ok: false,
      error: "source, medium, and campaign must each contain at least one alphanumeric character",
    };
  }
  const content = input.content ? createSlug(input.content) : null;
  const term = input.term ? createSlug(input.term) : null;

  parsed.searchParams.delete("utm_source");
  parsed.searchParams.delete("utm_medium");
  parsed.searchParams.delete("utm_campaign");
  parsed.searchParams.delete("utm_content");
  parsed.searchParams.delete("utm_term");

  parsed.searchParams.set("utm_source", source);
  parsed.searchParams.set("utm_medium", medium);
  parsed.searchParams.set("utm_campaign", campaign);
  if (content) parsed.searchParams.set("utm_content", content);
  if (term) parsed.searchParams.set("utm_term", term);

  return {
    ok: true,
    url: parsed.toString(),
    source,
    medium,
    campaign,
    content,
    term,
  };
}
