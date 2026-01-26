-- Add commercial field to vendors table
ALTER TABLE vendors ADD COLUMN commercial INTEGER DEFAULT 0;
