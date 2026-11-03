import type { User } from "@readymeet/shared";

import { apiTokenMatchesUser } from "./api-session-consistency";

const HTTP_STATUS_REQUEST_TIMEOUT = 408;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_SERVER_ERROR_MIN = 500;
const EXCHANGE_RETRY_COOLDOWN_MS = 30_000;

export class AuthExchangeHttpError extends Error {
  public readonly status: number;

  constructor(input: { status: number; message: string }) {
    super(input.message);
    this.name = "AuthExchangeHttpError";
    this.status = input.status;
  }
}

function isTemporaryExchangeFailure(error: unknown): boolean {
  return error instanceof AuthExchangeHttpError
    ? error.status === HTTP_STATUS_REQUEST_TIMEOUT ||
        error.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
        error.status >= HTTP_STATUS_SERVER_ERROR_MIN
    : error instanceof TypeError || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

/** Keep the signed cookie during an API outage; API endpoints still validate the original token. */
export async function exchangeWithSessionRecovery(input: {
  token: { apiToken?: string; appUser?: User; apiRefreshRetryAt?: number };
  hasFreshOAuthAccount: boolean;
  exchange: () => Promise<{ token: string; user: User }>;
  now?: number;
}): Promise<{ token: string; user: User }> {
  const { token } = input;
  const now = input.now ?? Date.now();
  const cached =
    !input.hasFreshOAuthAccount &&
    token.apiToken !== undefined &&
    token.apiToken !== "" &&
    token.appUser !== undefined &&
    apiTokenMatchesUser({ apiToken: token.apiToken, userId: token.appUser.id })
      ? { token: token.apiToken, user: token.appUser }
      : null;
  if (
    cached !== null &&
    token.apiRefreshRetryAt !== undefined &&
    token.apiRefreshRetryAt !== 0 &&
    now < token.apiRefreshRetryAt
  ) {
    return cached;
  }
  try {
    const exchanged = await input.exchange();
    delete token.apiRefreshRetryAt;

    return exchanged;
  } catch (error) {
    if (cached === null || !isTemporaryExchangeFailure(error)) {
      throw error;
    }
    // No retry loop: another caller can retry after this cooldown.
    token.apiRefreshRetryAt = now + EXCHANGE_RETRY_COOLDOWN_MS;

    return cached;
  }
}
