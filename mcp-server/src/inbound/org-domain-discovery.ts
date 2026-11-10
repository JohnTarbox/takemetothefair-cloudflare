/**
 * OPE-1614 — evidence that adds a domain to an org's list automatically.
 *
 * Exactly two kinds of evidence auto-add (the ticket's §2 table):
 *
 *   1. `website_redirect` — https://X/ redirects (301/302/303/307/308) to a
 *      domain already on ONE org's list. ohtm.org → 302 → owlshead.org adds
 *      ohtm.org to the promoter whose website is owlshead.org.
 *   2. `site_published_email` — the org's own site (a domain already on its
 *      list) publishes an address on X. owlshead.org printing events@ohtm.org
 *      adds ohtm.org.
 *
 * Neither ever adds a non-ownable domain (planOrgDomainAdd refuses), and a
 * redirect target that is SHARED (on more than one org's list) adds nothing,
 * because "which org" has no single answer.
 *
 * Only `https://<registrable domain>/` is ever fetched, with redirects
 * followed by hand so each hop is recorded and capped. Nothing here sends.
 */
import {
  addOrgDomain,
  orgDomainList,
  orgsForDomain,
  ownableOrgDomain,
  type OrgDomainEntityType,
} from "@takemetothefair/db-schema";
import type { Db } from "../db.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_HOPS = 5;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 400_000;
export const DISCOVERY_ACTOR = "system:org-domain-discovery";

export interface RedirectProbe {
  domain: string;
  chain: string[];
  /** Registrable domain of the last hop, when it differs from `domain`. */
  finalDomain: string | null;
  error: string | null;
}

/** Follow https://<domain>/ hop by hop, recording every Location. */
export async function probeRedirect(domain: string, fetchImpl: FetchLike): Promise<RedirectProbe> {
  const chain: string[] = [];
  let url = `https://${domain}/`;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      chain.push(url);
      const res = await fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "MeetMeAtTheFair-DomainCheck/1.0" },
      });
      const loc = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !loc) break;
      const next = new URL(loc, url);
      if (next.protocol !== "https:" && next.protocol !== "http:") break;
      url = next.toString();
      if (hop === MAX_HOPS) chain.push(url);
    }
  } catch (e) {
    return { domain, chain, finalDomain: null, error: e instanceof Error ? e.message : String(e) };
  }
  const last = ownableOrgDomain(chain[chain.length - 1]);
  return { domain, chain, finalDomain: last && last !== domain ? last : null, error: null };
}

/**
 * Does `domain` redirect to a domain that exactly one org of `type` owns?
 * If so, add it to that org's list (`website_redirect`, chain as evidence).
 */
export async function addByRedirect(
  db: Db,
  type: OrgDomainEntityType,
  domain: string,
  fetchImpl: FetchLike,
  now: Date = new Date()
): Promise<{ added: boolean; entityId: string | null; probe: RedirectProbe; reason: string }> {
  const probe = await probeRedirect(domain, fetchImpl);
  if (probe.error) return { added: false, entityId: null, probe, reason: probe.error };
  if (!probe.finalDomain)
    return { added: false, entityId: null, probe, reason: "no redirect to another domain" };
  const owners = await orgsForDomain(db, type, probe.finalDomain);
  if (owners.ids.length !== 1)
    return {
      added: false,
      entityId: null,
      probe,
      reason: owners.reason || `${probe.finalDomain} has no single owner`,
    };
  const res = await addOrgDomain(db, {
    entityType: type,
    entityId: owners.ids[0],
    domain,
    method: "website_redirect",
    evidence: `redirect chain: ${probe.chain.join(" → ")}`,
    sourceUrl: probe.chain[0],
    actor: DISCOVERY_ACTOR,
    now,
  });
  return {
    added: res.ok && res.changed && res.status === "active",
    entityId: owners.ids[0],
    probe,
    reason: res.ok ? "" : res.reason,
  };
}

const EMAIL_RE = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/** Addresses printed on a page (mailto: or plain text), lowercased, deduped. */
export function emailsOnPage(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.slice(0, MAX_BODY_CHARS).matchAll(EMAIL_RE)) {
    const addr = m[0].toLowerCase();
    // Skip asset names that look like addresses (logo@2x.png).
    if (/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(addr)) continue;
    out.add(addr);
  }
  return [...out];
}

export interface DiscoveryResult {
  pagesRead: string[];
  added: Array<{ domain: string; method: string; evidence: string }>;
  refused: Array<{ domain: string; reason: string }>;
  redirects: RedirectProbe[];
}

/**
 * Operator-run discovery for one org: read its own site's homepage (and
 * /contact) on each active domain, auto-add every ownable domain it publishes
 * an address on, and redirect-check any extra candidate domains given.
 */
export async function discoverOrgDomains(
  db: Db,
  type: OrgDomainEntityType,
  entityId: string,
  fetchImpl: FetchLike,
  opts: { candidates?: string[]; now?: Date } = {}
): Promise<DiscoveryResult> {
  const now = opts.now ?? new Date();
  const result: DiscoveryResult = { pagesRead: [], added: [], refused: [], redirects: [] };
  const list = await orgDomainList(db, type, entityId);
  const active = new Set(list.filter((e) => e.status === "active").map((e) => e.domain));

  for (const own of active) {
    for (const path of ["/", "/contact"]) {
      const url = `https://${own}${path}`;
      let html: string;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) continue;
        // Only a page still on the org's own domain counts as "its own site".
        if (res.url && ownableOrgDomain(res.url) && ownableOrgDomain(res.url) !== own) continue;
        html = await res.text();
      } catch {
        continue;
      }
      result.pagesRead.push(url);
      for (const addr of emailsOnPage(html)) {
        const d = ownableOrgDomain(addr);
        if (!d || active.has(d)) continue;
        const res = await addOrgDomain(db, {
          entityType: type,
          entityId,
          domain: d,
          method: "site_published_email",
          evidence: `${url} publishes ${addr}`,
          sourceUrl: url,
          actor: DISCOVERY_ACTOR,
          now,
        });
        if (res.ok && res.changed) {
          active.add(d);
          result.added.push({
            domain: d,
            method: "site_published_email",
            evidence: `${url}: ${addr}`,
          });
        } else if (!res.ok) result.refused.push({ domain: d, reason: res.reason });
      }
    }
  }

  for (const c of opts.candidates ?? []) {
    const d = ownableOrgDomain(c);
    if (!d) {
      result.refused.push({ domain: c, reason: "free-mail, shared or unparseable domain" });
      continue;
    }
    if (active.has(d)) continue;
    const r = await addByRedirect(db, type, d, fetchImpl, now);
    result.redirects.push(r.probe);
    if (r.added && r.entityId === entityId) {
      active.add(d);
      result.added.push({
        domain: d,
        method: "website_redirect",
        evidence: r.probe.chain.join(" → "),
      });
    } else if (r.entityId && r.entityId !== entityId)
      // The redirect is evidence for its TARGET's owner, not for this org.
      result.refused.push({
        domain: d,
        reason: `redirects to a domain owned by ${type} ${r.entityId}${r.added ? " (added there)" : ""}`,
      });
    else result.refused.push({ domain: d, reason: r.reason || "already on the list" });
  }
  return result;
}
