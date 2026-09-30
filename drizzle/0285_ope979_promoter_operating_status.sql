-- OPE-979 — a promoter can stop trading, and another promoter can take its shows over.
--
-- Before this, the only place "Eagle Shows has closed; Eastern Gun Expo took over"
-- could live was prose hand-typed into promoters.description, which nothing reads.
-- merge_promoter is the wrong instrument: these are two real companies, and a merge
-- erases the handover, which is the fact worth keeping.
--
--   operating_status               NULL = never assessed. ACTIVE | CEASED | MERGED | UNKNOWN.
--                                  A plain text column like enrichment_status (no CHECK),
--                                  so a later value needs no table rebuild.
--   succeeded_by_promoter_id       the promoter that took the business over, when known.
--   operating_status_source_url    where the status was read (the closure notice itself).
--   operating_status_verified_at   unix seconds, when a person or check last confirmed it.
--
-- Every existing row starts NULL: nothing is inferred from history, and this file
-- writes no row. The specimen (Eagle Shows 9703b5c0 → CEASED, succeeded by Eastern
-- Gun Expo a47e02d4) is recorded through update_promoter as an operator action,
-- not here, so a schema migration never doubles as a live-data write.

ALTER TABLE promoters ADD COLUMN operating_status TEXT;
--> statement-breakpoint
ALTER TABLE promoters ADD COLUMN succeeded_by_promoter_id TEXT REFERENCES promoters(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE promoters ADD COLUMN operating_status_source_url TEXT;
--> statement-breakpoint
ALTER TABLE promoters ADD COLUMN operating_status_verified_at INTEGER;
