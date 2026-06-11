# Mutation-route access-control matrix (WS3a, 2026-06-11)

Audit of every `POST/PUT/PATCH/DELETE` handler under `src/app/api/{admin,vendor,promoter,user,suggest-event,newsletter,report-problem}/**`, focused on the IDOR question: **can a non-owner mutate another user's resource?**

**Result: zero confirmed IDOR.** Every owner-scoped mutation route resolves the
actor's `vendor`/`promoter`/`user` row by `userId = session.user.id` and scopes
the mutation to that owner's id (or, for token routes, validates token → user →
resource). The codebase follows one consistent pattern: authenticate → look up
the owner record by session userId → scope all writes to that owner.

## Matrix (representative; verdict column is the IDOR finding)

| Path | Method | AuthN | Ownership scope | Verdict |
| --- | --- | --- | --- | --- |
| `/api/vendor/profile` | PATCH | `requireVerifiedSession` | `WHERE userId = gate.userId` | OK |
| `/api/vendor/applications` | POST | `requireVerifiedSession` | vendor via `userId` | OK |
| `/api/vendor/applications/[id]` | DELETE | `auth()` | `vendorId IN (vendors WHERE userId=session)` | OK |
| `/api/vendor/claim/{initiate,confirm,direct}` | POST/GET | `auth()` (+verified email) | token / email-match gated | OK |
| `/api/promoter/events` | POST | `auth()` | promoter via `userId` | OK |
| `/api/promoter/events/draft` | POST | `auth()` | `WHERE promoterId = promoter.id` | OK |
| `/api/promoter/claim/direct` | POST | `auth()` +verified email | email-match gated | OK |
| `/api/user/profile` | PATCH | `auth()` | `WHERE id = session.user.id` | OK |
| `/api/user/api-tokens` | POST/DELETE | `auth()` | `WHERE userId = session.user.id` | OK |
| `/api/favorites` | POST/DELETE | `auth()` | `WHERE userId = session.user.id` | OK |
| `/api/vendors/[slug]/applications` | PATCH | vendor API token | token → user → vendor(slug) | OK |
| `/api/suggest-event/submit` | POST | internal-key OR Turnstile+rate-limit | public submission | OK |
| `/api/newsletter/*`, `/api/report-problem` | POST/GET | public + rate-limit / token | no user resource | OK |
| `/api/admin/**` (all) | * | `role=ADMIN` OR `X-Internal-Key` | admin-only (ownership N/A) | OK |

## Verified false positive

- **`POST /api/blog-posts` `authorId` override** — flagged as "privilege
  escalation," but `getAuthorizedSession` admits only an ADMIN session or the
  `X-Internal-Key` (POST excludes the read-only Bearer). Both callers are fully
  trusted and *legitimately* set an arbitrary `authorId` (the MCP
  `create_blog_post` tool depends on it). No untrusted actor can reach it;
  "fixing" it would break blog authoring. **Left as-is.**

## Hardening shipped alongside this audit

- **WS3b** — 9 route handlers migrated off the inline, timing-unsafe
  `internalKey === env.INTERNAL_API_KEY` to the shared constant-time
  `internalKeyMatches(request)` (`src/lib/api-auth.ts`). The `x-internal-key`
  *producer* sites (reclassify, inbound-emails/retry, report-problem) were left
  untouched — they send the key downstream, they don't verify it.
- **WS3d** — `PATCH /api/admin/users/[id]` now writes a `user.role_change`
  `admin_actions` row (previous → new role) when an admin changes a user's role.

## Known follow-up (out of WS3 scope, noted not fixed)

- `PATCH /api/admin/users/[id]` updates `users.role` (primary) but does **not**
  sync the `user_roles` array, so `hasRole()` (which reads the array) won't
  reflect an admin-changed primary role until the user re-acquires it. Predates
  this work; auth.ts already flags the array as the intended source of truth
  with a planned caller sweep. Tracked separately because it touches auth
  behavior and needs its own test pass.
