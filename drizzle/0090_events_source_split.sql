-- Split events.source_name into source_domain + ingestion_method.
--
-- Background (analyst 2026-05-26 backlog Item 1): source_name has been
-- overloaded — a single column carries (a) origin domains like
-- "joycescraftshows.com", (b) ingestion-method strings like
-- "email-submission" / "community-suggestion", and (c) freeform
-- annotations like "visitaroostook.com (verified 2026-05-18)". The
-- conflation prevents per-source reliability scoring without ad-hoc
-- string munging.
--
-- This migration ONLY adds the two columns. The one-time backfill runs
-- via POST /api/admin/backfill/source-domain?apply=true so the parsing
-- logic stays in TypeScript next to the canonical classifier
-- (src/lib/source-classification.ts) and can be re-run if the
-- classifier evolves. source_name is retained for legacy reads; new
-- writes populate all three columns via classifySource().

ALTER TABLE events ADD COLUMN source_domain TEXT;
ALTER TABLE events ADD COLUMN ingestion_method TEXT;
