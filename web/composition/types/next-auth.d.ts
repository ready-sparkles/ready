import "next-auth";
import "next-auth/jwt";

import type { User as ReadyMeetUser } from "@readymeet/shared";

declare module "next-auth" {
  interface Session {
    apiToken?: string;
    apiRefreshRetryAt?: number;
    appUser?: ReadyMeetUser;
    authError?: "missing_app_auth";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    apiToken?: string;
    apiRefreshRetryAt?: number;
    appUser?: ReadyMeetUser;
    apiAuthProvider?: "dev-login" | "google" | "microsoft-entra-id";
    oauthProvider?: "google" | "microsoft-entra-id";
    oauthProviderAccountId?: string;
  }
}
