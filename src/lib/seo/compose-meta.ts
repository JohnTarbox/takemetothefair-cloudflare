/**
 * OPE-42 — richer composed meta-description fallbacks.
 *
 * When an entity's own `description` is empty or too thin to make a useful meta
 * description, compose an entity-SPECIFIC (non-duplicate) ~140–160 char
 * sentence from the structured fields we already have. Bing flagged 439 detail
 * pages for too-short / duplicate descriptions; the prior fallbacks were short
 * and near-identical across catalog rows, so each of these templates leads with
 * the entity name + location + a distinct value proposition.
 *
 * Every helper drops missing fields gracefully — no double spaces, dangling
 * commas, or "in ," artifacts when city / state / category / type is null.
 */

import { decodeHtmlEntities } from "@/lib/utils";
import { truncateAtBoundary } from "./truncate-meta";

// Cap composed fallbacks at the standard meta-description length. Tails are
// tightened so a typical full-field case (name + City, ST) lands ~140–160 and
// passes through untouched; only very long entity names trip the cap, which
// then boundary-truncates with an ellipsis rather than emitting a runaway meta.
const COMPOSE_MAX = 160;

function clean(v?: string | null): string {
  return (v ?? "").trim();
}

function decoded(v?: string | null): string {
  const c = clean(v);
  return c ? decodeHtmlEntities(c) : "";
}

/**
 * Build a "City, ST" clause from optionally-present parts. Returns "City, ST",
 * "City", "ST", or "" — never a dangling comma.
 */
function locationClause(city?: string | null, state?: string | null): string {
  const c = decoded(city);
  const s = decoded(state);
  if (c && s) return `${c}, ${s}`;
  return c || s || "";
}

/** Pick "a" / "an" for `noun` based on its leading sound (heuristic). */
function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/**
 * Event fallback:
 *   "<Name> is a <Category> in <City>, <ST> on <date(s)>. Find hours, tickets,
 *    vendor applications, and directions on Meet Me at the Fair."
 */
export function composeEventFallback(event: {
  name: string;
  category?: string | null;
  city?: string | null;
  state?: string | null;
  dates?: string | null;
}): string {
  const name = decoded(event.name);
  const category = decoded(event.category);
  const loc = locationClause(event.city, event.state);
  const dates = clean(event.dates);

  let s = `${name} is ${category ? withArticle(category) : "an event"}`;
  if (loc) s += ` in ${loc}`;
  if (dates) s += ` on ${dates}`;
  s += ". Find hours, tickets, vendor applications, and directions on Meet Me at the Fair.";
  return truncateAtBoundary(s, COMPOSE_MAX);
}

/**
 * Vendor fallback:
 *   "<Name> is a <Type> vendor[ from <City>, <ST>] exhibiting at New England
 *    fairs & festivals. See shows and booth info on Meet Me at the Fair."
 */
export function composeVendorFallback(vendor: {
  businessName: string;
  vendorType?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  const name = decoded(vendor.businessName);
  const type = decoded(vendor.vendorType);
  const loc = locationClause(vendor.city, vendor.state);

  let s = `${name} is ${type ? withArticle(`${type} vendor`) : "a vendor"}`;
  if (loc) s += ` from ${loc}`;
  s +=
    " exhibiting at New England fairs & festivals. See shows and booth info on Meet Me at the Fair.";
  return truncateAtBoundary(s, COMPOSE_MAX);
}

/**
 * Venue fallback (extends the original venue template):
 *   "<Name>[ in <City>, <ST>] hosts fairs, festivals, and craft shows. Browse
 *    the full schedule and vendor info on Meet Me at the Fair."
 *
 * `name` is expected to already be display-resolved by the caller (so
 * street-address rows read "Event venue in {City}, {State}" rather than a raw
 * address).
 */
export function composeVenueFallback(venue: {
  name: string;
  city?: string | null;
  state?: string | null;
}): string {
  const name = decoded(venue.name);
  const loc = locationClause(venue.city, venue.state);

  let s = name;
  if (loc) s += ` in ${loc}`;
  s +=
    " hosts fairs, festivals, and craft shows. Browse the full schedule and vendor info on Meet Me at the Fair.";
  return truncateAtBoundary(s, COMPOSE_MAX);
}

/**
 * Promoter fallback:
 *   "<Name>[ in <City>, <ST>] organizes fairs, festivals, and events across New
 *    England. See their shows and vendor info on Meet Me at the Fair."
 */
export function composePromoterFallback(promoter: {
  name: string;
  city?: string | null;
  state?: string | null;
}): string {
  const name = decoded(promoter.name);
  const loc = locationClause(promoter.city, promoter.state);

  let s = name;
  if (loc) s += ` in ${loc}`;
  s +=
    " organizes fairs, festivals, and events across New England. See their shows and vendor info on Meet Me at the Fair.";
  return truncateAtBoundary(s, COMPOSE_MAX);
}
