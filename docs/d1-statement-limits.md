# D1 statement limits — the measured list

**Family: FAM-D1-PARAMCAP.** Cloudflare's D1 sets several SQLite compile-time
limits far below SQLite's own defaults, and its published limits page does not
list them. This file is the durable enumeration OPE-593 asked for, so the next
person hits the note instead of the wall.

Every value below is **measured against the live production database**
(`takemetothefair-db`, `d449e416-3814-48a6-b9e8-b676333b2cdc`) by bracketing —
the largest passing statement and the smallest failing one — not read from
documentation and not estimated.

## The caps

| #   | Limit                          | D1      | SQLite default | Error text                                         | Guard                              |
| --- | ------------------------------ | ------- | -------------- | -------------------------------------------------- | ---------------------------------- |
| 1   | Columns in a result set        | **100** | 2000           | `too many columns in result set`                   | `scripts/check-d1-100col-joins.ts` |
| 2   | Bound parameters per statement | **100** | 32766          | `too many SQL variables`                           | CI guard (OPE-241) + `chunkIds`    |
| 3   | LIKE / GLOB pattern length     | **50**  | 50000          | `LIKE or GLOB pattern too complex`                 | `containsCI()` (OPE-565)           |
| 4   | Terms in a compound SELECT     | **5**   | 500            | `too many terms in compound SELECT`                | see §Reachability                  |
| 5   | Expression tree depth          | **100** | 1000           | `Expression tree is too large (maximum depth 100)` | `MAX_FUZZY_TOKENS` (OPE-593)       |
| 6   | Arguments to a function        | **100** | 127            | `too many arguments on function <fn>`              | see §Reachability                  |

### Brackets, for caps 4–6 (measured 2026-08-28)

```
compound SELECT   SELECT 1 UNION ALL … ×5   -> ok
                  SELECT 1 UNION ALL … ×6   -> 7500
                  => 5 terms, i.e. FOUR UNIONs

expression depth  SELECT 1 WHERE 1=1 OR …  99 terms -> ok
                  SELECT 1 WHERE 1=1 OR … 120 terms -> 7500
                  => depth 100; a left-nested OR chain costs ~1 per term

function args     SELECT max(1,…,100)  -> ok
                  SELECT max(1,…,128)  -> 7500
                  => 100 args
```

## Why this file exists rather than a fourth bespoke guard

Caps 1, 2 and 3 were each discovered **in production, by a user-facing page
failing**, and then guarded individually. Three outages, three guards, and no
pass ever asked _which caps have we not hit yet_. Caps 4, 5 and 6 were found in
minutes by probing, before any outage.

The class also fails **silently on the public site**: per OPE-574, render faults
behind the error boundary serve HTTP 200 — all 61 D1 failures on `/events`
returned 200. So a statement that reaches one of these caps presents as a page
every status-code check we own reports as healthy.

## Reachability — the question that matters

A cap only becomes an outage when a code path scales toward it with **row count
or user input**. Those two turned the first three into outages: a JOIN that
widened, an `inArray()` that grew with the table, a LIKE pattern built from a
search box.

| #   | Reachable today?                | Evidence                                                                                                                                                                                                                  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | guarded                         | `check-d1-100col-joins.ts` fails the build                                                                                                                                                                                |
| 2   | guarded                         | OPE-241 CI guard + `chunkIds`                                                                                                                                                                                             |
| 3   | guarded                         | `containsCI()`; OPE-565 swept the remaining call sites                                                                                                                                                                    |
| 4   | **not reachable**               | Stronger than expected: a grep of `src/`, `mcp-server/src/` and `packages/*/src/` finds **no SQL `UNION` at all** in production source (the only `union(` hits are Zod's `z.union`). There is no compound SELECT to grow. |
| 5   | **was reachable — now guarded** | `search_events` fuzzy built one OR term per query token with no cap (see below)                                                                                                                                           |
| 6   | **not reachable**               | No call site builds a variable-length argument list into a SQL function. Every `COALESCE(...)` in the codebase is fixed 2-arity, and no `sql` template joins an array into a function's parentheses.                      |

### Cap 5, the one that was live

`search_events`' fuzzy path tokenized the caller's free-text `query` and OR'd
one predicate per token:

```ts
const tokens = tokenize(params.query); // uncapped
const tokenLikes = tokens.map(nameOrVariantLike);
const fuzzyOr = or(...tokenLikes);
```

`nameOrVariantLike` is itself `or(like(name, ?), EXISTS(…))`, so **each token
costs about 2 levels of expression depth**, and `tokenize()` had no ceiling.
Roughly 50 tokens of free text — an ordinary pasted event blurb — would exceed
depth 100 and throw. It had not fired only because callers happened to send
short queries.

Guarded by `MAX_FUZZY_TOKENS` in `mcp-server/src/tools/public.ts`.

## Testing these is engine-dependent, and that is the trap

**A behavioural test cannot catch any of these.** The suite runs
better-sqlite3, whose limits are SQLite's defaults — 32766 bind parameters,
50000-char LIKE patterns, depth 1000 — so the failing statement executes
happily in-process. This is documented from experience twice over:

- OPE-517's followup: _"150 rows, call fuzzy search, expect no throw" PASSES
  WITHOUT THE FIX … verified by reverting the chunking: 4/4 still green._
- OPE-565: local sqlite allows 50000-char LIKE patterns, so no unit test could
  ever catch the 50-char cap.

So guards for this family must assert a **structural** property that survives
the engine difference — the shape of the statement, or the cap applied before
it is built — never "it did not throw".
