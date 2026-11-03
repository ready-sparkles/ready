import { type CalendarTokenSet, getCalendarAccountProfile, refreshCalendarToken } from "./calendar-client";
import {
  hasGoogleCalendarScopes,
  type PendingGoogleAddonCalendarCredentials,
  readPendingGoogleAddonCalendarCredentials,
} from "./calendar-oauth-credentials";

const GOOGLE_ADDON_CALENDAR_MESSAGE = {
  grantSubjectMismatch: "Google offline grant does not match the add-on account.",
  setupFailed: "Marketplace Calendar setup failed; completing sign-in so the user can reconnect.",
} as const;

type GoogleAddonCalendarStage = "storage" | "validation" | "connection";

type ValidatedGoogleAddonGrant = {
  tokens: CalendarTokenSet;
  accountProfile: Awaited<ReturnType<typeof getCalendarAccountProfile>>;
};

// The caller must first validate the signed add-on handoff and its Ready user
// binding. Validate the actual offline grant too, including its Google subject.
export async function validateGoogleAddonCalendarGrant(input: {
  credentials: Omit<CalendarTokenSet, "provider">;
  googleSubject: string;
  preserve?: (tokens: CalendarTokenSet) => Promise<void>;
}): Promise<ValidatedGoogleAddonGrant | null> {
  if (input.credentials.refreshToken.length === 0) {
    return null;
  }
  const tokens = await refreshCalendarToken({
    ...input.credentials,
    provider: "google_calendar",
  });
  if (!hasGoogleCalendarScopes(tokens.scope)) {
    return null;
  }
  // Preserve rotation before another provider request can fail.
  await input.preserve?.(tokens);
  const accountProfile = await getCalendarAccountProfile(tokens, "", true);
  if (accountProfile.providerAccountId !== input.googleSubject) {
    throw new Error(GOOGLE_ADDON_CALENDAR_MESSAGE.grantSubjectMismatch);
  }

  return { tokens, accountProfile };
}

async function resolveGoogleAddonCredentials(input: {
  credentials: Omit<CalendarTokenSet, "provider">;
  googleSubject: string;
  pending?: {
    userId: string;
    stage: (credentials: PendingGoogleAddonCalendarCredentials) => Promise<void>;
    read: () => Promise<unknown>;
  };
}): Promise<Omit<CalendarTokenSet, "provider">> {
  const pending = input.pending;
  if (input.credentials.refreshToken.length > 0 && hasGoogleCalendarScopes(input.credentials.scope)) {
    return input.credentials;
  }
  if (input.credentials.refreshToken.length === 0 && pending !== undefined) {
    const stored = readPendingGoogleAddonCalendarCredentials(await pending.read(), pending.userId, input.googleSubject);
    if (stored !== null) {
      return stored;
    }
  }

  return input.credentials;
}

// Calendar import is optional setup after the caller has authenticated the
// Google account and verified its signed Ready handoff. Provider outages must
// not prevent that already-verified user from receiving their Ready session.
export async function importGoogleAddonCalendarSafely(input: {
  credentials: Omit<CalendarTokenSet, "provider">;
  googleSubject: string;
  pending?: {
    userId: string;
    stage: (credentials: PendingGoogleAddonCalendarCredentials) => Promise<void>;
    read: () => Promise<unknown>;
  };
  connect: (grant: ValidatedGoogleAddonGrant) => Promise<unknown>;
  warn: (...args: [details: Record<string, unknown>, message: string]) => void;
}): Promise<boolean> {
  const stageState = { stage: "storage" as GoogleAddonCalendarStage };
  try {
    const pending = input.pending;
    const preserve =
      pending !== undefined
        ? async (tokens: CalendarTokenSet) => {
            await pending.stage({
              kind: "google-addon-calendar-pending-v1",
              userId: pending.userId,
              googleSubject: input.googleSubject,
              tokens,
            });
          }
        : undefined;
    const credentials = await resolveGoogleAddonCredentials(input);
    if (credentials.refreshToken.length > 0 && hasGoogleCalendarScopes(credentials.scope)) {
      await preserve?.({ ...credentials, provider: "google_calendar" });
    }
    stageState.stage = "validation";
    const grant = await validateGoogleAddonCalendarGrant({
      credentials,
      googleSubject: input.googleSubject,
      preserve,
    });
    if (grant === null) {
      return false;
    }
    stageState.stage = "connection";
    await input.connect(grant);

    return true;
  } catch (error) {
    // Never log provider credentials or arbitrary Google response bodies.
    input.warn(
      { stage: stageState.stage, errorType: error instanceof Error ? error.name : "UnknownError" },
      GOOGLE_ADDON_CALENDAR_MESSAGE.setupFailed,
    );

    return false;
  }
}
