/**
 * OPE-1628 — the stale-red digest is ONE queue message, and Cloudflare Queues
 * refuses a message over 128,000 bytes. On 2026-11-11 the digest was 327,577
 * bytes (1,473 reds; the D1 "overloaded" bursts had minted 1,011 error classes,
 * one per SQL skeleton), so it was refused, logged as a warn, and no stale-red
 * mail went out for five days.
 */
import { describe, expect, it } from "vitest";
import {
  DIGEST_MAX_BYTES,
  DIGEST_MAX_FAULT_LINES,
  digestBytes,
  digestGroupKey,
  formatStaleRedDigest,
  groupForDigest,
  type StaleRed,
} from "../stale-reds";

const BASE = "https://meetmeatthefair.com";
const QUEUE_LIMIT = 128_000;

const red = (over: Partial<StaleRed> & { refKey: string }): StaleRed => ({
  priority: "P1",
  title: `Render fault: ${over.refKey}`,
  href: "/admin/analytics#render-fault-health",
  firstDetectedAt: "2026-11-03T22:47:00Z",
  hoursInRed: 100,
  volatileSignature: true,
  ...over,
});

/** A D1-overload class as OPE-81 normalises it: the message plus the query skeleton. */
const overloadClass = (i: number) =>
  `failed query: d1 db is overloaded. too many resources consumed within a 10 second window — ` +
  `select ., ., ., . from where (. = ? and . in (?, ?, ?) and . > ?) order by . desc limit ? /* shape ${i} */`;

/** The non-fault reds that must survive every cut (KPI, queue freeze, heartbeat). */
const STANDING: StaleRed[] = [
  {
    priority: "P0",
    title: "Queue frozen: email-jobs",
    refKey: "queue:email-jobs",
    href: "/admin",
    firstDetectedAt: "",
    hoursInRed: 30,
  },
  {
    priority: "P0",
    title: "Heartbeat silent: feed-reader",
    refKey: "hb:feed-reader",
    href: "/admin",
    firstDetectedAt: "",
    hoursInRed: 26,
  },
  {
    priority: "P1",
    title: "KPI red: indexed pages",
    refKey: "kpi:indexed",
    href: "https://www.bing.com/webmasters",
    firstDetectedAt: "",
    hoursInRed: 400,
  },
];

/** 2026-11-11's shape: 1,473 reds — 1,011 overload classes (some multi-route), 60 other classes, 3 standing. */
function nov11(): StaleRed[] {
  const out: StaleRed[] = [...STANDING];
  let n = 0;
  for (let i = 0; i < 1011; i++) {
    const routes = i < 400 ? 2 : 1; // 1,411 overload signals
    for (let r = 0; r < routes; r++)
      out.push(
        red({
          refKey: `ov-${i}-${r}`,
          groupKey: overloadClass(i),
          priority: i % 3 ? "P1" : "P0",
          hoursInRed: 50 + (n++ % 150),
        })
      );
  }
  for (let i = 0; i < 59; i++)
    out.push(
      red({
        refKey: `tf-${i}`,
        groupKey: `typeerror: cannot read properties of undefined (reading 'x${i}')`,
        hoursInRed: 80 + i,
      })
    );
  return out;
}

describe("OPE-1628 — the digest fits one queue message", () => {
  it("ACCEPTANCE: the 1,473-red shape renders under the budget, well under the queue limit", () => {
    const reds = nov11();
    expect(reds).toHaveLength(1473);
    const d = formatStaleRedDigest(reds, BASE);
    const bytes = digestBytes(d);
    expect(bytes).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    expect(bytes).toBeLessThan(QUEUE_LIMIT);
  });

  it("LANDMARK: every standing (non-fault) red is still listed", () => {
    const d = formatStaleRedDigest(nov11(), BASE);
    for (const s of STANDING) {
      expect(d.text).toContain(s.title);
      expect(d.html).toContain(s.title);
    }
  });

  it("collapses 1,011 overload query shapes into ONE platform-incident line naming the count", () => {
    const grouped = groupForDigest(nov11());
    const ov = grouped.filter((g) => g.groupKey === "D1 overloaded (platform incident)");
    expect(ov).toHaveLength(1);
    expect(ov[0]).toMatchObject({
      groupCount: 1411,
      priority: "P0",
      title: "D1 overloaded (platform incident) — 1411 routes",
    });
    // 3 standing + 1 family + 59 ordinary classes.
    expect(grouped).toHaveLength(63);
    expect(formatStaleRedDigest(nov11(), BASE).text).toContain(
      "D1 overloaded (platform incident) — 1411 routes"
    );
  });

  it("an ordinary error class is not swept into the family", () => {
    expect(digestGroupKey({ groupKey: "typeerror: x is undefined" })).toBe(
      "typeerror: x is undefined"
    );
    expect(digestGroupKey({ groupKey: overloadClass(1) })).toBe(
      "D1 overloaded (platform incident)"
    );
    expect(digestGroupKey({})).toBeUndefined();
  });

  it("caps fault lines with a '…and K more' line that counts what it hid", () => {
    const d = formatStaleRedDigest(nov11(), BASE);
    // 60 fault lines (1 family + 59) → DIGEST_MAX_FAULT_LINES shown, the rest summarised.
    const hidden = 60 - DIGEST_MAX_FAULT_LINES;
    expect(d.text).toContain(`…and ${hidden} more render-fault lines (${hidden} signals)`);
    expect(d.html).toContain(`…and ${hidden} more render-fault lines`);
    // P0 first: the family line (P0) is shown, not cut.
    expect(d.text).toContain("D1 overloaded (platform incident)");
  });

  it("halves the cap until it fits when lines are huge", () => {
    const huge = Array.from({ length: 50 }, (_, i) =>
      // A single-route class prints its TITLE, so the title is what must be huge.
      red({
        refKey: `big-${i}`,
        title: `Render fault: /${"x".repeat(5000)}/${i}`,
        groupKey: `rangeerror: ${i}`,
      })
    );
    const d = formatStaleRedDigest([...STANDING, ...huge], BASE);
    // Positive landmark: at the plain line cap this would be ~400 KB.
    expect(40 * 2 * 5000).toBeGreaterThan(QUEUE_LIMIT);
    expect(digestBytes(d)).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    for (const s of STANDING) expect(d.text).toContain(s.title);
    expect(d.text).toMatch(/…and \d+ more render-fault lines \(\d+ signals\)/);
  });

  it("a small digest is unchanged: no '…and more' line", () => {
    const d = formatStaleRedDigest(
      [...STANDING, red({ refKey: "one", groupKey: "typeerror: y" })],
      BASE
    );
    expect(d.text).not.toContain("…and");
    expect(d.text.split("• ").length - 1).toBe(4);
  });
});
