-- OPE-764 — record who wrote to us, using data we already hold.
--
-- ── The finding ───────────────────────────────────────────────────────────
--
-- Five high-value correspondents measured 2026-09-02: Jeremy Hall (CT DEEP),
-- Paradise City Arts, David Lerner, aéhkō, TIMEPROOFUSA. All five were already
-- entities in our own database at the moment they wrote. None was recognised.
-- Two got the same acknowledgement template twice.
--
-- ── Columns ───────────────────────────────────────────────────────────────
--
-- `matched_entities` is the answer: a JSON array of EVERY match, because
-- picking one would be a fabrication dressed as a result. The four scalars
-- beside it are the highest-confidence match, for list views and indexing —
-- convenience, not truth.
--
-- ── Empty-database safety ─────────────────────────────────────────────────
--
-- Pure ALTER TABLE ADD COLUMN. No INSERT, no UPDATE, no FK. Cannot abort a
-- fresh-database run.
--
-- ── Backfill ──────────────────────────────────────────────────────────────
--
-- Possible in principle, unlike OPE-762/OPE-763 — the sender address is still
-- on every row, so a historical resolution could be computed. Deliberately NOT
-- done here: resolution reflects the entity graph AT THE MOMENT OF RECEIPT,
-- and back-filling today's graph onto a row from July would record a match
-- that did not exist when the person wrote. That is a worse artefact than a
-- NULL, because it reads as evidence.

ALTER TABLE inbound_emails ADD COLUMN matched_entities TEXT;
ALTER TABLE inbound_emails ADD COLUMN matched_entity_type TEXT;
ALTER TABLE inbound_emails ADD COLUMN matched_entity_id TEXT;
ALTER TABLE inbound_emails ADD COLUMN match_basis TEXT;
ALTER TABLE inbound_emails ADD COLUMN match_confidence REAL;

-- Supports the acceptance criterion "recognition rate at receipt is reportable
-- as a number" — today it is 0%. Partial, because the interesting query is
-- "which senders did we recognise", and NULL (predates capture) must stay
-- distinguishable from 'none' (we looked and found nobody).
CREATE INDEX IF NOT EXISTS idx_inbound_emails_match_basis
  ON inbound_emails(match_basis)
  WHERE match_basis IS NOT NULL;
