/**
 * OPE-903 — list and revoke `mmatf_` API tokens.
 *
 * Until this shipped, the only way to kill a token was deleting its row by
 * hand, and there was no expiry column at all — while every one of these tokens
 * reaches the admin MCP tools (OPE-478). "Revoke" meant "ask someone with D1
 * access to run a DELETE", which is not a control anybody reaches for in a
 * hurry.
 *
 * ⚠️ Token VALUES are never returned by anything here. Only the SHA-256 hash is
 * stored, so the plaintext cannot be recovered even deliberately — the list
 * shows an 8-character hash prefix, which is enough to tell two tokens apart
 * and useless for authenticating as either.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { apiTokens, users } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

function describe(row: {
  id: string;
  name: string;
  tokenHash: string;
  userId: string;
  email: string | null;
  createdAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}) {
  const now = Date.now();
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= now;
  return {
    id: row.id,
    name: row.name,
    // Enough to identify, useless to authenticate with.
    token_hash_prefix: row.tokenHash.slice(0, 8),
    user_id: row.userId,
    user_email: row.email,
    created_at: row.createdAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    /** The single field worth reading: would this token authenticate right now? */
    usable: row.revokedAt === null && !expired,
    status: row.revokedAt !== null ? "revoked" : expired ? "expired" : "active",
  };
}

export function registerApiTokenTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_api_tokens",
    [
      "List every `mmatf_` API token with its lifecycle state (OPE-903). READ-ONLY.",
      "Never returns a token value — only an 8-character hash prefix, which",
      "identifies a token without being usable as one.",
      "Each row carries `usable`, the only field that answers 'would this",
      "authenticate right now?' — a token can be unusable because it was revoked",
      "OR because it expired, and those are different operator situations.",
    ].join(" "),
    {},
    async () => {
      const rows = await db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          tokenHash: apiTokens.tokenHash,
          userId: apiTokens.userId,
          email: users.email,
          createdAt: apiTokens.createdAt,
          lastUsedAt: apiTokens.lastUsedAt,
          expiresAt: apiTokens.expiresAt,
          revokedAt: apiTokens.revokedAt,
        })
        .from(apiTokens)
        .leftJoin(users, eq(users.id, apiTokens.userId));

      const described = rows.map(describe);
      return {
        content: [
          jsonContent({
            total: described.length,
            // Printed alongside the total so "0 revoked" is visibly a result
            // over a non-empty population rather than an empty query.
            usable: described.filter((t) => t.usable).length,
            revoked: described.filter((t) => t.status === "revoked").length,
            expired: described.filter((t) => t.status === "expired").length,
            tokens: described,
          }),
        ],
      };
    }
  );

  server.tool(
    "revoke_api_token",
    [
      "Revoke an `mmatf_` API token by id (OPE-903). The next MCP call presenting",
      "it gets the same 401 an unknown token gets — no hint that it once existed.",
      "IRREVERSIBLE through this tool: there is deliberately no un-revoke, because",
      "a token you were unsure enough about to revoke is one to replace, not restore.",
      "Get ids from `list_api_tokens`. Revoking an already-revoked token is a no-op",
      "and says so rather than pretending to have acted.",
    ].join(" "),
    {
      token_id: z.string().min(1).describe("The `id` from list_api_tokens."),
      reason: z
        .string()
        .min(1)
        .max(500)
        .describe("Why — recorded in the response for the operator's own trail."),
    },
    async ({ token_id, reason }) => {
      const existing = await db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          tokenHash: apiTokens.tokenHash,
          userId: apiTokens.userId,
          email: users.email,
          createdAt: apiTokens.createdAt,
          lastUsedAt: apiTokens.lastUsedAt,
          expiresAt: apiTokens.expiresAt,
          revokedAt: apiTokens.revokedAt,
        })
        .from(apiTokens)
        .leftJoin(users, eq(users.id, apiTokens.userId))
        .where(eq(apiTokens.id, token_id))
        .limit(1);

      if (existing.length === 0) {
        return { content: [jsonContent({ ok: false, error: "no_such_token", token_id })] };
      }
      if (existing[0].revokedAt !== null) {
        return {
          content: [
            jsonContent({
              ok: true,
              already_revoked: true,
              revoked_at: existing[0].revokedAt.toISOString(),
              token: describe(existing[0]),
            }),
          ],
        };
      }

      const revokedAt = new Date();
      await db.update(apiTokens).set({ revokedAt }).where(eq(apiTokens.id, token_id));

      // Read the row back rather than reporting what was written — the whole
      // point of a revoke is that it took effect.
      const after = await db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          tokenHash: apiTokens.tokenHash,
          userId: apiTokens.userId,
          email: users.email,
          createdAt: apiTokens.createdAt,
          lastUsedAt: apiTokens.lastUsedAt,
          expiresAt: apiTokens.expiresAt,
          revokedAt: apiTokens.revokedAt,
        })
        .from(apiTokens)
        .leftJoin(users, eq(users.id, apiTokens.userId))
        .where(eq(apiTokens.id, token_id))
        .limit(1);

      return {
        content: [
          jsonContent({
            ok: after.length > 0 && after[0].revokedAt !== null,
            reason,
            token: after.length > 0 ? describe(after[0]) : null,
          }),
        ],
      };
    }
  );
}
