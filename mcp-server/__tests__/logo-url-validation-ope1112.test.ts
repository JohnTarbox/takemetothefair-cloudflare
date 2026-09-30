/**
 * OPE-1112 — `update_vendor` and `create_vendor` refuse a page URL as a logo.
 *
 * The app's form validates through `imageUrlSchema`; these two tools carry
 * their own zod shapes and would otherwise stay open. That matters more than
 * it sounds: `update_vendor` is the tool an agent reaches for, so an
 * unguarded MCP writer would quietly become the main way bad logos get in
 * once the form stops accepting them — the defect relocating rather than
 * closing.
 *
 * The acceptance criterion names this tool specifically: "`update_vendor` and
 * the self-service form BOTH reject a non-image `logo_url`."
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { users, vendors } from "../src/schema.js";
import { unsafeSlug } from "@takemetothefair/utils";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const MARGES_URL = "https://www.facebook.com/profile.php?id=61568647635851";
const REAL_LOGO = "https://cdn.shopify.com/s/files/1/0703/files/Hangtag.jpg?v=1786546389";

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH);
  db.insert(users).values({ id: "u-v", email: "v@test", role: "VENDOR" }).run();
  db.insert(vendors)
    .values({
      id: "ven-1",
      userId: "u-v",
      businessName: "7th Star Bags",
      slug: unsafeSlug("7th-star-bags"),
      logoUrl: null,
    })
    .run();
});

const storedLogo = () =>
  db.select().from(vendors).where(eq(vendors.id, "ven-1")).all()[0]?.logoUrl ?? null;

describe("OPE-1112 — update_vendor", () => {
  it("ACCEPTANCE: refuses the exact URL prod was holding, and stores nothing", async () => {
    const res = (await server.invoke("update_vendor", {
      vendor_id: "ven-1",
      logo_url: MARGES_URL,
    })) as { isError?: boolean; content: { text?: string }[] };

    expect(res.isError).toBe(true);
    // The write must not have happened. A tool that reports an error but has
    // already written is the worse version of this bug.
    expect(storedLogo()).toBeNull();
  });

  it("the refusal says what is wrong with it", async () => {
    const res = (await server.invoke("update_vendor", {
      vendor_id: "ven-1",
      logo_url: MARGES_URL,
    })) as { content: { text?: string }[] };
    expect(res.content[0].text ?? "").toContain("Facebook page");
  });

  it("LANDMARK: a real logo still writes", async () => {
    // Without this, "refuses a logo" is satisfied by a tool that refuses every
    // logo, which would break the admin repair path this ticket depends on.
    await server.invoke("update_vendor", { vendor_id: "ven-1", logo_url: REAL_LOGO });
    expect(storedLogo()).toBe(REAL_LOGO);
  });

  it("clearing the logo is still possible — the repair for the 8 bad rows", async () => {
    await server.invoke("update_vendor", { vendor_id: "ven-1", logo_url: REAL_LOGO });
    expect(storedLogo()).toBe(REAL_LOGO);

    await server.invoke("update_vendor", { vendor_id: "ven-1", logo_url: "" });
    expect(storedLogo()).toBe("");
  });
});

describe("OPE-1112 — create_vendor", () => {
  it("refuses a page URL at creation", async () => {
    const res = (await server.invoke("create_vendor", {
      business_name: "Douse Skin",
      logo_url: "https://www.instagram.com/douseskin/",
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it("accepts a real one", async () => {
    const res = (await server.invoke("create_vendor", {
      business_name: "Douse Skin",
      logo_url: REAL_LOGO,
    })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
  });
});
