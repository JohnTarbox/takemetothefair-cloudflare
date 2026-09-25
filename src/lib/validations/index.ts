// Shim — Zod validation schemas live in packages/validation/.
// Existing `@/lib/validations` imports continue to work via this re-export.
// OPE-1155 — install zod's English messages for every importer of this shim.
import "./zod-locale";
export * from "@takemetothefair/validation";
