/**
 * OPE-1058 scope 2 — the one-time map from every off-list `events.categories`
 * value to the taxonomy John ratified on 2026-09-17.
 *
 * Kept as code rather than inlined in a script so the rewrite is testable before
 * it runs and readable after it has: `docs/bulk-mutation-discipline.md` asks for
 * idempotent, read-back-verified, rollback-planned, and a mapping expressed as
 * data satisfies the first of those by construction — running it twice is the
 * same as running it once, because every target value maps to itself.
 *
 * Two kinds of entry:
 *   - a rename (`Cultural` → `Cultural Festival`), sometimes one-to-many
 *     (`Holiday Craft Fair` → `Holiday Market` + `Craft Fair`);
 *   - a removal (`Family-Friendly`, `handmade`) — these were never categories,
 *     they are tags, and `TAG_WORTHY` names the ones worth keeping as tags.
 */
import { partitionEventCategories, UNCATEGORIZED_EVENT_CATEGORY } from "@takemetothefair/constants";

/** Off-list value → the categories that replace it. Empty array = drop it. */
export const CATEGORY_CLEANUP_MAP: Readonly<Record<string, readonly string[]>> = {
  // typos / near-duplicates
  "Craft Fsir": ["Craft Fair"],
  "Artisan Fair": ["Craft Fair"],
  "Holiday Craft Fair": ["Holiday Market", "Craft Fair"],
  Cultural: ["Cultural Festival"],
  "Art Festival": ["Art Fair"],
  "Open Studios": ["Art Walk"],
  "Wedding Show": ["Bridal Show"],
  "Wedding Expo": ["Bridal Show"],
  "Specialty Food": ["Food Festival"],
  "Food & Beverage": ["Food Festival"],
  "Film Festival": ["Festival"],
  "Street Fair": ["Fair"],
  Fundraiser: ["Charity"],
  Conference: ["Convention"],
  "Motorcycle Show": ["Car Show"],
  "Plant Sale": ["Garden Show"],
  // absorbed by the ten values added in scope 1
  Hamfest: ["Amateur Radio Convention"],
  "Outdoor Market": ["Market"],
  "Sidewalk Sale": ["Market"],
  "Sportsmen's Show": ["Outdoor Show"],
  "RV Show": ["Outdoor Show"],
  "RV & Camping Show": ["Outdoor Show"],
  "Pop Culture": ["Pop Culture Convention"],
  "Renaissance Faire": ["Renaissance Fair"],
  Hobby: ["Hobby Show"],
  "Model Train Show": ["Hobby Show"],
  "Book Show": ["Hobby Show"],
  Historical: ["Living History"],
  // community / civic
  Community: ["Community Event"],
  "Family Event": ["Community Event"],
  Religious: ["Community Event"],
  "Library Event": ["Community Event"],
  Fireworks: ["Community Event"],
  "Holiday Lights": ["Community Event"],
  // weapons family
  Militaria: ["Gun Show"],
  Knives: ["Gun Show"],
  Firearms: ["Gun Show"],
  Ammunition: ["Gun Show"],
  // expo family
  "Health & Wellness Expo": ["Trade Show"],
  "Health & Fitness": ["Trade Show"],
  // no lane of their own
  Sports: ["Other"],
  "Road Race": ["Other"],
  Race: ["Other"],
  Tournament: ["Other"],
  Competition: ["Other"],
  Science: ["Other"],
  STEAM: ["Other"],
  Education: ["Other"],
  "Performing Arts": ["Other"],
  "Exotic Animal Show": ["Other"],
  // not categories at all
  "Family-Friendly": [],
  "Kid Friendly": [],
  handmade: [],
  gifts: [],
  "Food vendors": [],
  Holidays: [],
  Christmas: [],
};

/**
 * Values that leave `categories` but are worth carrying into `tags`. The rest
 * ("gifts", "Holidays") say nothing a visitor or a filter can use.
 */
export const TAG_WORTHY: Readonly<Record<string, string>> = {
  "Family-Friendly": "family-friendly",
  "Kid Friendly": "family-friendly",
  handmade: "handmade",
};

export interface CategoryCleanupResult {
  categories: string[];
  /** Tags to ADD (the caller merges; existing tags are never removed). */
  addTags: string[];
  changed: boolean;
}

/**
 * Apply the map to one event's stored categories.
 *
 * Idempotent: a value already on the list maps to itself, so a second run is a
 * no-op. A row left with nothing becomes `["Other"]`, NOT the "Event"
 * placeholder — a human did categorise this row, they just used a word the
 * taxonomy does not carry, and "Event" means "nobody ever categorised this".
 */
export function cleanupEventCategories(stored: readonly string[]): CategoryCleanupResult {
  const out: string[] = [];
  const addTags: string[] = [];
  let sawPlaceholder = false;

  for (const raw of stored) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") continue;
    if (value === UNCATEGORIZED_EVENT_CATEGORY) {
      sawPlaceholder = true;
      continue;
    }
    const mapped = CATEGORY_CLEANUP_MAP[value];
    const replacements = mapped ?? [value];
    for (const r of replacements) if (!out.includes(r)) out.push(r);
    const tag = TAG_WORTHY[value];
    if (tag && !addTags.includes(tag)) addTags.push(tag);
  }

  // Anything still off-list after mapping is a value nobody anticipated. Left
  // in place rather than silently dropped: the cleanup's read-back asserts the
  // end state, and a survivor must be visible there rather than vanishing.
  const { kept, dropped } = partitionEventCategories(out);
  const categories = [...kept, ...dropped];

  const final =
    categories.length > 0
      ? categories
      : sawPlaceholder
        ? [UNCATEGORIZED_EVENT_CATEGORY]
        : ["Other"];

  const changed =
    JSON.stringify(final) !==
      JSON.stringify([...stored].map((s) => (typeof s === "string" ? s.trim() : s))) ||
    addTags.length > 0;

  return { categories: final, addTags, changed };
}
