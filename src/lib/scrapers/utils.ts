// Shared utilities for scrapers

// Re-export the canonical decoder. Existing scraper imports
// (`import { decodeHtmlEntities } from "./utils"`) keep working.
export { decodeHtmlEntities } from "@/lib/utils";

// Create a URL-safe slug from a name (used for sourceId generation)
// NOTE: This is different from the `createSlug` in @/lib/utils which may behave differently
export function createSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
