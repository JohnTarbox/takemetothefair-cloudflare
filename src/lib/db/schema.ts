// Shim — schema source of truth lives in packages/db-schema/.
// Existing `@/lib/db/schema` imports continue to work via this re-export.
// Delete this shim only after all consumers are updated to import directly
// from "@takemetothefair/db-schema" (low-priority cleanup; the shim is fine).
export * from "@takemetothefair/db-schema";
