# Dependency audit — accepted advisories

Advisories that `npm audit --package-lock-only --omit=dev` still reports on the
root lockfile, each with the reason it is accepted and what ends the acceptance.
Anything reported that is **not** listed here is unaccepted and should be fixed.

Re-check every entry whenever the package it names changes version.

---

## GHSA-mrhx-c7xc-m3w5 — zod < 4.6.6 inside `@jonnyboats/calendar-*` (high)

- **Accepted:** 2026-11-01, OPE-1551.
- **What the audit reports:** 4 high entries: `zod` plus `@jonnyboats/calendar-contract`,
  `@jonnyboats/calendar-core` and `@jonnyboats/calendar-react`, which depend on it.
  "No fix available".
- **The copy it flags:** `node_modules/@jonnyboats/calendar-contract/node_modules/zod`
  at 3.25.76, because `@jonnyboats/calendar-contract@1.2.0` depends on `zod ^3.24.1`.
  3.25.76 is the last 3.x release, so there's no in-range fix. The app's own zod
  (`node_modules/zod`) is 4.6.7 and is not affected.
- **The advisory:** memory exhaustion while validating an _oversized constrained
  collection_, for example a very large array checked by `z.array(...).min(n)`.

### Why it is unreachable here

Traced from `calendar-contract/dist/index.js` and `calendar-react/dist/index.js` (v1.2.0):

1. `calendar-contract` calls zod in exactly three functions: `validateEvent`,
   `validateWindow` and `validateConfig`.
2. The only constrained collection in its schemas is `CalendarEventSchema.occurrences`
   (`z.array(OccurrenceSchema).min(1)`). Only `validateEvent` and `validateWindow`
   reach it.
3. **MMATF never calls `validateEvent` or `validateWindow` at runtime.** The only
   caller is the test `src/lib/calendar/__tests__/to-calendar-event.test.ts`.
   `calendar-core` imports only `isAllowedUrl` from the contract.
4. The runtime calls are all `validateConfig`, which validates `CalendarConfigSchema`.
   Its one collection is `categoryColors: z.record(z.string())`, which has no size
   constraint. Every value MMATF passes into it is a code literal:
   - `validateConfig({ displayTimeZone: "America/New_York" })` in
     `src/lib/calendar/presence-query.ts`;
   - `calendar-react`'s `MonthCalendar` / `ScheduleCalendar` / `YearCalendar` /
     `TimeGridCalendar` get `displayTimeZone={DISPLAY_TIME_ZONE}`, `locale="en-US"` and
     `weekScrollAnchorHour={8}` from `src/components/events/calendar-*.tsx`.

   No request input, query string, or stored user text reaches a zod schema in these
   packages.

### What ends this acceptance

- A `@jonnyboats/calendar-*` release that moves to zod 4. Upgrade, then delete this entry.
  JohnTarbox/calendar-module has no Linear lane, so John has to approve that release.
- **Any new runtime call** to `validateEvent` / `validateWindow`, or a `validateConfig`
  call that passes request-derived data. Either one makes this reachable, and the
  acceptance no longer holds.

---

## GHSA-fgmj-fm8m-jvvx — echarts < 6.1.0 (moderate)

- **Accepted:** 2026-11-08, OPE-1577.
- **What the audit reports:** `echarts <6.1.0`, moderate, cross-site scripting. The fix is a major bump to 6.1.0.
- **The advisory:** the built-in tooltip of the **Lines** series (`series.type: "lines"`) renders `series.data[i].name` as raw HTML when no custom `tooltip.formatter` is set.

### Why it is unreachable here

`src/components/admin/charts/echarts-core.ts` is the only module that imports `echarts`, and it registers `LineChart` (the ordinary line chart), never `LinesChart`. An unregistered series type cannot render. `src/lib/charts/__tests__/echarts-core-no-lines.test.ts` fails if `LinesChart` is ever imported there.

### What ends this acceptance

Registering `LinesChart`, or moving to echarts 6.1.0 or later (Dependabot #1714), which also changes the default chart theme and needs a visual check of `/admin/analytics`.
