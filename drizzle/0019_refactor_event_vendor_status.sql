-- Add payment_status column
ALTER TABLE event_vendors ADD COLUMN payment_status text DEFAULT 'NOT_REQUIRED' NOT NULL;

-- Migrate existing data: APPROVED + accepted=1 → CONFIRMED
UPDATE event_vendors SET status = 'CONFIRMED' WHERE status = 'APPROVED' AND accepted = 1;

-- Migrate: PENDING + applied=1 → APPLIED
UPDATE event_vendors SET status = 'APPLIED' WHERE status = 'PENDING' AND applied = 1;

-- Migrate: PENDING + interested=1 (not applied) → INTERESTED
UPDATE event_vendors SET status = 'INTERESTED' WHERE status = 'PENDING' AND interested = 1 AND (applied = 0 OR applied IS NULL);

-- Migrate: remaining PENDING → APPLIED (safe default)
UPDATE event_vendors SET status = 'APPLIED' WHERE status = 'PENDING';

-- Null out deprecated boolean columns (keep columns for D1 safety)
UPDATE event_vendors SET interested = NULL, applied = NULL, accepted = NULL;
