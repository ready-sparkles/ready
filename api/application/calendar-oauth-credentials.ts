import { GOOGLE_CALENDAR_SCOPES } from "@readymeet/shared";

import {
  type CalendarAccountProfile,
  type CalendarTokenSet,
  getCalendarAccountProfile,
  isCalendarProviderAuthError,
  refreshCalendarToken,
  revokeGoogleCalendarToken,
} from "./calendar-client";

const PENDING_GOOGLE_OFFLINE_GRANT_MISMATCH = "Pending Google offline grant does not match the account";

// This server-only envelope deliberately is not a CalendarTokenSet: consumers
// cannot use its access token before offline access and identity are validated.
export type PendingGoogleAddonCalendarCredentials = {
  kind: "google-addon-calendar-pending-v1";
  userId: string;
  googleSubject: string;
  tokens: CalendarTokenSet;
};

export function hasGoogleCalendarScopes(scope: string): boolean {
  const scopes = new Set(scope.split(/[,\s]+/).filter(Boolean));
  if (scopes.has("email")) {
    scopes.add("https://www.googleapis.com/auth/userinfo.email");
  }

  return GOOGLE_CALENDAR_SCOPES.every((scope) => scopes.has(scope));
}

export function readPendingGoogleAddonCalendarCredentials(
  ...args: [value: unknown, userId: string, googleSubject: string]
): CalendarTokenSet | null {
  const [value, userId, googleSubject] = args;
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }
  const pending = value as Partial<PendingGoogleAddonCalendarCredentials>;
  if (
    pending.kind !== "google-addon-calendar-pending-v1" ||
    pending.userId !== userId ||
    pending.googleSubject !== googleSubject ||
    pending.tokens?.provider !== "google_calendar" ||
    typeof pending.tokens.refreshToken !== "string" ||
    pending.tokens.refreshToken === "" ||
    typeof pending.tokens.scope !== "string" ||
    !hasGoogleCalendarScopes(pending.tokens.scope)
  ) {
    return null;
  }

  return pending.tokens;
}

export async function getRevocableCalendarTokens(
  ...args: [
    stored: CalendarTokenSet | PendingGoogleAddonCalendarCredentials,
    userId: string,
    googleSubject: string | null,
  ]
): Promise<CalendarTokenSet | null> {
  const [stored, userId, googleSubject] = args;
  if ("provider" in stored) {
    return stored;
  }
  const pending =
    googleSubject !== null && googleSubject !== ""
      ? readPendingGoogleAddonCalendarCredentials(stored, userId, googleSubject)
      : null;
  if (pending === null) {
    return null;
  }
  const refreshed = await refreshCalendarToken(pending);
  const profile = await getCalendarAccountProfile(refreshed, "", true);
  if (profile.providerAccountId !== googleSubject) {
    throw new Error(PENDING_GOOGLE_OFFLINE_GRANT_MISMATCH);
  }

  return refreshed;
}

export async function revokeStoredGoogleCalendarCredentials(input: {
  active: CalendarTokenSet | null;
  pending: PendingGoogleAddonCalendarCredentials | null;
  userId: string;
  googleSubject: string | null;
}): Promise<Record<string, unknown>> {
  const initialResult: Record<string, unknown> = {
    provider: "google_calendar",
    /** @external calendar revoke result attempted flag */
    attempted: false,
    reason: "no_verified_credentials",
  };
  const revokeOne = async (attempt: {
    stored: CalendarTokenSet | PendingGoogleAddonCalendarCredentials | null;
    current: Record<string, unknown>;
  }) => {
    if (!attempt.stored) {
      return { isFinished: false, result: attempt.current };
    }
    try {
      const tokens = await getRevocableCalendarTokens(attempt.stored, input.userId, input.googleSubject);
      if (tokens === null) {
        return { isFinished: false, result: attempt.current };
      }
      const result = await revokeGoogleCalendarToken(tokens);

      return { isFinished: result.ok, result };
    } catch (error) {
      return {
        isFinished: false,
        result: {
          provider: "google_calendar",
          /** @external calendar revoke result attempted flag */
          attempted: true,
          /** @external calendar revoke result ok flag */
          ok: false,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
      };
    }
  };
  const pendingOutcome = await revokeOne({ stored: input.pending, current: initialResult });
  if (pendingOutcome.isFinished) {
    return pendingOutcome.result;
  }
  const activeOutcome = await revokeOne({ stored: input.active, current: pendingOutcome.result });

  return activeOutcome.result;
}

type StoredCalendarAccount = {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string | null;
  status: string;
};

type RestoreCalendarRefreshTokenInput = {
  userId: string;
  tokens: CalendarTokenSet;
  accountProfile: CalendarAccountProfile;
  accounts: StoredCalendarAccount[];
  readTokens: (accountId: string) => Promise<CalendarTokenSet | null>;
  readPendingTokens?: (accountId: string) => Promise<PendingGoogleAddonCalendarCredentials | null>;
  preservePending?: (credentials: PendingGoogleAddonCalendarCredentials) => Promise<void>;
};

function isRestorableCalendarAccount(params: {
  candidate: StoredCalendarAccount;
  userId: string;
  provider: string;
  providerAccountId: string | null;
}): boolean {
  const { candidate, userId, provider, providerAccountId } = params;

  return (
    candidate.userId === userId &&
    candidate.provider === provider &&
    (candidate.status === "connected" || candidate.status === "error") &&
    Boolean(candidate.providerAccountId) &&
    candidate.providerAccountId === providerAccountId
  );
}

async function refreshConnectedStoredCalendarTokens(params: {
  input: RestoreCalendarRefreshTokenInput;
  account: StoredCalendarAccount;
}): Promise<CalendarTokenSet | null> {
  const { input, account } = params;
  const stored = account.status === "connected" ? await input.readTokens(account.id) : null;
  if (stored === null || stored.refreshToken === "" || stored.provider !== input.tokens.provider) {
    return null;
  }
  try {
    return await refreshCalendarToken(stored);
  } catch (error) {
    // A fresh grant can be waiting beside an older revoked active grant.
    // Only authentication failure permits falling back; an outage does not.
    if (!isCalendarProviderAuthError(error)) {
      throw error;
    }

    return null;
  }
}

async function refreshPendingOfflineCalendarTokens(params: {
  input: RestoreCalendarRefreshTokenInput;
  account: StoredCalendarAccount;
  providerAccountId: string;
}): Promise<CalendarTokenSet> {
  const { input, account, providerAccountId } = params;
  const pending = readPendingGoogleAddonCalendarCredentials(
    await input.readPendingTokens?.(account.id),
    input.userId,
    providerAccountId,
  );
  if (pending === null) {
    return input.tokens;
  }
  try {
    // Exercise offline access before saving it. Return the refreshed credentials
    // so the callback checks Calendar access with this grant (and keeps rotation).
    const refreshed = await refreshCalendarToken(pending);
    if (!hasGoogleCalendarScopes(refreshed.scope)) {
      return input.tokens;
    }
    await input.preservePending?.({
      kind: "google-addon-calendar-pending-v1",
      userId: input.userId,
      googleSubject: providerAccountId,
      tokens: refreshed,
    });
    const refreshedProfile = await getCalendarAccountProfile(refreshed, "", true);
    if (refreshedProfile.providerAccountId !== input.accountProfile.providerAccountId) {
      throw new Error(PENDING_GOOGLE_OFFLINE_GRANT_MISMATCH);
    }

    return refreshed;
  } catch (error) {
    // Revoked credentials are equivalent to missing offline access: the callback
    // can request consent once, guarded by its signed recoveringOfflineAccess flag.
    if (isCalendarProviderAuthError(error)) {
      return input.tokens;
    }
    // Network/provider failures must not trigger an unnecessary consent prompt.
    throw error;
  }
}

// Never combine a new account's access token with another account's refresh
// token. The caller must obtain accountProfile from Google's userinfo API.
export async function restoreCalendarRefreshToken(input: RestoreCalendarRefreshTokenInput): Promise<CalendarTokenSet> {
  if (Boolean(input.tokens.refreshToken) || input.tokens.provider !== "google_calendar") {
    return input.tokens;
  }
  const account = input.accounts.find((candidate) =>
    isRestorableCalendarAccount({
      candidate,
      userId: input.userId,
      provider: input.tokens.provider,
      providerAccountId: input.accountProfile.providerAccountId,
    }),
  );
  if (account === undefined) {
    return input.tokens;
  }
  const fromStored = await refreshConnectedStoredCalendarTokens({ input, account });
  if (fromStored !== null) {
    return fromStored;
  }
  const providerAccountId = input.accountProfile.providerAccountId;
  if (providerAccountId === null || providerAccountId.length === 0) {
    return input.tokens;
  }

  return refreshPendingOfflineCalendarTokens({ input, account, providerAccountId });
}
