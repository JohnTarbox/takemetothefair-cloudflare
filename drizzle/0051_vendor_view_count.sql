-- Per-vendor view count for the §6.6 "claimed_ready_for_enhanced_upsell"
-- recommendation rule. Replaces the event_count >= 3 proxy with the
-- doc-specified "top decile by view count" engagement signal.
--
-- Mirrors the events.view_count pattern from drizzle/0001 (and
-- src/app/events/[slug]/page.tsx server-side increment). ISR cache at
-- revalidate=300 means each unique vendor page increments at most once
-- per ~5 minutes — undercounts absolute views ~60×, but preserves
-- relative ordering uniformly across all vendors, which is exactly
-- what decile ranking needs.
--
-- Index supports the upsell rule's ORDER BY view_count DESC and any
-- future "most viewed vendors" surfaces.

ALTER TABLE vendors ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_vendors_view_count ON vendors(view_count);
