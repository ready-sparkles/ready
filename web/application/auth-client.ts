import { z } from "zod";

export type OAuthSignInProvider = "google" | "microsoft-entra-id";

export type AvailableAuthProviders = {
  /** @external auth provider availability wire field */
  google: boolean;
  /** @external auth provider availability wire field */
  microsoft: boolean;
};

type OAuthSignInOptions = {
  /** @external OAuth sign-in option field */
  forceAccountSelection?: boolean;
  googleAddonHandoffToken?: string | null;
  loginHint?: string | null;
};

const authProviderEntrySchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
  })
  .optional();

const authProvidersResponseSchema = z.record(z.string(), authProviderEntrySchema);

const authRedirectResponseSchema = z.object({
  url: z.string().optional(),
});

const csrfResponseSchema = z.object({
  csrfToken: z.string().optional(),
});

const authErrorPayloadSchema = z.object({
  message: z.string().optional(),
});

const AUTHENTICATION_REQUEST_FAILED_MESSAGE = "Authentication request failed";
const COULD_NOT_START_SIGN_IN_MESSAGE = "Could not start sign-in. Refresh the page and try again.";

async function readAuthJson<T>(input: {
  url: string;
  init?: RequestInit;
  schema: z.ZodType<T>;
}): Promise<z.SafeParseReturnType<unknown, T>> {
  const response = await fetch(input.url, {
    ...input.init,
    cache: "no-store",
  });

  if (!response.ok) {
    const parsed = await (async () => {
      try {
        return authErrorPayloadSchema.safeParse(await response.json());
      } catch (error) {
        return authErrorPayloadSchema.safeParse(error instanceof Error ? null : null);
      }
    })();
    const message =
      parsed.success && parsed.data.message !== undefined && parsed.data.message !== ""
        ? parsed.data.message
        : AUTHENTICATION_REQUEST_FAILED_MESSAGE;
    throw new Error(message);
  }

  try {
    return input.schema.safeParse(await response.json());
  } catch (error) {
    return input.schema.safeParse(error instanceof Error ? null : null);
  }
}

export async function getAvailableAuthProviders(): Promise<AvailableAuthProviders> {
  const providers = await readAuthJson({ url: "/api/auth/providers", schema: authProvidersResponseSchema });

  return {
    google: providers.success && providers.data.google !== undefined,
    microsoft: providers.success && providers.data["microsoft-entra-id"] !== undefined,
  };
}

function getOAuthSignInHrefNamed(input: {
  provider: OAuthSignInProvider;
  callbackUrl: string;
  options?: OAuthSignInOptions;
}): string {
  const options = input.options ?? {};
  const params = new URLSearchParams({ callbackUrl: input.callbackUrl });
  if (input.provider === "google" && options.forceAccountSelection === true) {
    params.set("prompt", "select_account");
  }
  if (input.provider === "google" && typeof options.loginHint === "string" && options.loginHint !== "") {
    params.set("loginHint", options.loginHint);
  }
  if (
    input.provider === "google" &&
    typeof options.googleAddonHandoffToken === "string" &&
    options.googleAddonHandoffToken !== ""
  ) {
    params.set("googleAddonHandoffToken", options.googleAddonHandoffToken);
  }

  return `/api/auth/start/${input.provider}?${params.toString()}`;
}

export function getOAuthSignInHref(
  ...args: [provider: OAuthSignInProvider, callbackUrl: string, options?: OAuthSignInOptions]
): string {
  const [provider, callbackUrl, options] = args;

  return getOAuthSignInHrefNamed({ provider, callbackUrl, options });
}

async function getCsrfToken(): Promise<string> {
  const parsed = await readAuthJson({ url: "/api/auth/csrf", schema: csrfResponseSchema });

  if (!parsed.success || parsed.data.csrfToken === undefined || parsed.data.csrfToken === "") {
    throw new Error(COULD_NOT_START_SIGN_IN_MESSAGE);
  }

  return parsed.data.csrfToken;
}

async function startOAuthSignInNamed(input: { provider: OAuthSignInProvider; callbackUrl: string }): Promise<void> {
  const csrfToken = await getCsrfToken();
  const parsed = await readAuthJson({
    url: `/api/auth/signin/${input.provider}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Auth-Return-Redirect": "1",
      },
      body: new URLSearchParams({
        callbackUrl: input.callbackUrl,
        csrfToken,
      }),
    },
    schema: authRedirectResponseSchema,
  });

  if (!parsed.success || parsed.data.url === undefined || parsed.data.url === "") {
    throw new Error(COULD_NOT_START_SIGN_IN_MESSAGE);
  }

  window.location.href = parsed.data.url;
}

export async function startOAuthSignIn(...args: [provider: OAuthSignInProvider, callbackUrl: string]): Promise<void> {
  const [provider, callbackUrl] = args;

  return startOAuthSignInNamed({ provider, callbackUrl });
}
