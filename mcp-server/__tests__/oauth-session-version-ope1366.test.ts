/**
 * OPE-1366 — login stamps users.session_version into the grant props, so the
 * refresh-time check (src/oauth/token-exchange.ts, exercised end-to-end in
 * workerd-tests/oauth-provider-1x.test.ts) has a baseline to compare against.
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "./setup-db";
import { lookupUser, lookupUserById, resolveUserProps } from "../src/oauth/utils";
import type { Db } from "../src/db";

function seed() {
  const { db, raw } = createTestDb();
  raw
    .prepare(
      "INSERT INTO users (id, email, name, role, session_version) VALUES ('u1', 'a@example.com', 'A', 'ADMIN', 3)"
    )
    .run();
  return { db: db as unknown as Db, raw };
}

describe("OPE-1366 — session_version in OAuth props", () => {
  it("login (lookupUser → resolveUserProps) carries the row's session_version", async () => {
    const { db } = seed();
    const user = await lookupUser(db, "a@example.com");
    expect(user?.sessionVersion).toBe(3);
    const props = await resolveUserProps(db, user!);
    expect(props.sessionVersion).toBe(3);
    expect(props.role).toBe("ADMIN");
  });

  it("the refresh-time lookup by id reads the same current values", async () => {
    const { db, raw } = seed();
    raw.prepare("UPDATE users SET role = 'USER', session_version = 4 WHERE id = 'u1'").run();
    const user = await lookupUserById(db, "u1");
    expect(user).toMatchObject({ id: "u1", role: "USER", sessionVersion: 4 });
    expect(await lookupUserById(db, "missing")).toBeNull();
  });
});
