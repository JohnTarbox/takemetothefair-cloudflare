/**
 * OPE-1173 — `link_fault_family` / `find_fault_family`.
 *
 * The property that matters most is the one the ticket's acceptance names
 * first: linking NEVER overwrites a different ope_id. A tool that did would
 * silently re-attribute one ticket's family to another — the same class of
 * wrong answer as the duplicate it exists to prevent.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { faultSignatures } from "../src/schema.js";
import { registerFaultFamilyTools } from "../src/tools/admin-fault-family.js";

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerFaultFamilyTools(server as never, db as never, { role: "ADMIN" } as never);
});

const SAFARI = "SyntaxError: Invalid regular expression: invalid group specifier name";
const SLOT = "upload-image-slot: unusable request origin — falling back to site_url";

function seed(signature: string, errorClass: string, opeId: string | null, status = "proposed") {
  const t = new Date("2026-09-20T00:00:00Z");
  db.insert(faultSignatures)
    .values({
      signature,
      route: "/x",
      errorClass,
      firstSeen: t,
      lastSeen: t,
      count: 3,
      status: status as never,
      opeId,
      createdAt: t,
    })
    .run();
}

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await server.invoke(name, args)) as {
    content: { text?: string }[];
    isError?: boolean;
  };
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text ?? "{}") };
};
const rows = () => db.select().from(faultSignatures).all();

describe("link_fault_family — link mode", () => {
  it("links every unlinked row of a family and marks it filed", async () => {
    seed("s1", SAFARI, null);
    seed("s2", SAFARI, null, "noise");
    seed("other", SLOT, null);

    const { body } = await call("link_fault_family", { error_class: SAFARI, ope_id: "OPE-1128" });

    expect(body).toMatchObject({ matched: 2, updated: 2, already_linked: [], status: "filed" });
    const bySig = Object.fromEntries(rows().map((r) => [r.signature, r]));
    expect(bySig.s1.opeId).toBe("OPE-1128");
    expect(bySig.s1.status).toBe("filed");
    expect(bySig.s1.filedAt).toBeInstanceOf(Date);
    // Landmark: a different family is untouched.
    expect(bySig.other.opeId).toBeNull();
  });

  it("ACCEPTANCE: a family already linked to a DIFFERENT OPE is reported, not overwritten", async () => {
    seed("s1", SLOT, "OPE-1031", "open");
    const { body } = await call("link_fault_family", { error_class: SLOT, ope_id: "OPE-9999" });
    expect(body.updated).toBe(0);
    expect(body.already_linked).toEqual([{ signature: "s1", ope_id: "OPE-1031" }]);
    expect(rows()[0].opeId).toBe("OPE-1031");
    expect(rows()[0].status).toBe("open");
  });

  it("re-linking to the SAME OPE is a reported no-op (the prod OPE-1031 acceptance shape)", async () => {
    seed("s1", SLOT, "OPE-1031", "open");
    const { body } = await call("link_fault_family", { error_class: SLOT, ope_id: "OPE-1031" });
    expect(body).toMatchObject({ matched: 1, updated: 0 });
    expect(body.already_linked).toEqual([{ signature: "s1", ope_id: "OPE-1031" }]);
  });

  it("a single signature links just that row", async () => {
    seed("s1", SAFARI, null);
    seed("s2", SAFARI, null);
    const { body } = await call("link_fault_family", { signature: "s2", ope_id: "OPE-1" });
    expect(body.updated).toBe(1);
    expect(rows().find((r) => r.signature === "s1")!.opeId).toBeNull();
  });
});

describe("link_fault_family — duplicate re-point", () => {
  it("ACCEPTANCE: moves exactly the rows carrying from_ope_id", async () => {
    seed("dup-a", SAFARI, "OPE-1149", "open");
    seed("dup-b", SAFARI, "OPE-1149", "filed");
    seed("keep", SAFARI, "OPE-1128", "filed");
    seed("unlinked", SAFARI, null);
    seed("elsewhere", SLOT, "OPE-1149", "open");

    const { body } = await call("link_fault_family", {
      from_ope_id: "OPE-1149",
      ope_id: "OPE-1128",
    });

    expect(body).toMatchObject({ mode: "repoint", updated: 3 });
    const bySig = Object.fromEntries(rows().map((r) => [r.signature, r.opeId]));
    expect(bySig).toEqual({
      "dup-a": "OPE-1128",
      "dup-b": "OPE-1128",
      keep: "OPE-1128",
      unlinked: null, // not carrying OPE-1149 → untouched
      elsewhere: "OPE-1128",
    });
  });

  it("narrowed by error_class, a re-point leaves other families alone", async () => {
    seed("dup-a", SAFARI, "OPE-1149");
    seed("elsewhere", SLOT, "OPE-1149");
    await call("link_fault_family", {
      from_ope_id: "OPE-1149",
      ope_id: "OPE-1128",
      error_class: SAFARI,
    });
    expect(rows().find((r) => r.signature === "elsewhere")!.opeId).toBe("OPE-1149");
  });

  it("refuses ambiguous or empty selectors", async () => {
    expect((await call("link_fault_family", { ope_id: "OPE-1" })).isError).toBe(true);
    expect(
      (await call("link_fault_family", { ope_id: "OPE-1", error_class: SAFARI, signature: "s" }))
        .isError
    ).toBe(true);
    expect(
      (await call("link_fault_family", { ope_id: "OPE-1", from_ope_id: "OPE-1" })).isError
    ).toBe(true);
  });
});

describe("find_fault_family", () => {
  it("finds a family by a case-insensitive substring longer than D1's 50-byte LIKE cap", async () => {
    seed("s1", SLOT, null);
    seed("s2", SLOT, "OPE-1031", "open");
    seed("x", SAFARI, null);
    const needle = "UNUSABLE REQUEST ORIGIN — FALLING BACK TO SITE_URL"; // > 50 bytes
    expect(Buffer.byteLength(needle)).toBeGreaterThan(50);

    const { body } = await call("find_fault_family", { query: needle });
    expect(body.count).toBe(1);
    expect(body.families[0]).toMatchObject({
      error_class: SLOT,
      signatures: 2,
      unlinked: 1,
      ope_ids: "OPE-1031",
    });
  });
});
