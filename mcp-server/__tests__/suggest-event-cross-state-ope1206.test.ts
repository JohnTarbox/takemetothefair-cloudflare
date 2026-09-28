/**
 * OPE-1206 — suggest_event never links an explicit venue_id in a different
 * state than the caller's own venue_state, and never auto-publishes a source
 * outside New England.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { events, users, venues } from "../src/schema.js";

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  db.insert(users).values({ id: "u1", email: "u1@test", role: "USER" }).run();
  registerVendorTools(server as never, db, { userId: "u1", role: "USER" } as never, undefined);
  db.insert(venues)
    .values({
      id: "v-me",
      name: "Portland Expo",
      slug: unsafeSlug("portland-expo"),
      address: "239 Park Ave",
      city: "Portland",
      state: "ME",
      zip: "04102",
    })
    .run();
});

async function suggest(name: string, args: Record<string, unknown>) {
  const r = (await server.invoke("suggest_event", {
    name,
    start_date: "2026-11-27",
    end_date: "2026-11-29",
    description: "A holiday market.",
    ...args,
  })) as { isError?: boolean; content: Array<{ text: string }> };
  const [row] = db.select().from(events).where(eq(events.name, name)).all();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(r.content[0].text);
  } catch {
    /* text response */
  }
  return { isError: !!r.isError, row, body };
}

describe("suggest_event — OPE-1206", () => {
  it("ACCEPTANCE: venue_id in ME with venue_state OR is NOT linked; PENDING, flagged, warned", async () => {
    const r = await suggest("Portland Holiday Market OR", { venue_id: "v-me", venue_state: "OR" });
    expect(r.isError).toBe(false);
    expect(r.row.venueId).toBeNull();
    expect(r.row.status).toBe("PENDING");
    expect(r.row.flaggedForReview).toBe(1);
    expect(JSON.stringify(r.body)).toContain("venue_state_conflict");
  });

  it("control: venue_id in ME with venue_state ME is linked", async () => {
    const r = await suggest("Portland Holiday Market ME", { venue_id: "v-me", venue_state: "ME" });
    expect(r.row.venueId).toBe("v-me");
    expect(r.row.flaggedForReview).toBe(0);
  });

  it("a source outside New England is PENDING even with no venue", async () => {
    const r = await suggest("Somewhere Else Fair", { venue_state: "OR" });
    expect(r.row.status).toBe("PENDING");
    expect(r.row.flaggedForReview).toBe(1);
  });
});
