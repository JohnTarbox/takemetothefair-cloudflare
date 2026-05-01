// Shim — datetime helpers source of truth lives in packages/datetime/.
// Existing `@/lib/datetime` imports continue to work via this re-export.
// Delete this shim only after all consumers are updated to import directly
// from "@takemetothefair/datetime" (low-priority cleanup; the shim is fine).
export * from "@takemetothefair/datetime";
