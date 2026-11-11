/**
 * @takemetothefair/utils/feeds — the organizer-feed readers' pure halves
 * (OPE-1613 / OPE-1617), shared by the MCP Worker's feed reader and the main
 * app's test-submission engine (OPE-1625). A subpath, not the root index, so
 * the readers' many small helpers (addDays, parseLocation, …) do not crowd or
 * collide with the root namespace. Pure: no I/O; fetchers take a function.
 */
export * from "./feed-event";
export * from "./ical";
export * from "./jsonld";
export * from "./inclusion";
export * from "./self-contradictions";
