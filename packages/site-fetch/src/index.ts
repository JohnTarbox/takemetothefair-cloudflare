/**
 * @takemetothefair/site-fetch — shared HTTP fetch helpers used by both the
 * main app and the MCP Worker. The one workspace package that performs I/O
 * (network fetch); keep pure helpers in @takemetothefair/utils instead.
 */
export * from "./browser-rendering";
export * from "./ssrf-guard";
