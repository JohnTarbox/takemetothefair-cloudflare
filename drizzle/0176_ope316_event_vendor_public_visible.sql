-- OPE-316 — per-link public visibility on event_vendors.
--
-- The LeafFilter case: a vendor wants their event participation RECORDED but
-- not SHOWN. The row must keep counting for admin roster views, coverage stats
-- and analytics; it just must not render anywhere public — including
-- schema.org JSON-LD, where a leak is real but less visible.
--
-- A column rather than another `status` value, deliberately. `status` is a
-- workflow state with ~52 consumers, roughly 40 of which don't filter on it;
-- widening that enum would silently expose hidden links through every
-- unfiltered reader, which is the failure the event_vendors enum-widening
-- lesson already records. A NOT NULL DEFAULT 1 column is invisible to every
-- existing reader, and only the public boundary
-- (isPubliclyVisibleVendorLink) opts in.
--
-- Backfill is implicit: DEFAULT 1 leaves every existing link visible, which is
-- exactly today's behaviour. No row changes meaning on deploy.

ALTER TABLE event_vendors ADD COLUMN public_visible INTEGER NOT NULL DEFAULT 1;
