# Browser support floor

**Declared in `package.json#browserslist`. Enforced by
`scripts/check-browser-api-floor.ts` in CI.**

| Browser        | Floor  | Released |
| -------------- | ------ | -------- |
| Safari (macOS) | **14** | 2020-09  |
| Safari (iOS)   | **14** | 2020-09  |
| Chrome         | **90** | 2021-04  |
| Edge           | **90** | 2021-04  |
| Firefox        | **88** | 2021-04  |

Plus browserslist `defaults`, minus `dead` browsers and Opera Mini.

## Why these numbers

They are not aspirational — they are **the browsers we measured real visitors
using**. OPE-640 captured two user agents hitting a hard render failure on
`/events/*`:

- `Safari 14.1.2 / macOS 10_15_6`
- `Chrome 90 / Android 11 (SM-S102DL)`

The floor is set to include them. Raising it above either one is a decision to
serve those people a blank page, and should be made deliberately with traffic
data, not by accident through an unguarded API call.

## What "above the floor" costs

Not graceful degradation. **A blank page.**

`crypto.randomUUID()` (Safari 15.4, Chrome 92) was called unguarded inside a
`.map()` in `generateMultiDayICSContent`, which runs during _render_ in a
`"use client"` component on every event page. Every visitor below the floor got
the React error boundary instead of the event. Nine logged occurrences across
eight distinct events before anyone noticed, and the rate was rising — because
the developers, the CI runner and every synthetic check all run current
browsers. Nothing in the normal loop crosses this ceiling.

This is the same shape as the D1 limits this repo already guards
(`FAM-D1-COLCAP`, `FAM-D1-PARAMCAP`): an undocumented ceiling that local
development structurally cannot reach. There, local SQLite allows 50,000-char
LIKE patterns where D1 allows 50. Here, the developer's Chrome has every API.

## The guard

`scripts/check-browser-api-floor.ts` walks the **transitive import closure of
every `"use client"` entry** and flags above-floor APIs only in modules a
browser can actually execute.

Reachability is the whole design. This codebase calls `crypto.randomUUID()` in
~30 server modules where the Workers runtime always provides it; a per-file lint
rule (`eslint-plugin-compat`) would flag all of them, get blanket-disabled, and
then guard nothing. The case that matters is `src/lib/utils.ts` — a shared
module, overwhelmingly server-used, pulled into the client bundle by a single
component.

### Regex syntax is above the floor too (OPE-1128)

Regex **lookbehind** — `(?<=…)` / `(?<!…)` — needs **Safari 16.4** (2023-03).
It is syntax, not an API: there is no call to guard. JavaScriptCore throws
`Invalid regular expression: invalid group specifier name` the moment the
pattern is compiled, so a lookbehind built at module load blanks every page
whose chunk contains it.

That is what happened. `packages/utils/src/blog-faq-coherence.ts` — a
server-side blog linter — built one in a module-level `new RegExp`. The
`@takemetothefair/utils` barrel re-exports it, so any client component importing
a single helper from the barrel shipped it. ~20 renders across 13+ routes
(`/`, `/events`, `/blog/*` …) from Safari 15.1 through 16.3.1, and **zero**
from Chrome/Firefox/Android — the pattern that says "browser floor", not "bug".

16.4 is **above** the Safari 14 floor, so lookbehind is refused in
client-reachable code. **Named groups** `(?<name>…)` are Safari 11.1 — below
the floor — and are deliberately not flagged.

The guard also walks into `packages/*/src` now. Before OPE-1128 it treated
`@takemetothefair/*` as external and scanned none of it, which is why it could
not have caught this even with a regex rule. It skips `import type` (erased at
compile time) and treats Drizzle `$defaultFn(() => …)` as deferred (it runs only
on INSERT), because the db-schema barrel is client-reachable via
`src/lib/vendor-status.ts`.

## Changing the floor

1. Edit `package.json#browserslist` and this table.
2. Delete the entries in the guard's `ABOVE_FLOOR` list that the new floor makes
   safe, and add any the new floor makes unsafe.
3. Say in the PR which real users the change stops serving.

Do **not** silence the guard by adding to
`scripts/check-browser-api-floor.allowlist` — that file accepts a blank page for
someone, and is empty on purpose.
