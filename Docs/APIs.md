# API Documentation

All API routes for the Take Me To The Fair application. Base path: `/api/`.

**Auth levels:**
- **None** — Public access
- **User** — Requires authenticated session (`session.user.id`)
- **Admin** — Requires `session.user.role === "ADMIN"`

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Admin: Events](#2-admin-events)
3. [Admin: Venues](#3-admin-venues)
4. [Admin: Vendors](#4-admin-vendors)
5. [Admin: Promoters](#5-admin-promoters)
6. [Admin: Users](#6-admin-users)
7. [Admin: Import](#7-admin-import)
8. [Admin: Database](#8-admin-database)
9. [Admin: Duplicates](#9-admin-duplicates)
10. [Admin: Logs](#10-admin-logs)
11. [Public: Events](#11-public-events)
12. [Public: Venues](#12-public-venues)
13. [Public: Vendors](#13-public-vendors)
14. [User: Favorites](#14-user-favorites)
15. [User: Profile](#15-user-profile)
16. [Vendor: Profile & Applications](#16-vendor-profile--applications)
17. [Promoter: Events](#17-promoter-events)

---

## 1. Authentication

### `GET|POST /api/auth/[...nextauth]`
- **Auth:** NextAuth internal
- **Description:** NextAuth.js catch-all handler for sign-in, sign-out, session, and callback flows.

### `POST /api/auth/register`
- **Auth:** None
- **Description:** Register a new user account. Optionally creates a promoter or vendor profile.
- **Request body:**
  ```json
  {
    "email": "string (required)",
    "password": "string (required, min 8 chars)",
    "name": "string (required, min 2 chars)",
    "role": "USER | PROMOTER | VENDOR (default USER)",
    "companyName": "string (for PROMOTER)",
    "businessName": "string (for VENDOR)"
  }
  ```
- **Response (201):**
  ```json
  { "message": "string", "user": { "id": "string", "email": "string", "name": "string", "role": "string" } }
  ```

---

## 2. Admin: Events

### `GET /api/admin/events`
- **Auth:** Admin
- **Description:** List all events with venue/promoter info and vendor counts.
- **Query params:** `status` — `PENDING | APPROVED | REJECTED`
- **Response:** Array of event objects.

### `POST /api/admin/events`
- **Auth:** Admin
- **Description:** Create a new event.
- **Request body:**
  ```json
  {
    "name": "string", "slug": "string", "description": "string",
    "venueId": "string", "promoterId": "string",
    "startDate": "ISO date", "endDate": "ISO date", "datesConfirmed": "boolean",
    "categories": "string", "tags": "string",
    "ticketUrl": "string", "ticketPriceMin": "number", "ticketPriceMax": "number",
    "imageUrl": "string", "featured": "boolean",
    "commercialVendorsAllowed": "boolean", "status": "string",
    "sourceName": "string", "sourceUrl": "string", "sourceId": "string",
    "eventDays": "array"
  }
  ```
- **Response (201):** Created event object.

### `GET /api/admin/events/[id]`
- **Auth:** Admin
- **Description:** Get a single event with full details including venue, promoter, vendors, and event days.

### `PATCH /api/admin/events/[id]`
- **Auth:** Admin
- **Description:** Update event details. Auto-updates slug if name changes.
- **Request body:** Partial event fields (same shape as POST).
- **Response:** Updated event object.

### `DELETE /api/admin/events/[id]`
- **Auth:** Admin
- **Description:** Delete an event.
- **Response:** `{ "success": true }`

### `POST /api/admin/events/[id]/approve`
- **Auth:** Admin
- **Description:** Approve a pending event (sets status to `APPROVED`).
- **Response:** Updated event object.

### `POST /api/admin/events/[id]/reject`
- **Auth:** Admin
- **Description:** Reject a pending event (sets status to `REJECTED`).
- **Response:** Updated event object.

### `GET /api/admin/events/[id]/vendors`
- **Auth:** Admin
- **Description:** List vendors for a specific event.
- **Response:** Array of vendors with event_vendor junction data.

### `POST /api/admin/events/[id]/vendors`
- **Auth:** Admin
- **Description:** Add a vendor to an event.
- **Request body:** `{ "vendorId": "string", "status": "string", "boothInfo": "string" }`
- **Response (201):** Created event_vendor record.

### `PATCH /api/admin/events/[id]/vendors`
- **Auth:** Admin
- **Description:** Update a vendor's status/info for an event.
- **Request body:** `{ "eventVendorId": "string", "status": "string", "boothInfo": "string" }`
- **Response:** Updated event_vendor record.

### `DELETE /api/admin/events/[id]/vendors`
- **Auth:** Admin
- **Description:** Remove a vendor from an event.
- **Query params:** `eventVendorId` (required)
- **Response:** `{ "success": true }`

---

## 3. Admin: Venues

### `GET /api/admin/venues`
- **Auth:** Admin
- **Description:** List all venues with event counts.

### `POST /api/admin/venues`
- **Auth:** Admin
- **Description:** Create a new venue.
- **Request body:**
  ```json
  {
    "name": "string", "address": "string", "city": "string", "state": "string", "zip": "string",
    "latitude": "number", "longitude": "number", "capacity": "number",
    "amenities": "string", "contactEmail": "string", "contactPhone": "string",
    "website": "string", "description": "string", "imageUrl": "string",
    "googlePlaceId": "string", "googleMapsUrl": "string", "openingHours": "string",
    "googleRating": "number", "googleRatingCount": "number", "googleTypes": "string",
    "accessibility": "string", "parking": "string", "status": "string"
  }
  ```
- **Response (201):** Created venue object.

### `GET /api/admin/venues/[id]`
- **Auth:** Admin
- **Description:** Get venue details with recent 10 events.

### `PATCH /api/admin/venues/[id]`
- **Auth:** Admin
- **Description:** Update venue details. Auto-updates slug if name changes.
- **Request body:** Partial venue fields (same shape as POST).
- **Response:** Updated venue object.

### `DELETE /api/admin/venues/[id]`
- **Auth:** Admin
- **Description:** Delete a venue.
- **Response:** `{ "success": true }`

### `POST /api/admin/venues/geocode`
- **Auth:** Admin
- **Description:** Geocode a single address using Google Maps API.
- **Request body:** `{ "address": "string", "city": "string", "state": "string", "zip": "string" }`
- **Response:** `{ "lat": "number", "lng": "number", "zip": "string" }`

### `POST /api/admin/venues/geocode-batch`
- **Auth:** Admin
- **Description:** Geocode all venues missing coordinates.
- **Response:** `{ "success": "number", "failed": "number", "total": "number" }`

### `POST /api/admin/venues/google-backfill/preview`
- **Auth:** Admin
- **Description:** Preview Google Places matches for venues missing Google data.
- **Response:** Array of preview objects with venue and Google match info.

### `POST /api/admin/venues/google-backfill`
- **Auth:** Admin
- **Description:** Backfill Google Places data for venues.
- **Request body:** `{ "venueIds": ["string"] }` (optional, defaults to all missing)
- **Response:** `{ "success": "number", "failed": "number", "skipped": "number", "total": "number" }`

### `POST /api/admin/venues/lookup`
- **Auth:** Admin
- **Description:** Look up a venue on Google Places.
- **Request body:** `{ "name": "string", "city": "string", "state": "string" }`
- **Response:** Google Places result with name, placeId, rating, address, photos, etc.

---

## 4. Admin: Vendors

### `GET /api/admin/vendors`
- **Auth:** Admin
- **Description:** List all vendors with event counts.

### `POST /api/admin/vendors`
- **Auth:** Admin
- **Description:** Create a new vendor profile.
- **Request body:**
  ```json
  {
    "userId": "string", "businessName": "string", "description": "string",
    "vendorType": "string", "products": "string", "website": "string",
    "socialLinks": "string", "logoUrl": "string", "verified": "boolean",
    "commercial": "boolean", "contactName": "string", "contactEmail": "string",
    "contactPhone": "string", "address": "string", "city": "string",
    "state": "string", "zip": "string", "yearEstablished": "number",
    "paymentMethods": "string", "licenseInfo": "string", "insuranceInfo": "string"
  }
  ```
- **Response (201):** Created vendor object.

### `GET /api/admin/vendors/[id]`
- **Auth:** Admin
- **Description:** Get vendor details with user info and event_vendor relationships.

### `PATCH /api/admin/vendors/[id]`
- **Auth:** Admin
- **Description:** Update vendor details.
- **Request body:** Partial vendor fields (same shape as POST minus `userId`).
- **Response:** Updated vendor object.

### `DELETE /api/admin/vendors/[id]`
- **Auth:** Admin
- **Description:** Delete a vendor. Resets linked user role to `USER`.
- **Response:** `{ "success": true }`

---

## 5. Admin: Promoters

### `GET /api/admin/promoters`
- **Auth:** Admin
- **Description:** List all promoters with event counts.

### `POST /api/admin/promoters`
- **Auth:** Admin
- **Description:** Create a new promoter profile.
- **Request body:**
  ```json
  {
    "userId": "string", "companyName": "string", "description": "string",
    "website": "string", "socialLinks": "string", "logoUrl": "string", "verified": "boolean"
  }
  ```
- **Response (201):** Created promoter object.

### `GET /api/admin/promoters/[id]`
- **Auth:** Admin
- **Description:** Get promoter details with user info and recent 10 events.

### `PATCH /api/admin/promoters/[id]`
- **Auth:** Admin
- **Description:** Update promoter details.
- **Request body:** `{ "companyName": "string", "description": "string", "website": "string", "logoUrl": "string", "verified": "boolean" }` (all optional)
- **Response:** Updated promoter object.

### `DELETE /api/admin/promoters/[id]`
- **Auth:** Admin
- **Description:** Delete a promoter. Resets linked user role to `USER`.
- **Response:** `{ "success": true }`

---

## 6. Admin: Users

### `GET /api/admin/users`
- **Auth:** Admin
- **Description:** List users. Optionally filter by availability for role assignment.
- **Query params:** `available` — `promoter | vendor` (returns users not yet assigned that role)
- **Response:** Array of `{ "id", "email", "name", "role", "createdAt" }`.

### `PATCH /api/admin/users/[id]`
- **Auth:** Admin
- **Description:** Update a user's role or name.
- **Request body:** `{ "role": "string", "name": "string" }` (both optional)
- **Response:** `{ "id", "email", "name", "role" }`

---

## 7. Admin: Import

### `GET /api/admin/import`
- **Auth:** Admin
- **Description:** Preview events from a scraper source before importing.
- **Query params:** `source` (e.g. `mainefairs.net`), `fetchDetails` (`true/false`), `customUrl`
- **Response:**
  ```json
  { "source": "string", "events": [{ "...event", "exists": "boolean", "existingId": "string" }], "total": "number", "newCount": "number", "existingCount": "number" }
  ```

### `POST /api/admin/import`
- **Auth:** Admin
- **Description:** Import scraped events. Auto-creates venues and geocodes as needed.
- **Request body:**
  ```json
  { "events": "ScrapedEvent[]", "venueId": "string", "promoterId": "string", "fetchDetails": "boolean", "updateExisting": "boolean" }
  ```
- **Response:**
  ```json
  { "imported": "number", "updated": "number", "skipped": "number", "venuesCreated": "number", "errors": "array", "importedEvents": "array", "updatedEvents": "array" }
  ```

### `PATCH /api/admin/import`
- **Auth:** Admin
- **Description:** Sync all events with `sync_enabled` flag from their sources.
- **Response:** `{ "synced": "number", "unchanged": "number", "errors": "array" }`

### `GET /api/admin/import-url/fetch`
- **Auth:** Admin
- **Description:** Fetch and parse HTML from a URL. Includes SSRF protection (blocks private IPs/localhost).
- **Query params:** `url` (required, http/https only)
- **Response:** `{ "success": "boolean", "content": "string", "title": "string", "ogImage": "string", "jsonLd": "object" }`

### `POST /api/admin/import-url/extract`
- **Auth:** Admin
- **Description:** Use AI to extract event data from HTML content.
- **Request body:** `{ "content": "string", "url": "string", "metadata": "object" }`
- **Response:** `{ "success": "boolean", "events": "array", "confidence": "object", "count": "number" }`

### `POST /api/admin/import-url`
- **Auth:** Admin
- **Description:** Save an extracted event to the database. Creates venue if needed, auto-geocodes.
- **Request body:**
  ```json
  {
    "event": "ExtractedEventData",
    "venueOption": { "type": "existing | new | none", "id": "string", "name": "string", "address": "string", "city": "string", "state": "string" },
    "promoterId": "string",
    "sourceUrl": "string"
  }
  ```
- **Response:** `{ "success": "boolean", "event": { "id": "string", "slug": "string" }, "venueId": "string" }`

---

## 8. Admin: Database

### `GET /api/admin/database/backup`
- **Auth:** Admin
- **Description:** Generate and download a complete database backup as a `.sql` file.
- **Response:** SQL dump file (downloadable).

### `POST /api/admin/database/restore`
- **Auth:** Admin
- **Description:** Restore database from a SQL backup file.
- **Request body:** FormData with `file` (SQL file) and `confirm` (`"yes-restore-database"`).
- **Response:**
  ```json
  { "success": "boolean", "message": "string", "details": { "tablesDropped": "number", "tablesCreated": "number", "rowsInserted": "number", "indexesCreated": "number", "errors": "array", "totalErrors": "number" } }
  ```

### `GET /api/admin/database/stats`
- **Auth:** Admin
- **Description:** Get database statistics.
- **Response:**
  ```json
  { "tables": [{ "name": "string", "rowCount": "number" }], "summary": { "tableCount": "number", "totalRows": "number", "indexCount": "number" } }
  ```

---

## 9. Admin: Duplicates

### `GET /api/admin/duplicates`
- **Auth:** Admin
- **Description:** Find duplicate entities using Levenshtein similarity matching.
- **Query params:** `type` (`venues | events | vendors | promoters`), `threshold` (0-1, default 0.7)
- **Response:**
  ```json
  { "type": "string", "threshold": "number", "duplicates": [{ "entity1": "object", "entity2": "object", "similarity": "number", "matchedFields": "array" }], "totalEntities": "number" }
  ```

### `POST /api/admin/duplicates/preview`
- **Auth:** Admin
- **Description:** Preview how two duplicate entities would be merged.
- **Request body:** `{ "type": "string", "primaryId": "string", "duplicateId": "string" }`
- **Response:** Field-by-field merge comparison.

### `POST /api/admin/duplicates/merge`
- **Auth:** Admin
- **Description:** Merge two duplicates. Primary keeps all data; duplicate is deleted.
- **Request body:** `{ "type": "string", "primaryId": "string", "duplicateId": "string" }`
- **Response:** Merge result with updated entity.

---

## 10. Admin: Logs

### `GET /api/admin/logs`
- **Auth:** Admin
- **Description:** Query error logs with filtering and search.
- **Query params:** `limit` (max 200, default 50), `level`, `source`, `q` (message search)
- **Response:** Array of log entries `{ "id", "timestamp", "level", "message", "context", "url", "method", "statusCode", "stackTrace", "userAgent", "source" }`.

---

## 11. Public: Events

### `GET /api/events/[slug]/vendors`
- **Auth:** None
- **Description:** Get approved vendors for an approved event.
- **Response:**
  ```json
  { "event": { "id": "string", "name": "string", "slug": "string" }, "vendors": [{ "id", "businessName", "slug", "vendorType", "logoUrl", "description", "verified", "products" }] }
  ```

### `GET /api/events/export`
- **Auth:** User
- **Description:** Export filtered events to CSV.
- **Query params:** `query`, `category`, `state`, `featured`, `commercialVendors`, `includePast`
- **Response:** CSV file (columns: Event, Venue, City, State, Start Date, End Date, Website).

---

## 12. Public: Venues

### `GET /api/venues`
- **Auth:** None
- **Description:** Get basic venue list for dropdowns/selectors.
- **Response:** Array of `{ "id", "name", "city", "state" }`.

### `GET /api/venues/export`
- **Auth:** User
- **Description:** Export filtered venues to CSV.
- **Query params:** `q` (search), `state`
- **Response:** CSV file (columns: Venue, Address, City, State, Zip, Capacity, Amenities, Website, Upcoming Events).

---

## 13. Public: Vendors

### `GET /api/vendors/[slug]/events`
- **Auth:** None
- **Description:** Get approved events for a vendor.
- **Response:**
  ```json
  { "vendor": { "id", "businessName", "slug" }, "events": [{ "id", "name", "slug", "description", "startDate", "endDate", "imageUrl", "categories", "venue": { "name", "city", "state", "address", "zip" } }] }
  ```

### `GET /api/vendors/export`
- **Auth:** User
- **Description:** Export filtered vendors to CSV.
- **Query params:** `type`, `hasEvents` (`true/false`), `q` (search)
- **Response:** CSV file (columns: Business Name, Type, Description, Products, Website, Contact Name, Contact Email, Contact Phone, Address, City, State, ZIP, Year Established, Payment Methods, License Info, Insurance Info, Verified, Commercial, Upcoming Events).

---

## 14. User: Favorites

### `GET /api/favorites`
- **Auth:** Optional (returns empty array if not logged in)
- **Description:** Get user's favorites, optionally filtered by type.
- **Query params:** `type` (`EVENT | VENUE | VENDOR | PROMOTER`)
- **Response:** `{ "favorites": [{ "id", "favoritableType", "favoritableId" }] }`

### `POST /api/favorites`
- **Auth:** User
- **Description:** Add item to favorites (idempotent).
- **Request body:** `{ "type": "string", "id": "string" }`
- **Response:** `{ "favorited": true, "message": "string" }`

### `DELETE /api/favorites`
- **Auth:** User
- **Description:** Remove item from favorites.
- **Query params:** `type`, `id` (both required)
- **Response:** `{ "favorited": false, "message": "string" }`

---

## 15. User: Profile

### `PATCH /api/user/profile`
- **Auth:** User
- **Description:** Update user name.
- **Request body:** `{ "name": "string" }`
- **Response:** `{ "id", "email", "name" }`

---

## 16. Vendor: Profile & Applications

### `GET /api/vendor/profile`
- **Auth:** User
- **Description:** Get authenticated vendor's profile.

### `PATCH /api/vendor/profile`
- **Auth:** User
- **Description:** Update vendor profile details.
- **Request body:** `{ "businessName", "description", "vendorType", "products", "website", "logoUrl", "contactName", "contactEmail", "contactPhone", "address", "city", "state", "zip", "yearEstablished", "paymentMethods", "licenseInfo", "insuranceInfo" }` (all optional)
- **Response:** Updated vendor object.

### `GET /api/vendor/applications`
- **Auth:** User
- **Description:** Get vendor's event applications.
- **Response:** Array of event_vendor application records.

### `POST /api/vendor/applications`
- **Auth:** User
- **Description:** Submit vendor application to an event. Validates event approval status and commercial vendor restrictions.
- **Request body:** `{ "eventId": "string", "boothInfo": "string" }`
- **Response (201):** Created event_vendor record (status: `PENDING`).

---

## 17. Promoter: Events

### `GET /api/promoter/events`
- **Auth:** User
- **Description:** Get events created by the authenticated promoter.
- **Response:** Array of events with venue name.

### `POST /api/promoter/events`
- **Auth:** User
- **Description:** Create a new event as a promoter (status defaults to `PENDING`).
- **Request body:**
  ```json
  {
    "name": "string", "description": "string", "venueId": "string",
    "startDate": "ISO date", "endDate": "ISO date",
    "categories": "string", "tags": "string",
    "ticketUrl": "string", "ticketPriceMin": "number", "ticketPriceMax": "number",
    "imageUrl": "string", "eventDays": "array"
  }
  ```
- **Response (201):** Created event object.
