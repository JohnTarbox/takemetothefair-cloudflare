import { SignJWT, importPKCS8 } from "jose";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_CACHE_TTL = 3000;
const REQUEST_TIMEOUT_MS = 10_000;

export type GoogleAuthEnv = {
  GA4_SA_CLIENT_EMAIL?: string;
  GA4_SA_PRIVATE_KEY?: string;
  RATE_LIMIT_KV?: KVNamespace;
};

export class GoogleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthConfigError";
  }
}

export class GoogleAuthError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Google auth error ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
    this.name = "GoogleAuthError";
  }
}

type Credentials = { clientEmail: string; privateKey: string };

function resolveCredentials(env: GoogleAuthEnv): Credentials {
  const clientEmail = env.GA4_SA_CLIENT_EMAIL?.trim();
  const rawKey = env.GA4_SA_PRIVATE_KEY;
  const missing: string[] = [];
  if (!clientEmail) missing.push("GA4_SA_CLIENT_EMAIL");
  if (!rawKey) missing.push("GA4_SA_PRIVATE_KEY");
  if (missing.length) {
    throw new GoogleAuthConfigError(
      `Missing Google service account env vars: ${missing.join(", ")}.`
    );
  }
  return { clientEmail: clientEmail!, privateKey: rawKey!.replace(/\\n/g, "\n").trim() };
}

export async function getGoogleAccessToken(
  env: GoogleAuthEnv,
  scope: string,
  opts: { skipCache?: boolean; cacheKey?: string } = {}
): Promise<string> {
  const kv = env.RATE_LIMIT_KV;
  const cacheKey = opts.cacheKey ?? `google:token:${scope}`;
  if (!opts.skipCache && kv) {
    const cached = await kv.get(cacheKey);
    if (cached) return cached;
  }

  const { clientEmail, privateKey } = resolveCredentials(env);
  const key = await importPKCS8(privateKey, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(clientEmail)
    .setAudience(OAUTH_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new GoogleAuthError(res.status, `OAuth token exchange failed: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new GoogleAuthError(500, "OAuth response missing access_token");
  }

  if (kv) {
    const ttl = Math.min(json.expires_in ?? 3600, TOKEN_CACHE_TTL);
    await kv.put(cacheKey, json.access_token, { expirationTtl: ttl });
  }
  return json.access_token;
}
