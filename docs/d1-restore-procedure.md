# D1 restore — the procedure, and the drill that proved it works

**Written 2026-08-28 for OPE-594.** Everything below was measured against the
live account (`John Tarbox - Account`, `e6011e48b7014ef83c77e3c767dac6cf`), not
read from documentation. Where a number came from a doc it says so.

Written for a 3 a.m. reader. Start at "If something just went wrong".

---

## If something just went wrong — the short version

```bash
set -a; . ./.env; set +a          # the project's own CLOUDFLARE_API_TOKEN
npx wrangler whoami               # ALWAYS. Confirm "John Tarbox - Account".

# 1. What can we go back to?
npx wrangler d1 time-travel info takemetothefair-db

# 2. Find the bookmark for a moment BEFORE the damage.
npx wrangler d1 time-travel info takemetothefair-db \
  --timestamp="2026-08-28T14:00:00Z"

# 3. Restore. THIS OVERWRITES THE LIVE DATABASE IN PLACE.
npx wrangler d1 time-travel restore takemetothefair-db --bookmark=<BOOKMARK>

# 4. The output prints an UNDO bookmark. Save it before doing anything else.
# 5. Read back. Do not trust the success message.
npx wrangler d1 execute takemetothefair-db --remote \
  --command "SELECT (SELECT COUNT(*) FROM events) e,
                    (SELECT COUNT(*) FROM vendors) v,
                    (SELECT COUNT(*) FROM event_vendors) ev;"
```

---

## ⚠️ The thing most likely to be got wrong

**Time Travel cannot restore into a different database.** It only overwrites in
place. Cloudflare's own wording:

> "Restoring a database to a specific point-in-time is a **destructive**
> operation, and **overwrites the database in place**."
> — <https://developers.cloudflare.com/d1/reference/time-travel/>

OPE-594 was written asking for a drill that restores "to a _new_ database, not
over the live one". **That operation does not exist.** Anyone planning a restore
on the assumption that they can stage it side-by-side first will discover this
at the worst possible moment.

What you _can_ do side-by-side is an **export**, which is a different tool and
does not exercise Time Travel:

```bash
npx wrangler d1 export takemetothefair-db --remote --output=backup.sql
npx wrangler d1 create restore-check
npx wrangler d1 execute restore-check --remote --file=backup.sql
```

That validates the _data_. It does not validate the _restore path_.

**The restore is itself reversible.** The command prints an undo bookmark
pointing at the state you just overwrote. Measured in the drill below. It is
the only thing standing between "restored to the wrong point" and permanent
loss, and it is printed once — capture it.

---

## Measured facts

| Question                                        | Answer                                         | How it was established                                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is Time Travel enabled on `takemetothefair-db`? | **Yes**                                        | `time-travel info` returns a live bookmark                                                                                                                                |
| How far back does it reach?                     | **30 days**                                    | bracketed by probe — 8, 25 and 29 days ago all resolve to bookmarks; **31 days ago is refused**: `Invalid timestamp … Please provide a timestamp within the last 30 days` |
| Which plan tier is that?                        | **Workers Paid**                               | the docs give 30 days (Paid) / 7 days (Free); we measured 30                                                                                                              |
| RPO                                             | **≈ 0 within the window**                      | Time Travel is continuous — a bookmark exists per write, and any _timestamp_ resolves to one. There are no snapshot boundaries to fall between.                           |
| RTO                                             | **3 s on a trivial database** — see the caveat | measured end-to-end in the drill                                                                                                                                          |

### ⚠️ Do not quote the 3-second RTO for production

The drill ran against a database holding one table and three rows. Production is
**216 MiB across 124 tables**. The 3 s figure proves the _mechanism_ is fast to
invoke, not that a 216 MiB restore takes 3 s. **Production RTO is unmeasured**,
and measuring it honestly would require restoring production, which is exactly
the destructive act nobody should rehearse on live data.

---

## The drill that was actually run (2026-08-28)

Against a throwaway database, created and deleted for the purpose. Production
was never touched.

```
1. create   ope594-restore-drill-throwaway
2. seed     3 rows                                  -> COUNT = 3
3. bookmark 00000000-0000000a-000050d5-0ab6749a…    <- the good state
4. break    DELETE FROM drill                       -> COUNT = 0
5. restore  --bookmark=<the above>                  -> 3 s
6. READ BACK                                        -> COUNT = 3, contents intact
7. delete   the throwaway database
```

Step 6 is the acceptance. "Time Travel exists" is not the same claim as "a
restore ran and reconciled", and only the second one is worth anything at 3 a.m.

The restore printed its undo bookmark as documented:
`00000000-ffffffff-000050d5-ea2c12be…`

---

## Why this matters more here than the byte count suggests

The irreplaceable part of the database is not its size — it is that most of it
**cannot be re-derived**:

```
events          1,933      event_vendors   6,596   <- hand-sourced exhibitor links
vendors         6,559      content_links   2,042
enrichment_log 17,414      event_schema_org  375
```

A re-scrape does not restore this. The provenance _is_ the work. And for past
events it is not recoverable at all: an exhibitor page serves the **current**
edition, so re-researching a finished fair writes next year's vendors onto it.

Pointed at that data are twelve bulk-mutation MCP tools — `merge_events`,
`merge_vendor`, `merge_venue`, `merge_promoter`, `merge_performer`,
`bulk_create_event_citations`, `rebuild_content_links`, `backfill_event_series`,
`backfill_gsc_daily_totals`, `backfill_support_obligations`,
`revalidate_enrichment_candidates`, `rescrape_events` — and there is
`undelete_vendor` and `undelete_performer` but **no `unmerge_` anything**.
OPE-423 records a merge that half-completed and left both rows live.

Time Travel is the only undo that covers all twelve.

---

## Related

- `docs/d1-statement-limits.md` — the other undocumented-D1-behaviour file
- `docs/bulk-mutation-discipline.md` — single-writer · idempotent · read-back-verified · rollback-planned
- OPE-423 (half-completed merge) · OPE-566 (merge tombstones served as live rows)
