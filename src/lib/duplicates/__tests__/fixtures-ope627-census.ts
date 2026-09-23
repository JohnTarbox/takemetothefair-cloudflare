/**
 * OPE-627's REAL 2026-08-29 census — all four true duplicate pairs and all six
 * legitimate same-venue/same-day pairs, with their actual venue ids, promoter
 * ids and dates. Shared by the detector's tests (OPE-627) and the review
 * queue's (OPE-1117), because the acceptance for both is stated against THIS
 * data: listing these is fine, merging any of them is a fail.
 */
export interface Row {
  slug: string;
  name: string;
  venue: string;
  promoter: string;
  start: string;
  end: string;
  status?: string;
  merged?: string;
}

export const CENSUS: Row[] = [
  // ── the four TRUE duplicate pairs ──────────────────────────────────────
  {
    slug: "new-england-home-show-rhode-island-2026",
    name: "New England Home Show Rhode Island 2026",
    venue: "f56bcd2a",
    promoter: "c9ff5eb5",
    start: "2026-03-27",
    end: "2026-03-29",
  },
  {
    slug: "new-england-home-show-lincoln-ri-2026",
    name: "New England Home Show Lincoln RI 2026",
    venue: "f56bcd2a",
    promoter: "488c86fd",
    start: "2026-03-27",
    end: "2026-03-29",
    status: "TENTATIVE",
  },

  {
    slug: "pttf-holiday-craft-fair-2026",
    name: "PTTF Holiday Craft Fair 2026",
    venue: "c46818fe",
    promoter: "aef3e095",
    start: "2026-11-21",
    end: "2026-11-21",
  },
  {
    slug: "thorntons-ferry-holiday-craft-fair-2026",
    name: "Thorntons Ferry Holiday Craft Fair 2026",
    venue: "c46818fe",
    promoter: "aef3e095",
    start: "2026-11-21",
    end: "2026-11-21",
    status: "TENTATIVE",
  },

  {
    slug: "scarborough-high-school-craft-show-2026",
    name: "Scarborough High School Craft Show 2026",
    venue: "904dfcf1",
    promoter: "system-community-suggestions",
    start: "2026-11-27",
    end: "2026-11-28",
    status: "TENTATIVE",
  },
  {
    slug: "ssmc-craft-show-scarborough-2026",
    name: "SSMC Craft Show Scarborough 2026",
    venue: "904dfcf1",
    promoter: "ed95ad28",
    start: "2026-11-27",
    end: "2026-11-28",
    status: "TENTATIVE",
  },

  {
    slug: "logging-festival-days-2026",
    name: "Logging Festival Days 2026",
    venue: "8b772fab",
    promoter: "system-community-suggestions",
    start: "2026-07-17",
    end: "2026-07-17",
  },
  {
    slug: "maine-forestry-museum-logging-festival",
    name: "Maine Forestry Museum Logging Festival",
    venue: "8b772fab",
    promoter: "24561097",
    start: "2026-07-17",
    end: "2026-07-18",
  },

  // ── the six LEGITIMATE pairs (flagging is acceptable, merging is not) ───
  {
    slug: "cape-cod-hydrangea-festival-2026",
    name: "Cape Cod Hydrangea Festival 2026",
    venue: "0c78e6f7",
    promoter: "d28faa5f",
    start: "2026-07-10",
    end: "2026-07-19",
  },
  {
    slug: "cape-cod-hydrangea-festival-kickoff-party-2026",
    name: "Cape Cod Hydrangea Festival Kickoff Party 2026",
    venue: "0c78e6f7",
    promoter: "system-community-suggestions",
    start: "2026-07-10",
    end: "2026-07-10",
  },

  {
    slug: "fiber-festival-of-new-england-2026",
    name: "Fiber Festival of New England 2026",
    venue: "a00e9108",
    promoter: "b4401fb2",
    start: "2026-11-07",
    end: "2026-11-08",
  },
  {
    slug: "old-deerfield-craft-fairs-holiday-sampler",
    name: "Old Deerfield Craft Fairs Holiday Sampler",
    venue: "a00e9108",
    promoter: "8a71b393",
    start: "2026-11-07",
    end: "2026-11-08",
  },

  // Exeter America-250: one town green, five real events. 1 pair on Jul 9,
  // 3 pairs on Jul 11. All but one share promoter 48fa8b58.
  {
    slug: "exeter-farmers-market-america-250-edition",
    name: "Exeter Farmer's Market — America 250 Edition",
    venue: "2e9e3af6",
    promoter: "48fa8b58",
    start: "2026-07-09",
    end: "2026-07-09",
  },
  {
    slug: "exeter-community-picnic-and-concert-america-250",
    name: "Exeter Community Picnic & Concert — America 250",
    venue: "2e9e3af6",
    promoter: "48fa8b58",
    start: "2026-07-09",
    end: "2026-07-09",
  },
  {
    slug: "american-independence-festival-2026",
    name: "American Independence Festival 2026",
    venue: "2e9e3af6",
    promoter: "256e82be",
    start: "2026-07-11",
    end: "2026-07-11",
  },
  {
    slug: "patriotic-all-wheels-youth-parade-exeter-250",
    name: "Patriotic All Wheels Youth Parade — Exeter 250",
    venue: "2e9e3af6",
    promoter: "48fa8b58",
    start: "2026-07-11",
    end: "2026-07-11",
  },
  {
    slug: "exeter-fireworks-america-250",
    name: "Exeter Fireworks — America 250",
    venue: "2e9e3af6",
    promoter: "48fa8b58",
    start: "2026-07-11",
    end: "2026-07-11",
  },
];
