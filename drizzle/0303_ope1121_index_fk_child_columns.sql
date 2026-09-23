-- OPE-1121 phase 1 — index the 19 FK child columns that had no index.
--
-- Every delete or merge of a user, vendor, performer or promoter runs its
-- ON DELETE SET NULL / CASCADE by scanning these child columns; without an
-- index each is a full table scan. Found by parsing prod `sqlite_master` DDL
-- (2026-09-22) and re-checked against prod and the ORM on 2026-09-23: none is
-- covered today. `event_vendors` has composites that CONTAIN event_day_id, but
-- as the second column, which cannot serve a lookup on event_day_id alone.
--
-- Indexes only: no table rebuild, no data change, idempotent (IF NOT EXISTS),
-- and a no-op on an empty database. Mirrored in packages/db-schema so the ORM
-- stays authoritative. Phase 2+ (FKs, which need child-table rebuilds) are
-- STOP-gated on the ticket and are NOT in this migration.
CREATE INDEX IF NOT EXISTS idx_claim_tokens_user_id ON claim_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_entity_claims_decided_by ON entity_claims(decided_by);
CREATE INDEX IF NOT EXISTS idx_event_data_citations_created_by ON event_data_citations(created_by);
CREATE INDEX IF NOT EXISTS idx_event_data_citations_supersedes ON event_data_citations(supersedes_citation_id);
CREATE INDEX IF NOT EXISTS idx_event_vendors_event_day_id ON event_vendors(event_day_id);
CREATE INDEX IF NOT EXISTS idx_events_submitted_by_user_id ON events(submitted_by_user_id);
CREATE INDEX IF NOT EXISTS idx_iesf_resulting_event_id ON inbound_email_sender_feedback(resulting_event_id);
CREATE INDEX IF NOT EXISTS idx_location_zips_location_id ON location_zips(location_id);
CREATE INDEX IF NOT EXISTS idx_performers_alias_of ON performers(alias_of_performer_id);
CREATE INDEX IF NOT EXISTS idx_performers_claimed_by ON performers(claimed_by);
CREATE INDEX IF NOT EXISTS idx_performers_redirect_to ON performers(redirect_to_performer_id);
CREATE INDEX IF NOT EXISTS idx_performers_verified_pro_by ON performers(verified_pro_by);
CREATE INDEX IF NOT EXISTS idx_poa_follow_up_of ON promoter_outreach_attempts(follow_up_of);
CREATE INDEX IF NOT EXISTS idx_promoters_claimed_by ON promoters(claimed_by);
CREATE INDEX IF NOT EXISTS idx_promoters_succeeded_by ON promoters(succeeded_by_promoter_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_granted_by ON user_roles(granted_by);
CREATE INDEX IF NOT EXISTS idx_vendors_claimed_by ON vendors(claimed_by);
CREATE INDEX IF NOT EXISTS idx_vendors_redirect_to ON vendors(redirect_to_vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendors_verified_pro_by ON vendors(verified_pro_by);
