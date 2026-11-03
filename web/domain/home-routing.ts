type HomeSession =
  | {
      apiToken?: string | null;
      appUser?: unknown;
      authError?: unknown;
    }
  | null
  | undefined;

export function shouldRedirectHomeToWorkspace(input: {
  session: HomeSession;
  /** @external existing home routing option */
  showPublicHome?: boolean;
}): boolean {
  return (
    !(input.showPublicHome ?? false) &&
    typeof input.session?.apiToken === "string" &&
    input.session.apiToken.trim().length > 0 &&
    input.session.appUser !== undefined &&
    input.session.appUser !== null &&
    (input.session.authError === undefined || input.session.authError === null)
  );
}
