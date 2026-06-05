# EH1 Phase 1 backfill — operator runbook

**Filed:** 2026-06-05 alongside PR for `drizzle/0106_vendor_hierarchy.sql`.
**Status:** Data-model migration ships in the PR; backfill is operator-side because the parent-creation requires user-row strategy that's a product decision (see "Open question" below).

---

## Live D1 audit results (run 2026-06-05)

### Renewal by Andersen

| Status  | id (8)     | Slug                                                | Office                                | City, State              |
| ------- | ---------- | --------------------------------------------------- | ------------------------------------- | ------------------------ |
| live    | `0b3c4bd6` | renewal-by-andersen-of-boston                       | Boston                                | Northborough, MA         |
| live    | `4195736d` | renewal-by-andersen-of-greater-maine                | Greater Maine                         | Newport, ME              |
| live    | `bca928f0` | renewal-by-andersen-of-southern-maine-new-hampshire | Southern Maine / NH                   | Saco, ME                 |
| live    | `8e9d2f8f` | renewal-by-andersen-of-southern-new-england         | Southern New England                  | Smithfield, RI           |
| live    | `40f0807c` | renewal-by-andersen-of-vermont                      | Vermont                               | White River Junction, VT |
| deleted | `5a7718dd` | renewal-by-andersen                                 | (bare stub) → redirects to `8e9d2f8f` |
| deleted | `095d161d` | renewal-by-andersen-1                               | (bare stub) → redirects to `0b3c4bd6` |
| deleted | `acaee3db` | renewal-by-andersen-ri                              | (RI stub) → redirects to `8e9d2f8f`   |

**No live national parent.** All bare stubs were collapsed into local offices via `redirectToVendorId`.

### LeafFilter

| Status  | id (8)     | Slug                              | Notes                                                             |
| ------- | ---------- | --------------------------------- | ----------------------------------------------------------------- |
| live    | `dcbc061e` | leaffilter-north-of-massachusetts | Real office, Hopkinton MA                                         |
| live    | `552a332a` | leaffilter-gutter-protection-1    | Mis-typed `Marine` row — **do not touch** (backlog: discuss-only) |
| deleted | `7d38b483` | leaffilter-gutter-protection      | (bare stub) → redirects to `dcbc061e`                             |

---

## Open question: user-row strategy for the parent

The vendors table has `user_id NOT NULL UNIQUE REFERENCES users(id)`. A national parent record is not a claimable account — it's a brand wrapper around the local offices. Two options:

### Option A — placeholder system users (recommended)

Create a `users` row per parent with a system-style email:

- `national-parent-renewal-by-andersen@system.meetmeatthefair.com`
- `national-parent-leaffilter@system.meetmeatthefair.com`

These never sign in; they exist only to satisfy the FK. Mirrors the existing `system-community-suggestions` promoter pattern.

### Option B — schema change to make `vendors.user_id` nullable

Larger change (constraint migration; touches auth/claim logic). Phase 2 might require this anyway when claim interaction lands, but Phase 1 doesn't need it.

**Pick A** unless you have a reason to do the schema change now.

---

## Backfill SQL (option-A path)

Paste into the **Cloudflare MCP D1 query tool** (one statement at a time so you can verify counts between steps). Token must have D1 write scope on `takemetothefair-db`.

### Step 1 — create the two placeholder users

```sql
-- RbA placeholder
INSERT INTO users (id, email, name, role, created_at, updated_at)
VALUES (
  'sys-user-rba-national',
  'national-parent-renewal-by-andersen@system.meetmeatthefair.com',
  'Renewal by Andersen (system)',
  'VENDOR',
  unixepoch(),
  unixepoch()
)
ON CONFLICT (email) DO NOTHING;

-- LeafFilter placeholder
INSERT INTO users (id, email, name, role, created_at, updated_at)
VALUES (
  'sys-user-leaffilter-national',
  'national-parent-leaffilter@system.meetmeatthefair.com',
  'LeafFilter Gutter Protection (system)',
  'VENDOR',
  unixepoch(),
  unixepoch()
)
ON CONFLICT (email) DO NOTHING;
```

### Step 2 — create the two NATIONAL parent vendor rows

```sql
-- Renewal by Andersen national parent
INSERT INTO vendors (
  id, user_id, business_name, slug, description,
  role, default_display, override_permitted,
  created_at, updated_at
)
VALUES (
  'sys-vendor-rba-national',
  'sys-user-rba-national',
  'Renewal by Andersen',
  'renewal-by-andersen-national',
  'National window-replacement brand. Local New England offices operate as franchised affiliates — see linked offices for service area and contact info.',
  'NATIONAL',
  'LOCAL',
  0,
  unixepoch(),
  unixepoch()
)
ON CONFLICT (slug) DO NOTHING;

-- LeafFilter national parent
INSERT INTO vendors (
  id, user_id, business_name, slug, description,
  role, default_display, override_permitted,
  created_at, updated_at
)
VALUES (
  'sys-vendor-leaffilter-national',
  'sys-user-leaffilter-national',
  'LeafFilter Gutter Protection',
  'leaffilter-gutter-protection-national',
  'National gutter-protection brand. Local New England offices handle quotes and installation — see linked offices for service area and contact info.',
  'NATIONAL',
  'LOCAL',
  0,
  unixepoch(),
  unixepoch()
)
ON CONFLICT (slug) DO NOTHING;
```

### Step 3 — link the 5 RbA local offices

```sql
UPDATE vendors
SET role = 'LOCAL_OFFICE',
    parent_vendor_id = 'sys-vendor-rba-national',
    display_preference = 'INHERIT',
    override_permitted = 0,
    updated_at = unixepoch()
WHERE slug IN (
  'renewal-by-andersen-of-boston',
  'renewal-by-andersen-of-greater-maine',
  'renewal-by-andersen-of-southern-maine-new-hampshire',
  'renewal-by-andersen-of-southern-new-england',
  'renewal-by-andersen-of-vermont'
)
AND role = 'INDEPENDENT';   -- idempotent: skip already-linked rows
```

Expected: 5 rows updated on first run, 0 on subsequent runs.

### Step 4 — link the LeafFilter office

```sql
UPDATE vendors
SET role = 'LOCAL_OFFICE',
    parent_vendor_id = 'sys-vendor-leaffilter-national',
    display_preference = 'INHERIT',
    override_permitted = 0,
    updated_at = unixepoch()
WHERE slug = 'leaffilter-north-of-massachusetts'
AND role = 'INDEPENDENT';
```

Expected: 1 row updated on first run.

### Step 5 — verify

```sql
-- Parents
SELECT id, business_name, slug, role, default_display
FROM vendors
WHERE role = 'NATIONAL'
ORDER BY business_name;

-- Children
SELECT v.business_name, v.slug, v.role, v.display_preference, v.override_permitted,
       p.business_name AS parent_name
FROM vendors v
LEFT JOIN vendors p ON v.parent_vendor_id = p.id
WHERE v.role = 'LOCAL_OFFICE'
ORDER BY p.business_name, v.business_name;
```

Expected: 2 NATIONAL parents + 6 LOCAL_OFFICE children. The stray `leaffilter-gutter-protection-1` row should still show `role=INDEPENDENT` (untouched per the backlog's discuss-only directive).

---

## What's NOT in Phase 1 (deferred to Phase 2)

- **Public render change.** The hierarchy fields exist + the data is linked, but no page on the site reads them yet. National parent rows render as standalone vendor pages until Phase 2 wires display resolution + canonical/SEO handling.
- **Vendor claim interaction.** A LOCAL_OFFICE claim grants edit rights but doesn't bypass the parent's `override_permitted` gate. Phase 2 wires this end-to-end.
- **Data cleanup of the LeafFilter `Marine`-typed dup.** Backlog explicitly defers ("discuss-only, no DB action yet").
- **Additional brands** (Sea Tow, Bath Fitter, New York Life). Backlog sized them at "~a dozen" total; Phase 1 covers RbA + LeafFilter (the explicitly flagged priority pair). Additional brands can be added incrementally using the same SQL pattern.

---

## Rollback

To unwind the backfill (without dropping the columns):

```sql
UPDATE vendors
SET role = 'INDEPENDENT',
    parent_vendor_id = NULL,
    display_preference = NULL,
    override_permitted = 0,
    updated_at = unixepoch()
WHERE parent_vendor_id IN (
  'sys-vendor-rba-national',
  'sys-vendor-leaffilter-national'
);

DELETE FROM vendors WHERE id IN (
  'sys-vendor-rba-national',
  'sys-vendor-leaffilter-national'
);

DELETE FROM users WHERE id IN (
  'sys-user-rba-national',
  'sys-user-leaffilter-national'
);
```

To unwind the migration entirely (drops the 5 columns + 2 indexes):

```sql
DROP INDEX IF EXISTS idx_vendors_parent_vendor_id;
DROP INDEX IF EXISTS idx_vendors_role;
-- SQLite has no DROP COLUMN until 3.35; on D1 you'd need a table-rewrite
-- migration. Realistic rollback path: leave the columns in place, just
-- ensure no code reads them (revert Drizzle schema + any consumers).
```
