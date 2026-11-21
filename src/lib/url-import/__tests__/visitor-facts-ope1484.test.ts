/**
 * OPE-1484 — the deterministic visitor-facts finder. Every fixture sentence is
 * quoted verbatim from a real organizer page in the 2026-10-17 precision
 * samples (source in the label), so a regex change is judged against what
 * organizers actually write rather than against sentences written to pass.
 * The few lines marked "synthetic" are filler or a trap no sample contained.
 */
import { describe, expect, it } from "vitest";
import {
  classifyPetSentence,
  findVisitorFacts,
  withVisitorFacts,
} from "@/lib/url-import/visitor-facts";

const page = (...lines: string[]) => lines.join("\n");

describe("findVisitorFacts — what it finds, verbatim", () => {
  it("Stone Zoo (zoonewengland.org/zoolights): all three, each a page sentence", () => {
    const text = page(
      "Is there a fee to park?",
      "No, parking is free in our nearby lots.",
      "Yes, single strollers and wheelchairs are available for a $5 rental fee, and double strollers for $7.",
      "Pets are not allowed on Zoo grounds to protect the health and safety of our animals and your pets."
    );
    const f = findVisitorFacts(text);
    expect(f.parking?.excerpt).toBe("No, parking is free in our nearby lots.");
    expect(f.accessibility?.excerpt).toMatch(/^Yes, single strollers and wheelchairs/);
    expect(f.pets).toEqual({
      value: "NO",
      excerpt:
        "Pets are not allowed on Zoo grounds to protect the health and safety of our animals and your pets.",
    });
    // Verbatim by construction: every excerpt is a substring of the page.
    for (const e of [f.parking, f.accessibility, f.pets]) expect(text).toContain(e!.excerpt);
  });

  it("'only … service dogs' is NO, never YES (Lebanon Country Fair, Maine Fiber Frolic)", () => {
    expect(
      classifyPetSentence(
        "Please note that only guide dogs and service dogs are allowed on the fairgrounds."
      )
    ).toBe("NO");
    expect(
      classifyPetSentence(
        "For the safety and comfort of all, including the dogs, only service dogs and working dogs participating in demonstrations or exhibits are allowed on the fair grounds."
      )
    ).toBe("NO");
    expect(classifyPetSentence("No Dogs or Pets are allowed on the Fairgrounds")).toBe("NO");
    expect(classifyPetSentence("Leashed, well-behaved dogs are welcome.")).toBe("YES");
  });

  it("a page with no pet sentence yields UNSET (null), never NO", () => {
    const f = findVisitorFacts(
      page(
        "PARKING: Please note that parking at the Arts Center is limited.",
        "Vendors set up at 8 am." // synthetic filler
      )
    );
    expect(f.pets).toBeNull();
    expect(f.parking?.excerpt).toBe(
      "PARKING: Please note that parking at the Arts Center is limited."
    );
  });

  it("a pet MENTION with no stated rule stays UNSET (Berlin Fair heading)", () => {
    expect(findVisitorFacts("Berlin Fair Service Animal Policy").pets).toBeNull();
  });
});

describe("findVisitorFacts — the traps from the samples find nothing", () => {
  it.each([
    ["Bangor farmers market", "Winter Location: Sea Dog Brewing Co."],
    ["Bangor farmers market", "Dog and cat treats"],
    [
      "Bright Nights",
      "Travel through a dazzling wonderland of over 750,00 lights at Bright Nights at Forest Park.",
    ],
    ["Brockton (nav label)", "Parking Authority"],
    ["a question, not an answer", "Where can I park or find public transportation for the parade?"],
    ["Bar Harbor (event location)", "Located at the YMCA parking lot, corner of Main and Park St."],
    [
      "Hamburg (marketing)",
      "The intimate size of the fair makes for easy navigation, parking, and crowd control.",
    ],
    ["Orange (trailer parking)", "C Lot Parking For Trucks with Trailers"],
    [
      "North Stonington (admission row)",
      "Free Parking - Saturday 65 & Over $6.00 - Sunday Active Military $6.00",
    ],
    [
      "Haddam Neck (ADA about service animals)",
      "Service Dog & Animal Policy We follow the Americans with Disabilities Act (ADA) guidelines but must restrict access to actual service animals.",
    ],
    ["synthetic: food", "Grab hot dogs and corn dogs at the snack bar, all weekend long."],
  ])("%s", (_label, sentence) => {
    const f = findVisitorFacts(sentence);
    expect(f.parking).toBeNull();
    expect(f.accessibility).toBeNull();
    // The Haddam sentence IS a pet sentence, but it states no allow/deny rule.
    expect(f.pets).toBeNull();
  });
});

describe("withVisitorFacts", () => {
  const text = "No, parking is free in our nearby lots.";
  it("attaches to a ONE-event extraction", () => {
    const [e] = withVisitorFacts([{ name: "ZooLights" }], text);
    expect(e.visitorFacts?.parking?.excerpt).toBe(text);
  });
  it("attaches nothing to a multi-event page — a page rule can't be attributed", () => {
    const out = withVisitorFacts([{ name: "A" }, { name: "B" }], text);
    expect(out.every((e) => !("visitorFacts" in e))).toBe(true);
  });
  it("attaches nothing when the page says nothing", () => {
    const [e] = withVisitorFacts([{ name: "A" }], "Vendors set up at 8 am sharp every day.");
    expect("visitorFacts" in e).toBe(false);
  });
});

describe("OPE-1506 — a ramp to the building is accessibility; other ramps are not", () => {
  it("reads the Manchester Grange sentence (inbound 01ad5525) as accessibility, verbatim", () => {
    const s =
      "There is a ramp at the back of the building which may be easier to use than the front of the building which has stairs.";
    expect(findVisitorFacts(s).accessibility?.excerpt).toBe(s);
  });

  it("step-free access counts", () => {
    expect(
      findVisitorFacts("The hall is step-free from the main parking area to the stage.")
        .accessibility
    ).not.toBeNull();
  });

  it.each([
    "The boat ramp at the lake will be closed for the weekend crowds.",
    "Take the on-ramp from I-95 and follow the signs to the fair.",
    "Vendors should ramp up their displays early this year please.",
  ])("not accessibility: %s", (s) => {
    expect(findVisitorFacts(s).accessibility).toBeNull();
  });
});
