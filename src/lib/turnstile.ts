import { getRequestContext } from "@cloudflare/next-on-pages";

export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes?: string[];
  challengeTs?: string;
  hostname?: string;
}

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
}

/**
 * Get the Turnstile secret key from environment
 */
function getTurnstileSecretKey(): string | null {
  try {
    const { env } = getRequestContext();
    return (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY ?? null;
  } catch {
    return process.env.TURNSTILE_SECRET_KEY ?? null;
  }
}

/**
 * Get the client IP address from the request
 */
function getClientIp(request: Request): string {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;

  const forwardedFor = request.headers.get("X-Forwarded-For");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return "";
}

/**
 * Verify a Turnstile token with Cloudflare's siteverify API
 *
 * @param token - The Turnstile response token from the client
 * @param request - The incoming request (used to extract client IP)
 * @returns Verification result with success status and optional error codes
 */
export async function verifyTurnstileToken(
  token: string,
  request: Request
): Promise<TurnstileVerifyResult> {
  const secretKey = getTurnstileSecretKey();

  if (!secretKey) {
    console.warn("[Turnstile] Secret key not configured, skipping verification");
    // In development without a secret key, allow requests through
    return { success: true };
  }

  if (!token) {
    return {
      success: false,
      errorCodes: ["missing-input-response"],
    };
  }

  const clientIp = getClientIp(request);

  try {
    const formData = new URLSearchParams();
    formData.append("secret", secretKey);
    formData.append("response", token);
    if (clientIp) {
      formData.append("remoteip", clientIp);
    }

    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
      }
    );

    if (!response.ok) {
      console.error("[Turnstile] API error:", response.status, response.statusText);
      return {
        success: false,
        errorCodes: ["api-error"],
      };
    }

    const data = (await response.json()) as TurnstileResponse;

    return {
      success: data.success,
      errorCodes: data["error-codes"],
      challengeTs: data.challenge_ts,
      hostname: data.hostname,
    };
  } catch (error) {
    console.error("[Turnstile] Verification error:", error);
    return {
      success: false,
      errorCodes: ["network-error"],
    };
  }
}

/**
 * Human-readable error messages for Turnstile error codes
 */
export function getTurnstileErrorMessage(errorCodes?: string[]): string {
  if (!errorCodes || errorCodes.length === 0) {
    return "Verification failed. Please try again.";
  }

  const code = errorCodes[0];

  switch (code) {
    case "missing-input-secret":
      return "Server configuration error. Please try again later.";
    case "invalid-input-secret":
      return "Server configuration error. Please try again later.";
    case "missing-input-response":
      return "Please complete the security check.";
    case "invalid-input-response":
      return "Security check expired or invalid. Please try again.";
    case "bad-request":
      return "Invalid request. Please try again.";
    case "timeout-or-duplicate":
      return "Security check expired. Please try again.";
    case "internal-error":
      return "Security service error. Please try again later.";
    case "api-error":
    case "network-error":
      return "Could not verify security check. Please try again.";
    default:
      return "Verification failed. Please try again.";
  }
}
