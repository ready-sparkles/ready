import type { MeetingJoinRequest } from "@readymeet/shared";

import { reportOptionalLiveServiceFailure } from "./optional-live-feature-failure";

const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_FORBIDDEN_STATUS = 403;

type JoinRequestSession = { token: string };

type LoadJoinRequestsInput = {
  /** View lifetime only; request timeouts must still be reported. */
  signal?: AbortSignal;
  token: string;
  listJoinRequests: (token: string) => Promise<MeetingJoinRequest[]>;
  refreshAuthAfterUnauthorized: (error: unknown) => Promise<JoinRequestSession | null>;
  setJoinRequests: (requests: MeetingJoinRequest[]) => void;
  setCanModerateJoinRequests: (canModerate: boolean) => void;
  /** Called when the API says this viewer cannot moderate, so callers can stop asking. */
  onForbidden?: () => void;
};

function applyJoinRequests(update: { input: LoadJoinRequestsInput; requests: MeetingJoinRequest[] }): void {
  update.input.setCanModerateJoinRequests(true);
  update.input.setJoinRequests(update.requests);
}

function revokeJoinRequestModeration(input: LoadJoinRequestsInput): void {
  input.setJoinRequests([]);
  input.setCanModerateJoinRequests(false);
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const { status } = error;

  return typeof status === "number" ? status : null;
}

function stopJoinRequestLoad(update: { load: LoadJoinRequestsInput; error: unknown }): boolean {
  if (update.load.signal?.aborted === true) {
    return true;
  }
  if (reportOptionalLiveServiceFailure({ error: update.error, feature: "realtime" })) {
    return true;
  }
  if (httpStatus(update.error) === HTTP_FORBIDDEN_STATUS) {
    revokeJoinRequestModeration(update.load);
    update.load.onForbidden?.();

    return true;
  }

  return httpStatus(update.error) !== HTTP_UNAUTHORIZED_STATUS;
}

/**
 * Loads waiting join requests for the host.
 * A 5xx, timeout, or other non-access failure keeps the current list and controls.
 * Only a failed 401 refresh or a 403 removes admit and deny; a 403 also reports `onForbidden`.
 */
export async function loadJoinRequestsKeepingControlsOnOutage(input: LoadJoinRequestsInput): Promise<void> {
  try {
    applyJoinRequests({ input, requests: await input.listJoinRequests(input.token) });

    return;
  } catch (nextError) {
    if (stopJoinRequestLoad({ load: input, error: nextError })) {
      return;
    }
    const nextSession = await input.refreshAuthAfterUnauthorized(nextError);
    if (!nextSession) {
      revokeJoinRequestModeration(input);

      return;
    }
    try {
      applyJoinRequests({ input, requests: await input.listJoinRequests(nextSession.token) });
    } catch (retryError) {
      if (stopJoinRequestLoad({ load: input, error: retryError })) {
        return;
      }
      revokeJoinRequestModeration(input);
    }
  }
}
