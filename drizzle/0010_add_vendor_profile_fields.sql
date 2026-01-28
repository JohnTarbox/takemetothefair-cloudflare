-- Add comprehensive vendor profile fields

-- Contact Information
ALTER TABLE vendors ADD COLUMN contact_name TEXT;
ALTER TABLE vendors ADD COLUMN contact_email TEXT;
ALTER TABLE vendors ADD COLUMN contact_phone TEXT;

-- Physical Address
ALTER TABLE vendors ADD COLUMN address TEXT;
ALTER TABLE vendors ADD COLUMN city TEXT;
ALTER TABLE vendors ADD COLUMN state TEXT;
ALTER TABLE vendors ADD COLUMN zip TEXT;

-- Business Details
ALTER TABLE vendors ADD COLUMN year_established INTEGER;
ALTER TABLE vendors ADD COLUMN payment_methods TEXT DEFAULT '[]';
ALTER TABLE vendors ADD COLUMN license_info TEXT;
ALTER TABLE vendors ADD COLUMN insurance_info TEXT;
