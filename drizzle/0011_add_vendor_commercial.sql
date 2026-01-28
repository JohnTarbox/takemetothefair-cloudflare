-- Add commercial flag to vendors table
ALTER TABLE vendors ADD COLUMN commercial INTEGER DEFAULT false;
