import { Hono } from "hono";
import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { getDb } from "../db.js";
import { logError } from "../logger.js";
import {
  lookupUser,
  verifyPassword,
  resolveUserProps,
  isLegacyPasswordHash,
  upgradePasswordHash,
} from "./utils.js";
import { clientIp, throttleAuthorize, type BurstCounterNamespace } from "./authorize-throttle.js";

interface Env {
  DB: D1Database;
  OAUTH_PROVIDER: OAuthHelpers;
  /** OPE-900 — holds the pending authorization request; see PENDING_STATE_PREFIX. */
  OAUTH_KV: KVNamespace;
  /** OPE-900 step 4 — the OPE-951 Durable Object counter; see authorize-throttle.ts. */
  BURST_COUNTER?: BurstCounterNamespace;
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

  // OPE-900 step 2 — the page names what is being authorized. A client this
  // provider does not know cannot be consented to, so refuse before minting state.
  const consent = await consentFor(c.env.OAUTH_PROVIDER, oauthReqInfo);
  if (!consent) {
    await logError(c.env.DB, {
      level: "warn",
      source: "mcp:oauth",
      message: "GET /authorize unknown client",
      context: { clientId: oauthReqInfo.clientId },
    });
    return c.text("Invalid authorization request", 400);
  }

  const csrfToken = crypto.randomUUID();
  const stateId = crypto.randomUUID();
  await c.env.OAUTH_KV.put(PENDING_STATE_PREFIX + stateId, JSON.stringify(oauthReqInfo), {
    expirationTtl: PENDING_STATE_TTL_SECONDS,
  });

  return c.html(renderLoginPage(csrfToken, stateId, null, consent), 200, {
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

  // OPE-900 step 2 — Deny. No credentials needed to refuse; CSRF and a minted
  // state still are, so a third party cannot deny on the user's behalf. The
  // redirect URI was validated against the client's registered URIs by
  // parseAuthRequest before it was stored, so this is not an open redirect.
  if (formData.get("action") === "deny") {
    await c.env.OAUTH_KV.delete(PENDING_STATE_PREFIX + stateData);
    return new Response(null, {
      status: 302,
      headers: {
        Location: accessDeniedRedirect(oauthReqInfo),
        "Set-Cookie": "__Host-CSRF=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0",
      },
    });
  }

  // OPE-900 step 4 — throttle BEFORE the password is looked at. The state is
  // not burned: the user can retry from the same page once the window passes.
  const throttle = await throttleAuthorize(c.env.BURST_COUNTER, clientIp(c.req.raw), email);
  if (!throttle.allowed) {
    await logError(c.env.DB, {
      level: "warn",
      source: "mcp:oauth",
      message: `POST /authorize refused: ${throttle.reason}`,
      context: { reason: throttle.reason, retryAfterSeconds: throttle.retryAfterSeconds },
    });
    const retry = throttle.retryAfterSeconds;
    const newCsrf = crypto.randomUUID();
    const consent = await consentFor(c.env.OAUTH_PROVIDER, oauthReqInfo);
    return c.html(
      renderLoginPage(
        newCsrf,
        stateData,
        `Too many sign-in attempts. Please wait ${retry} seconds and try again.`,
        consent
      ),
      429,
      {
        "Retry-After": String(retry),
        "Set-Cookie": `__Host-CSRF=${newCsrf}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
      }
    );
  }
  if (throttle.reason === "limiter-threw") {
    await logError(c.env.DB, {
      source: "mcp:oauth",
      message: "POST /authorize throttle threw; attempt allowed",
      error: throttle.error,
    });
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
    return loginError(c, stateData, oauthReqInfo, "Invalid email or password.");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    await logError(c.env.DB, {
      level: "warn",
      source: "mcp:oauth",
      message: "POST /authorize password verification failed",
      context: { email, userId: user.id },
    });
    return loginError(c, stateData, oauthReqInfo, "Invalid email or password.");
  }

  // OPE-902 — upgrade a legacy unsalted SHA-256 hash now that it has verified.
  // Nothing else ever rewrote these, so they would have stayed unsalted for as
  // long as the account existed. Deliberately not awaited into the failure
  // path: if the write throws, the user is still signed in and the next login
  // simply tries again — a hardening step must not be able to lock anyone out.
  if (isLegacyPasswordHash(user.passwordHash)) {
    try {
      await upgradePasswordHash(db, user.id, password);
    } catch (err) {
      await logError(c.env.DB, {
        level: "warn",
        source: "mcp:oauth",
        message: "legacy password hash upgrade failed; login allowed to proceed",
        error: err,
        context: { userId: user.id },
      });
    }
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

/** What the consent block shows. Every field is display-only and escaped. */
export interface ConsentInfo {
  clientName: string;
  clientUri: string | null;
  redirectHost: string;
}

/**
 * OPE-900 step 2. `clientName` is whatever the client registered — any caller
 * can self-register as "Claude" — so the page leads with the REDIRECT HOST,
 * which the provider has checked against the client's registered URIs and which
 * is where the authorization actually goes.
 */
export async function consentFor(
  provider: OAuthHelpers,
  req: Pick<AuthRequest, "clientId" | "redirectUri">
): Promise<ConsentInfo | null> {
  const client: ClientInfo | null = await provider.lookupClient(req.clientId);
  if (!client) return null;
  let redirectHost: string;
  try {
    redirectHost = new URL(req.redirectUri).host || req.redirectUri;
  } catch {
    redirectHost = req.redirectUri;
  }
  return {
    clientName: client.clientName?.trim() || client.clientId,
    clientUri: client.clientUri ?? null,
    redirectHost,
  };
}

/** RFC 6749 §4.1.2.1 — the error goes back to the client, with its state. */
export function accessDeniedRedirect(req: Pick<AuthRequest, "redirectUri" | "state">): string {
  const u = new URL(req.redirectUri);
  u.searchParams.set("error", "access_denied");
  if (req.state) u.searchParams.set("state", req.state);
  return u.toString();
}

async function loginError(c: any, stateData: string, req: AuthRequest, message: string) {
  const newCsrf = crypto.randomUUID();
  const consent = await consentFor(c.env.OAUTH_PROVIDER, req);
  return c.html(renderLoginPage(newCsrf, stateData, message, consent), 200, {
    "Set-Cookie": `__Host-CSRF=${newCsrf}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
  });
}

function renderLoginPage(
  csrfToken: string,
  stateData: string,
  error: string | null,
  consent: ConsentInfo | null
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
    button.deny { background: white; color: #7a5235; border: 1px solid #d6c3b3; }
    button.deny:hover { background: #faf6f2; }
    .consent dt { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; color: #52627a; margin-top: 0.4rem; }
    .consent dd { font-weight: 600; word-break: break-all; }
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
    <p class="subtitle">Sign in to approve a connection to your account</p>
    ${renderConsent(consent)}
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/authorize">
      <input type="hidden" name="csrf_token" value="${csrfToken}" />
      <input type="hidden" name="state" value="${escapeHtml(stateData)}" />
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" />
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" />
      <button type="submit" name="action" value="approve">Sign In &amp; Approve</button>
      <button type="submit" name="action" value="deny" class="deny" formnovalidate>Deny</button>
    </form>
  </div>
</body>
</html>`;
}

function renderConsent(consent: ConsentInfo | null): string {
  if (!consent) {
    return `<div class="info">An application is requesting access to your Meet Me at the Fair account.</div>`;
  }
  return `<div class="info consent">
      <strong>${escapeHtml(consent.clientName)}</strong> is requesting access to your Meet Me at the Fair account.
      <dl>
        <dt>Sends you back to</dt>
        <dd>${escapeHtml(consent.redirectHost)}</dd>
        ${consent.clientUri ? `<dt>Says it is from</dt><dd>${escapeHtml(consent.clientUri)}</dd>` : ""}
      </dl>
      Only approve if you started this connection and recognise that address.
    </div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { app as LoginHandler };
