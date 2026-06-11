import { describe, it, expect } from "vitest";
import { getGoogleAccessToken, GoogleAuthConfigError } from "../google-auth";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

describe("getGoogleAccessToken — config resilience", () => {
  it("throws GoogleAuthConfigError (not a raw jose error) for a malformed private key", async () => {
    // Regression for the 2026-06-11 /admin/analytics crash: a malformed
    // GA4_SA_PRIVATE_KEY made importPKCS8 throw a RAW error that escaped the
    // Ga4*Error mapping + the analytics loaders' catches → the whole page
    // crashed. It must now surface as a typed config error so the GA4 cards
    // degrade to "—" instead.
    await expect(
      getGoogleAccessToken(
        {
          GA4_SA_CLIENT_EMAIL: "svc@proj.iam.gserviceaccount.com",
          GA4_SA_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot-real-base64\n-----END PRIVATE KEY-----",
        },
        SCOPE,
        { skipCache: true }
      )
    ).rejects.toBeInstanceOf(GoogleAuthConfigError);
  });

  it("throws GoogleAuthConfigError for a non-PEM key string", async () => {
    await expect(
      getGoogleAccessToken(
        { GA4_SA_CLIENT_EMAIL: "svc@proj.iam.gserviceaccount.com", GA4_SA_PRIVATE_KEY: "garbage" },
        SCOPE,
        { skipCache: true }
      )
    ).rejects.toBeInstanceOf(GoogleAuthConfigError);
  });

  it("throws GoogleAuthConfigError when credentials are missing", async () => {
    await expect(
      getGoogleAccessToken({ GA4_SA_CLIENT_EMAIL: "svc@proj.iam.gserviceaccount.com" }, SCOPE, {
        skipCache: true,
      })
    ).rejects.toBeInstanceOf(GoogleAuthConfigError);
  });
});
