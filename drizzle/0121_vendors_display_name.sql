-- EH2.1 (Dev-Email-2026-06-09-EH2.md §B1, 2026-06-09) — vendor display_name
-- override column.
--
-- The render layer resolves a vendor's displayed name via the EH1 gate logic
-- (`packages/utils/src/vendor-display.ts:displayVendorName`). The default
-- surface is `business_name`; this nullable column is the override hatch for
-- brand parents whose marketing name differs from their legal name (e.g.
-- "LeafFilter" vs "LeafFilter North LLC", "A Leaf Home Company" vs the
-- registered LLC). Without it, today's 2 brand parents
-- (`sys-vendor-rba-national`, `sys-vendor-leaffilter-national`) would have
-- needed business_name itself rewritten — which would change slugs, content
-- URLs, and existing IndexNow / sitemap entries.
--
-- Nullable + no default — every existing row gets NULL on rollout, which the
-- helper short-circuits to `COALESCE(display_name, business_name)`. Cache-key
-- parity for the INDEPENDENT case (~99% of rows) holds bit-for-bit.

ALTER TABLE vendors ADD COLUMN display_name TEXT;
