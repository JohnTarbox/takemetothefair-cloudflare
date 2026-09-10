import { Hono } from "hono";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { getDb } from "../db.js";
import { logError } from "../logger.js";
import { lookupUser, verifyPassword, resolveUserProps } from "./utils.js";

interface Env {
  DB: D1Database;
  OAUTH_PROVIDER: OAuthHelpers;
  /** OPE-900 — holds the pending authorization request; see PENDING_STATE_PREFIX. */
  OAUTH_KV: KVNamespace;
}

/**
 * OPE-900 — the login form used to carry the whole authorization request as
 * `btoa(JSON.stringify(oauthReqInfo))` and trust it back verbatim on POST.
 * Nothing signed it, so a client could rewrite any field — including
 * `redirectUri`, which is where `completeAuthorization` sends the auth code.
 *
 * The request now lives in KV under an opaque random id and the browser only
 * ever sees the id. That is stronger than signing it: there is no secret to
 * manage or rotate, and nothing to forge — an id that was never minted simply
 * is not there. It also buys expiry and single-use, which an HMAC would not.
 */
const PENDING_STATE_PREFIX = "login:state:";

/** Matches the __Host-CSRF cookie's Max-Age, so both halves expire together. */
const PENDING_STATE_TTL_SECONDS = 600;

/** Only ids we minted are ever looked up — never caller-controlled key text. */
const STATE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET / — server info (Claude.ai probes this first)
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  console.log("[LOGIN] GET /");
  return c.json({
    name: "MeetMeAtTheFair",
    version: "1.0.0",
    description: "Meet Me at the Fair MCP Server",
  });
});

// ---------------------------------------------------------------------------
// GET /authorize — render login form
// ---------------------------------------------------------------------------
app.get("/authorize", async (c) => {
  console.log("[LOGIN] GET /authorize", c.req.url);
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  console.log(
    "[LOGIN] Parsed auth request:",
    JSON.stringify({
      clientId: oauthReqInfo.clientId,
      redirectUri: oauthReqInfo.redirectUri,
      scope: oauthReqInfo.scope,
    })
  );
  if (!oauthReqInfo.clientId) {
    await logError(c.env.DB, {
      level: "warn",
      source: "mcp:oauth",
      message: "GET /authorize missing client_id",
      context: { url: c.req.url },
    });
    return c.text("Invalid authorization request", 400);
  }

  const csrfToken = crypto.randomUUID();
  const stateId = crypto.randomUUID();
  await c.env.OAUTH_KV.put(PENDING_STATE_PREFIX + stateId, JSON.stringify(oauthReqInfo), {
    expirationTtl: PENDING_STATE_TTL_SECONDS,
  });

  return c.html(renderLoginPage(csrfToken, stateId, null), 200, {
    "Set-Cookie": `__Host-CSRF=${csrfToken}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
  });
});

// ---------------------------------------------------------------------------
// POST /authorize — validate credentials, complete OAuth flow
// ---------------------------------------------------------------------------
app.post("/authorize", async (c) => {
  console.log("[LOGIN] POST /authorize");
  const formData = await c.req.raw.formData();

  // CSRF validation
  const csrfToken = formData.get("csrf_token") as string;
  const cookies = c.req.raw.headers.get("Cookie") || "";
  const match = cookies.match(/__Host-CSRF=([^;]+)/);
  if (!match || match[1] !== csrfToken) {
    await logError(c.env.DB, {
      source: "mcp:oauth",
      message: "POST /authorize CSRF validation failed",
      context: { hadCookieMatch: !!match, hadFormToken: !!csrfToken },
    });
    return c.text("CSRF validation failed. Please go back and try again.", 403);
  }

  const email = ((formData.get("email") as string) || "").trim().toLowerCase();
  const password = (formData.get("password") as string) || "";
  const stateData = (formData.get("state") as string) || "";

  // OPE-900 — resolve the authorization request from KV by id. The body no
  // longer carries the request itself, so there is nothing in it to tamper
  // with. A tampered, unknown or expired id is indistinguishable from here and
  // all three get the same 400: the request was never minted, or is gone.
  if (!STATE_ID_RE.test(stateData)) {
    await logError(c.env.DB, {
      source: "mcp:oauth",
      message: "POST /authorize state id malformed",
      context: { stateLen: stateData.length },
    });
    return c.text("Invalid authorization state. Please start the connection again.", 400);
  }

  const pending = await c.env.OAUTH_KV.get(PENDING_STATE_PREFIX + stateData);
  if (pending === null) {
    await logError(c.env.DB, {
      level: "warn",
      source: "mcp:oauth",
      message: "POST /authorize state id not found or expired",
      context: { stateId: stateData },
    });
    return c.text("Invalid authorization state. Please start the connection again.", 400);
  }

  let oauthReqInfo;
  try {
    oauthReqInfo = JSON.parse(pending);
  } catch (err) {
    await logError(c.env.DB, {
      source: "mcp:oauth",
      message: "POST /authorize stored state failed to parse",
      error: err,
      context: { stateId: stateData },
    });
    return c.text("Invalid authorization state. Please start the connection again.", 400);
  }

  // Validate credentials against D1
  const db = getDb(c.env.DB);
  const user = await lookupUser(db, email);

  if (!user || !user.passwordHash) {
    await logError(c.env.DB, {
      level: "warn",
      source: "mcp:oauth",
      message: "POST /authorize unknown email or missing passwordHash",
      context: { email },
    });
    return loginError(c, stateData, "Invalid email or password.");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    await logError(c.env.DB, {
      level: "warn",
      source: "mcp:oauth",
      message: "POST /authorize password verification failed",
      context: { email, userId: user.id },
    });
    return loginError(c, stateData, "Invalid email or password.");
  }

  // Build user props for the OAuth token
  const props = await resolveUserProps(db, user);

  console.log("[LOGIN] Credentials valid for", user.email, "role:", user.role);

  // Complete the OAuth authorization — generates an auth code and redirects
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: user.id,
    scope: oauthReqInfo.scope,
    props,
    metadata: {},
  });

  // OPE-900 — single-use. The auth code exists now; replaying this id must not
  // mint a second one. Deleted AFTER completeAuthorization so a failure there
  // leaves the user able to retry rather than stranded on a dead id.
  await c.env.OAUTH_KV.delete(PENDING_STATE_PREFIX + stateData);

  console.log("[LOGIN] Redirecting to:", redirectTo.slice(0, 100) + "...");
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      "Set-Cookie": "__Host-CSRF=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0",
    },
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loginError(c: any, stateData: string, message: string) {
  const newCsrf = crypto.randomUUID();
  return c.html(renderLoginPage(newCsrf, stateData, message), 200, {
    "Set-Cookie": `__Host-CSRF=${newCsrf}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
  });
}

function renderLoginPage(csrfToken: string, stateData: string, error: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign In — Meet Me at the Fair</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f5f0; color: #333;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 1rem;
    }
    .card {
      background: white; border-radius: 12px; padding: 2rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 400px; width: 100%;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; color: #1a1a1a; }
    .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
    label { display: block; font-weight: 500; margin-bottom: 0.25rem; font-size: 0.9rem; }
    input[type="email"], input[type="password"] {
      width: 100%; padding: 0.6rem 0.8rem; border: 1px solid #ddd;
      border-radius: 6px; font-size: 1rem; margin-bottom: 1rem;
    }
    input:focus { outline: none; border-color: #8b5e3c; box-shadow: 0 0 0 2px rgba(139,94,60,0.2); }
    button {
      width: 100%; padding: 0.7rem; background: #8b5e3c; color: white;
      border: none; border-radius: 6px; font-size: 1rem; cursor: pointer;
      font-weight: 500; margin-top: 0.5rem;
    }
    button:hover { background: #7a5235; }
    .error {
      background: #fef2f2; color: #b91c1c; padding: 0.6rem 0.8rem;
      border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem;
    }
    .info {
      background: #f0f7ff; color: #1e40af; padding: 0.6rem 0.8rem;
      border-radius: 6px; margin-bottom: 1rem; font-size: 0.85rem;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Meet Me at the Fair</h1>
    <p class="subtitle">Sign in to connect your account with Claude</p>
    <div class="info">
      Claude is requesting access to your Meet Me at the Fair account.
      Sign in to authorize the connection.
    </div>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/authorize">
      <input type="hidden" name="csrf_token" value="${csrfToken}" />
      <input type="hidden" name="state" value="${escapeHtml(stateData)}" />
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" />
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" />
      <button type="submit">Sign In &amp; Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { app as LoginHandler };
