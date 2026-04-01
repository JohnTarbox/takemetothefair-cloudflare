import { Hono } from "hono";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { getDb } from "../db.js";
import { lookupUser, verifyPassword, resolveUserProps } from "./utils.js";

interface Env {
  DB: D1Database;
  OAUTH_PROVIDER: OAuthHelpers;
}

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
  console.log("[LOGIN] Parsed auth request:", JSON.stringify({ clientId: oauthReqInfo.clientId, redirectUri: oauthReqInfo.redirectUri, scope: oauthReqInfo.scope }));
  if (!oauthReqInfo.clientId) {
    console.log("[LOGIN] No client_id in auth request");
    return c.text("Invalid authorization request", 400);
  }

  const csrfToken = crypto.randomUUID();
  const stateData = btoa(JSON.stringify(oauthReqInfo));

  return c.html(renderLoginPage(csrfToken, stateData, null), 200, {
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
    return c.text("CSRF validation failed. Please go back and try again.", 403);
  }

  const email = (formData.get("email") as string || "").trim().toLowerCase();
  const password = formData.get("password") as string || "";
  const stateData = formData.get("state") as string || "";

  // Decode the original OAuth request
  let oauthReqInfo;
  try {
    oauthReqInfo = JSON.parse(atob(stateData));
  } catch {
    return c.text("Invalid authorization state. Please start the connection again.", 400);
  }

  // Validate credentials against D1
  const db = getDb(c.env.DB);
  const user = await lookupUser(db, email);

  if (!user || !user.passwordHash) {
    return loginError(c, stateData, "Invalid email or password.");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
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

function renderLoginPage(
  csrfToken: string,
  stateData: string,
  error: string | null,
): string {
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
