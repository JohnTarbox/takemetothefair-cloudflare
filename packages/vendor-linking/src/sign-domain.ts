/**
 * OPE-1694 — a web address read off a booth sign is the strongest identity
 * evidence a photo carries, and the vendor write path ignored it.
 *
 * Specimen (2026-11-20, CMP Employee Club Vendor & Craft Fair): a sign reading
 * "Maine CardWorks.com" was taken as the business NAME, name-dedup found
 * nothing, and a bare duplicate of Maine Cardworks Inc — whose `website` is
 * https://www.mainecardworks.com — was created and published CONFIRMED. The
 * domain on the sign matched the existing vendor's website exactly.
 *
 * Two pieces live here so every caller of `createOrLinkVendor` that opts in
 * gets the same answer:
 *
 *   - `extractSignDomain` — pure. Pulls a domain out of the model's `website`
 *     field or out of the business name itself, and returns the name with the
 *     domain suffix removed ("Maine CardWorks.com" → "Maine CardWorks").
 *   - `resolveVendorByDomain` — which existing vendor owns that domain, via the
 *     ONE org-domain reader (`orgsForDomain`: the website seed plus active
 *     `org_domains` rows, minus retired ones). Exactly one owner links; more
 *     than one is ambiguous and must go to a person.
 */
import { inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@takemetothefair/db-schema";
import { orgsForDomain } from "@takemetothefair/db-schema";
import { icannHost, isNonOwnableDomain } from "@takemetothefair/utils";

const { vendors } = schema;
type Db = DrizzleD1Database<typeof schema>;

/**
 * A domain-shaped token: optional scheme, optional `www.`, dotted labels, an
 * optional path. Not anchored, so it finds "CardWorks.com" inside "Maine
 * CardWorks.com". The lookbehind stops it starting mid-word or mid-email.
 * Shape only — `icannHost` decides whether the suffix is real.
 */
const DOMAIN_TOKEN =
  /(?<![\w@.-])(https?:\/\/)?(www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/[^\s]*)?/gi;

/** Lower-case, scheme/`www.`/path stripped, registrable (eTLD+1). Null if not a real domain. */
export function normalizeSignDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#\s]/)[0] ?? "";
  s = s.replace(/^www\./, "").replace(/\.$/, "");
  if (!s.includes(".")) return null;
  return icannHost(s)?.domain ?? null;
}

export interface SignDomain {
  /** Registrable domain as printed (website field first), or null when neither field carried one. */
  domain: string | null;
  /**
   * Every domain worth looking up, most specific first. Besides `domain`, a
   * bare token the model split off the words before it is tried re-joined:
   * the specimen sign printed MaineCardWorks.com and was read as
   * "Maine CardWorks.com", so `mainecardworks.com` is tried before
   * `cardworks.com`. Never joined across an explicit `https://` or `www.`.
   */
  candidates: string[];
  /** Where it was read from. `website` wins when both carry one. */
  source: "website" | "name" | null;
  /**
   * True when sharing the domain proves nothing about ownership (etsy.com,
   * facebook.com, gmail.com). Such a domain never links a vendor.
   */
  nonOwnable: boolean;
  /**
   * The business name with any domain token reduced to its label
   * ("Maine CardWorks.com" → "Maine CardWorks"). Equal to the input when the
   * name carried no domain; null when nothing is left.
   */
  cleanedName: string | null;
}

/** Pure. Find the sign's domain and the name without it. */
export function extractSignDomain(
  businessName: string | null | undefined,
  website: string | null | undefined
): SignDomain {
  const name = businessName ?? "";
  let nameDomain: string | null = null;
  const joined: string[] = [];

  const cleaned = name.replace(
    DOMAIN_TOKEN,
    (
      whole: string,
      scheme: string | undefined,
      www: string | undefined,
      host: string,
      _path: string | undefined,
      offset: number
    ) => {
      const parsed = icannHost(host);
      if (!parsed) return whole; // "St.Louis", "Mr.Smith" — a name, not a URL
      if (nameDomain === null) {
        nameDomain = parsed.domain;
        if (!scheme && !www) {
          // Up to three plain words directly before the token, re-joined.
          const before = name.slice(0, offset).trimEnd().split(/\s+/);
          const words: string[] = [];
          for (let i = before.length - 1; i >= 0 && words.length < 3; i--) {
            if (!/^[a-z0-9-]+$/i.test(before[i])) break;
            words.unshift(before[i]);
          }
          for (let k = words.length; k >= 1; k--) {
            const d = icannHost(words.slice(-k).join("") + host)?.domain;
            if (d && d !== parsed.domain) joined.push(d);
          }
        }
      }
      // A standalone URL goes; a bare token keeps its label as printed:
      // "CardWorks.com" → "CardWorks".
      if (scheme || www) return "";
      return host.slice(0, host.length - parsed.publicSuffix.length - 1);
    }
  );
  const cleanedName =
    cleaned
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s\-|·•,:;]+|[\s\-|·•,:;]+$/g, "")
      .trim() || null;

  const websiteDomain = normalizeSignDomain(website);
  const domain = websiteDomain ?? nameDomain;
  const candidates = [
    ...new Set([websiteDomain, ...joined, nameDomain].filter((d): d is string => Boolean(d))),
  ];
  return {
    domain,
    candidates,
    source: websiteDomain ? "website" : nameDomain ? "name" : null,
    nonOwnable: domain !== null && isNonOwnableDomain(domain),
    cleanedName,
  };
}

export type DomainVendorMatch =
  | { kind: "none"; domain: string | null; reason: string }
  | { kind: "one"; domain: string; vendorId: string; businessName: string }
  | {
      kind: "ambiguous";
      domain: string;
      candidates: Array<{ id: string; businessName: string }>;
      reason: string;
    };

/**
 * Which live vendor owns this domain?
 *
 * Owners come from `orgsForDomain` (website seed + active `org_domains`, minus
 * retired). Each is resolved through its merge redirect to the canonical row,
 * and soft-deleted rows drop out, so a vendor merged into its keeper counts
 * once. One canonical owner → `one`. Several → `ambiguous`. An operator-listed
 * umbrella domain, or a non-ownable one, links nothing (`none`).
 */
export async function resolveVendorByDomain(
  db: Db,
  domain: string | null | undefined
): Promise<DomainVendorMatch> {
  const d = normalizeSignDomain(domain);
  if (!d) return { kind: "none", domain: null, reason: "no domain" };
  if (isNonOwnableDomain(d))
    return { kind: "none", domain: d, reason: `${d} is a shared or free-mail domain` };

  const owners = await orgsForDomain(db, "vendor", d);
  if (owners.allOwners.length === 0) return { kind: "none", domain: d, reason: owners.reason };
  if (owners.shared && owners.reason.includes("operator-listed"))
    return { kind: "none", domain: d, reason: owners.reason };

  // Canonicalise: follow redirect_to_vendor_id, drop deleted. Bounded depth.
  const canonical = new Map<string, string>();
  let frontier = owners.allOwners;
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        redirectTo: vendors.redirectToVendorId,
        deletedAt: vendors.deletedAt,
      })
      .from(vendors)
      .where(inArray(vendors.id, frontier));
    const next: string[] = [];
    for (const r of rows) {
      if (r.redirectTo) next.push(r.redirectTo);
      else if (!r.deletedAt) canonical.set(r.id, r.businessName);
    }
    frontier = next.filter((id) => !canonical.has(id));
  }

  const list = [...canonical].map(([id, businessName]) => ({ id, businessName }));
  if (list.length === 0)
    return { kind: "none", domain: d, reason: `${d}'s owners are all deleted or merged away` };
  if (list.length === 1)
    return { kind: "one", domain: d, vendorId: list[0].id, businessName: list[0].businessName };
  return {
    kind: "ambiguous",
    domain: d,
    candidates: list,
    reason: `${d} is on ${list.length} vendors: ${list.map((c) => c.businessName).join(", ")}`,
  };
}

/**
 * Try each of a sign's candidate domains in order; the first that any live
 * vendor owns decides. `none` when no candidate is owned by anyone.
 */
export async function resolveVendorBySignDomain(
  db: Db,
  sd: Pick<SignDomain, "domain" | "candidates">
): Promise<DomainVendorMatch> {
  let last: DomainVendorMatch = { kind: "none", domain: sd.domain, reason: "no domain" };
  for (const c of sd.candidates) {
    const dm = await resolveVendorByDomain(db, c);
    if (dm.kind !== "none") return dm;
    last = { ...dm, domain: sd.domain };
  }
  return last;
}
