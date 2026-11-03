/**
 * OPE-1347 #7 — near-miss `/admin/analytics?tab=` slugs → the real slug.
 *
 * `?tab=first-party` used to render Overview silently (the slug is
 * `first-party-events`). The page now redirects a known near-miss here and
 * 404s anything else. Kept outside page.tsx because a Next page module may
 * only export its route members.
 */
export const TAB_ALIASES: Readonly<Record<string, string>> = {
  "first-party": "first-party-events",
  "first-party-event": "first-party-events",
  firstparty: "first-party-events",
  sitehealth: "site-health",
  health: "site-health",
  recs: "recommendations",
};

export function resolveTabAlias(value: string): string | undefined {
  return TAB_ALIASES[value.trim().toLowerCase()];
}
