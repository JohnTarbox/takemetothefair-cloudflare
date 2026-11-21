/**
 * OPE-1617 — universal iCalendar (RFC 5545) reader.
 *
 * The parser lives in @takemetothefair/utils/feeds since OPE-1625 (the main
 * app's test-submission engine reads calendars with the same code); its header
 * there documents the time, recurrence and change-detection rules. This module
 * re-exports it so the MCP Worker's imports stay where they were.
 */
export {
  addDays,
  expandRrule,
  normalizeCalendarUrl,
  parseContentLine,
  parseDurationMinutes,
  parseIcs,
  parseIcsDateValue,
  parseIcsFeed,
  parseLocation,
  parseRrule,
  resolveTzid,
  unescapeText,
  unfoldLines,
  utcToLocal,
  type IcsComponent,
  type IcsParseResult,
  type IcsProp,
  type IcsReadOptions,
  type LocalTime,
  type Rrule,
} from "@takemetothefair/utils/feeds";
