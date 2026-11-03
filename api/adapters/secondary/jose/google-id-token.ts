import { createRemoteJWKSet, jwtVerify } from "./sdk";

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

type GoogleIdTokenClaims = {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  // tokeninfo returns this as the string "true"; the raw JWT carries a
  // boolean. Accept either via isVerifiedEmailClaim.
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
};

export function isVerifiedEmailClaim(value: string | boolean | undefined): boolean {
  return value === true || value === "true";
}

/**
 * Verifies a Google OIDC ID token locally against Google's cached signing
 * keys. This removes a tokeninfo network round-trip from first-use add-on
 * signup while still checking signature, issuer, and expiry. Audience is
 * checked by the caller against its deployment-specific allowlist.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      algorithms: ["RS256"],
    });
    if (typeof payload.iss !== "string" || typeof payload.aud !== "string" || typeof payload.sub !== "string") {
      return null;
    }

    return {
      iss: payload.iss,
      aud: payload.aud,
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      email_verified:
        typeof payload.email_verified === "boolean" || typeof payload.email_verified === "string"
          ? payload.email_verified
          : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
      picture: typeof payload.picture === "string" ? payload.picture : undefined,
    };
  } catch (error) {
    void error;

    return null;
  }
}
