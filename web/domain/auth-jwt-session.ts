import { apiTokenMatchesUser } from "./api-session-consistency";

export function shouldReuseCachedApiSession(input: {
  apiToken: unknown;
  existingUserId: string | null | undefined;
  existingWorkspaceId: string | null | undefined;
  hasFreshOAuthAccount: boolean;
  shouldRefreshApiToken: boolean;
}): boolean {
  const hasApiToken = input.apiToken !== null && input.apiToken !== undefined && input.apiToken !== "";
  const hasExistingWorkspace =
    input.existingWorkspaceId !== null && input.existingWorkspaceId !== undefined && input.existingWorkspaceId !== "";

  return (
    !input.hasFreshOAuthAccount &&
    hasApiToken &&
    hasExistingWorkspace &&
    !input.shouldRefreshApiToken &&
    apiTokenMatchesUser({ apiToken: input.apiToken, userId: input.existingUserId })
  );
}

export function oauthExchangeEmail(input: {
  hasFreshOAuthAccount: boolean;
  tokenEmail: unknown;
  userEmail: unknown;
}): string | null {
  const email = input.hasFreshOAuthAccount ? input.userEmail : input.tokenEmail;

  return typeof email === "string" && email.trim().length > 0 ? email.trim() : null;
}
