import type { OAuthSignInProvider } from "./auth-client";

const STORAGE_KEY = "readymeet-last-sign-in-provider";

export function readRememberedAuthProvider(): OAuthSignInProvider | null {
  try {
    const provider = window.localStorage.getItem(STORAGE_KEY);

    return provider === "google" || provider === "microsoft-entra-id" ? provider : null;
  } catch (error) {
    void error;

    return null;
  }
}

export function rememberAuthProvider(provider: unknown): void {
  if (provider !== "google" && provider !== "microsoft-entra-id") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, provider);
  } catch (error) {
    void error;
    // Remembering a preference must never prevent sign-in.
  }
}
