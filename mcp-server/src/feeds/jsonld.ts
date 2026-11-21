/**
 * OPE-1617 — schema.org `Event` JSON-LD reader.
 *
 * The reader lives in @takemetothefair/utils/feeds since OPE-1625 (the main
 * app's test-submission engine reads event pages with the same code); this
 * module re-exports it so the MCP Worker's imports stay where they were.
 */
export {
  eventLinksFromHtml,
  eventLinksFromSitemap,
  eventsFromHtml,
  ldJsonBlocks,
  mapJsonLdEvent,
  parseIsoLocal,
  readJsonLdSource,
  type JsonLdReadResult,
} from "@takemetothefair/utils/feeds";
