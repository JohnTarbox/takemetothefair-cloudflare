/**
 * OPE-1114 — approving an event whose PUBLIC description still carries a
 * reviewer note WARNS, and never blocks.
 *
 * Specimen: pemaquid-oyster-festival-2026 went public reading "reviewer should
 * confirm the 2026 venue before approval", and the venue was wrong by a town.
 * Driven both ways: the warning is present with the note, absent without it,
 * and the approval lands in both cases.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

const PEMAQUID_NOTE =
  "Oysters on the harbor. VENUE TO CONFIRM: traditionally held at Schooner Landing — reviewer should confirm the 2026 venue before approval.";

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: unsafeSlug("p") })
    .run();
});
afterEach(() => mock.restore());

function seed(description: string) {
  db.insert(events)
    .values({
      id: "evt",
      name: "Pemaquid Oyster Festival 2026",
      slug: unsafeSlug("pemaquid-oyster-festival-2026"),
      promoterId: "p-1",
      status: "PENDING",
      description,
      // A location, so the OPE-244 approval gate lets it through.
      isStatewide: true,
      stateCode: "ME",
    })
    .run();
}

async function approve() {
  const r = (await server.invoke("update_event_status", {
    event_id: "evt",
    status: "APPROVED",
  })) as { isError?: boolean; content: Array<{ text: string }> };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text) as { warnings?: Record<string, string> };
}

const status = () => db.select().from(events).where(eq(events.id, "evt")).all()[0].status;

describe("update_event_status → APPROVED with a reviewer note in public copy", () => {
  it("warns, names the marker, and STILL approves (warn, never block)", async () => {
    seed(PEMAQUID_NOTE);
    const res = await approve();
    expect(res.warnings?.reviewer_note_in_description).toContain("reviewer should");
    expect(status()).toBe("APPROVED");
  });

  it("the other side: clean copy → no warning, and approved", async () => {
    seed("Oysters on the harbor at Mine Oyster, Boothbay Harbor.");
    const res = await approve();
    expect(res.warnings).toBeUndefined();
    expect(status()).toBe("APPROVED");
  });
});
