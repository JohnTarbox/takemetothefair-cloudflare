/**
 * OPE-988 — has the organizer's domain been taken over?
 *
 * Real pages (fixtures/ope988), fetched 2026-09-13:
 *   - leominster-rotary_org.html — `leominster-rotary.org`, now redirecting to an
 *     Indonesian lottery site. Must read RED.
 *   - fryeburgfair_org.html — a normal organizer homepage from prod. GREEN.
 *   - johnnyappleseedfest_com.html — a real (wrong-state, but real) festival. GREEN:
 *     being the wrong event is the agreement check's finding, not a takeover.
 * Plus the OPE-979 real pages, none of which is a takeover.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyUrlHealth } from "../url-health";
import { detectDomainTakeover, englishRatio } from "../domain-takeover";

const F = (dir: string, f: string) => readFileSync(join(__dirname, "fixtures", dir, f), "utf8");

const ENGLISH_PROSE =
  "Welcome to our annual fair. Come and enjoy the food, the music and the animals with your " +
  "family. We are proud to host vendors from all over the region, and we will see you at the " +
  "gate. Parking is free and the grounds are open from nine in the morning until dusk.";

describe("OPE-988 ACCEPTANCE — the real specimen pages", () => {
  it("RED: leominster-rotary.org is a lottery site now", () => {
    const r = detectDomainTakeover(F("ope988", "leominster-rotary_org.html"), {
      entityName: "Rotary Club of Leominster",
      requestedUrl: "https://leominster-rotary.org",
      finalUrl: "https://sidneypoolstoday.com/",
    });
    expect(r.takenOver).toBe(true);
    // Pin the independent witnesses by name, so a regression in any one is seen
    // even while the others keep the verdict red.
    expect(r.signals).toEqual(
      expect.arrayContaining([
        "spam-title:gambling",
        "geo-region:ID",
        "language:id",
        "title-no-entity-token",
        "cross-domain-redirect:sidneypoolstoday.com",
      ])
    );
  });

  it("…and the url-health classifier alone would NOT have flagged it", () => {
    // Why this module exists: the lottery page is event-shaped enough for `ok`
    // (or at best `no_event_signal`) — never anything that names the problem.
    const v = classifyUrlHealth({
      reachedOrigin: true,
      status: 200,
      html: F("ope988", "leominster-rotary_org.html"),
    }).verdict;
    expect(["ok", "no_event_signal"]).toContain(v);
  });

  it("GREEN: Fryeburg Fair's real homepage", () => {
    const r = detectDomainTakeover(F("ope988", "fryeburgfair_org.html"), {
      entityName: "Fryeburg Fair",
      requestedUrl: "https://www.fryeburgfair.org/",
      finalUrl: "https://www.fryeburgfair.org/",
    });
    expect(r.takenOver).toBe(false);
    expect(r.signals).toEqual([]);
  });

  it("GREEN: the wrong-state Johnny Appleseed page is a real festival, not a takeover", () => {
    const r = detectDomainTakeover(F("ope988", "johnnyappleseedfest_com.html"), {
      entityName: "Johnny Appleseed Arts and Cultural Festival",
    });
    expect(r.takenOver).toBe(false);
  });

  it("GREEN: none of the OPE-979 real pages is a takeover (closure and parked pages are other verdicts)", () => {
    for (const f of [
      "eagleshows_com.html",
      "easterngunexpo_com.html",
      "ledyardfair_org.html",
      "clintonlionsagfair207_com.html",
    ]) {
      expect(detectDomainTakeover(F("ope979", f), { entityName: "Some Promoter" }).takenOver).toBe(
        false
      );
    }
  });
});

describe("keyword classes", () => {
  const html = (title: string, body = ENGLISH_PROSE, head = "") =>
    `<html lang="en"><head><title>${title}</title>${head}</head><body><p>${body}</p></body></html>`;

  it("a gambling term with no innocent reading, in the TITLE, is decisive alone", () => {
    const r = detectDomainTakeover(html("Best Online Casino Bonuses 2026"), {
      entityName: "Clinton Lions Ag Fair",
    });
    expect(r.takenOver).toBe(true);
    expect(r.signals).toContain("spam-title:gambling");
  });

  it("…ALONE: the hijack that keeps the org's name in its title, English body, no other signal", () => {
    // The stale-shell shape: the title still names the fair, so there is no
    // title mismatch, no geo, no foreign language — the spam term is the ONLY
    // witness, and it must be enough.
    const r = detectDomainTakeover(html("Clinton Lions Ag Fair | Slot Gacor Hari Ini"), {
      entityName: "Clinton Lions Ag Fair",
    });
    expect(r.signals).toEqual(["spam-title:gambling"]);
    expect(r.takenOver).toBe(true);
  });

  it("pharma spam in the title is decisive too", () => {
    expect(
      detectDomainTakeover(html("Buy Viagra Online Cheap"), { entityName: "Clinton Lions Ag Fair" })
        .takenOver
    ).toBe(true);
  });

  it("the OPE-857 Clinton shape (Situs Slot Gacor) is caught", () => {
    expect(
      detectDomainTakeover(html("DRAGON222 Link Alternatif Situs Slot Gacor"), {
        entityName: "Clinton Lions Ag Fair",
      }).takenOver
    ).toBe(true);
  });
});

describe("false-positive guards — legitimate fair pages", () => {
  const legit = (title: string, body: string) =>
    `<html lang="en"><head><title>${title}</title><meta name="geo.region" content="US-ME"></head>` +
    `<body><h1>${title}</h1><p>${body} ${ENGLISH_PROSE}</p></body></html>`;

  it("a raffle and a 'lottery for booth spaces' in the body never flag", () => {
    const r = detectDomainTakeover(
      legit(
        "Clinton Lions Ag Fair",
        "Buy raffle tickets at the gate. Booth spaces are assigned by lottery for booth spaces in May."
      ),
      { entityName: "Clinton Lions Ag Fair" }
    );
    expect(r.takenOver).toBe(false);
    expect(r.signals).toEqual([]);
  });

  it("'Booth Lottery' as a HEADING is one weak signal, never a verdict", () => {
    const r = detectDomainTakeover(legit("Clinton Lions Ag Fair — Booth Lottery", "Apply now."), {
      entityName: "Clinton Lions Ag Fair",
    });
    expect(r.signals).toEqual(["weak-keyword:gambling"]);
    expect(r.takenOver).toBe(false);
  });

  it("a Lions Club Casino Night page is one weak signal, not a verdict", () => {
    const named = detectDomainTakeover(legit("Lions Club Casino Night", "Fundraiser."), {
      entityName: "Lions Club",
    });
    expect(named.takenOver).toBe(false);
    expect(named.signals).toEqual(["weak-keyword:gambling"]);
  });

  it("an organization that moved domains (redirect + unrelated title) is structural only — not flagged", () => {
    const r = detectDomainTakeover(legit("Harvest Days", "New home, same fair."), {
      entityName: "Oxford County Agricultural Society",
      requestedUrl: "https://oldfairsite.org",
      finalUrl: "https://harvestdays.com/",
    });
    expect(r.signals).toEqual(
      expect.arrayContaining(["title-no-entity-token", "cross-domain-redirect:harvestdays.com"])
    );
    expect(r.takenOver).toBe(false);
  });

  it("an Acadian festival declared lang=fr but written mostly in English is not a language signal", () => {
    const html = `<html lang="fr"><head><title>Festival Acadien de Madawaska</title></head><body><p>${ENGLISH_PROSE} ${ENGLISH_PROSE}</p></body></html>`;
    const r = detectDomainTakeover(html, { entityName: "Madawaska Acadian Festival" });
    expect(r.signals.some((s) => s.startsWith("language"))).toBe(false);
    expect(r.takenOver).toBe(false);
  });

  it("one sponsor link to a casino resort is not a spam network", () => {
    const html = legit(
      "Oxford Fair",
      'Sponsored by <a href="https://oxfordcasino.com">Oxford Casino</a>.'
    );
    const r = detectDomainTakeover(html, { entityName: "Oxford Fair" });
    expect(r.signals.some((s) => s.startsWith("spam-links"))).toBe(false);
  });

  it("a generic title ('Home') is not a title mismatch", () => {
    const r = detectDomainTakeover(legit("Home", "x"), { entityName: "Fryeburg Fair" });
    expect(r.signals).not.toContain("title-no-entity-token");
  });
});

describe("independent signals", () => {
  it("geo.region outside the US + a non-English page = two content signals = taken over", () => {
    const html =
      `<html lang="id"><head><title>Informasi Terbaru Hari Ini</title>` +
      `<meta name="geo.region" content="ID"></head><body><p>` +
      "Informasi terbaru hari ini untuk semua pengguna setia kami di seluruh wilayah dengan layanan cepat. ".repeat(
        10
      ) +
      "</p></body></html>";
    const r = detectDomainTakeover(html, { entityName: "Rotary Club of Leominster" });
    expect(r.signals).toEqual(
      expect.arrayContaining(["geo-region:ID", "language:id", "title-no-entity-token"])
    );
    expect(r.takenOver).toBe(true);
  });

  it("geo.region US-MA is not a signal", () => {
    const html = `<html lang="en"><head><title>Fair</title><meta name="geo.region" content="US-MA"></head><body>${ENGLISH_PROSE}</body></html>`;
    expect(detectDomainTakeover(html, { entityName: "Fair" }).signals).toEqual([]);
  });

  it("englishRatio separates English prose from Indonesian", () => {
    expect(englishRatio(ENGLISH_PROSE).ratio).toBeGreaterThan(0.15);
    expect(
      englishRatio("Keluaran sdy tercepat hari ini adalah angka togel Sydney paling akurat").ratio
    ).toBeLessThan(0.05);
  });

  it("title token overlap ignores stopwords and generic words", () => {
    const html = (t: string) =>
      `<html lang="en"><head><title>${t}</title></head><body>${ENGLISH_PROSE}</body></html>`;
    // "the", "of", "official", "site" are not identity; "leominster" is.
    expect(
      detectDomainTakeover(html("The Official Site of Leominster Rotary"), {
        entityName: "Rotary Club of Leominster",
      }).signals
    ).toEqual([]);
    expect(
      detectDomainTakeover(html("The Official Site of Something Else"), {
        entityName: "Rotary Club of Leominster",
      }).signals
    ).toEqual(["title-no-entity-token"]);
    // A compacted brand ("4TownFair") still overlaps "Four Town Fair"'s tokens via "town"/"fair".
    expect(
      detectDomainTakeover(html("Four Town Fair Somers"), { entityName: "4 Town Fair" }).signals
    ).toEqual([]);
  });

  it("no body, no verdict", () => {
    expect(detectDomainTakeover(null, { entityName: "X" }).takenOver).toBe(false);
  });
});
