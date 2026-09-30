-- OPE-1178 — product_ideas: features and improvements worth remembering, kept
-- apart from every defect ledger so an idea never inflates a defect count or
-- gets "resolved" by a fault workflow. See packages/db-schema (productIdeas).
-- Additive; a no-op on an empty database apart from the new table.
CREATE TABLE product_ideas (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  product TEXT NOT NULL DEFAULT 'mmatf',
  area TEXT,
  source_type TEXT NOT NULL DEFAULT 'other',
  source_ref TEXT,
  extra_source_refs TEXT NOT NULL DEFAULT '[]',
  source_person TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  linked_issue TEXT,
  votes INTEGER NOT NULL DEFAULT 1,
  related_refs TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_product_ideas_status ON product_ideas (status);
CREATE INDEX idx_product_ideas_created_at ON product_ideas (created_at);
