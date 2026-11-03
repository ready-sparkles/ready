import { type Acquisition, authResponseSchema } from "@readymeet/shared";
import type { z } from "zod";

import { AuthExchangeHttpError } from "../domain/auth-exchange-recovery";

import { serverEnv } from "./server-env";

type AuthResponse = z.infer<typeof authResponseSchema>;

const AUTH_EXCHANGE_TIMEOUT_MS = 10_000;
const AUTH_EXCHANGE_FAILED_MESSAGE = (input: { status: number; text: string }): string =>
  `Auth exchange failed (${input.status}): ${input.text}`;
const SESSION_REFRESH_FAILED_MESSAGE = (input: { status: number; text: string }): string =>
  `Session refresh failed (${input.status}): ${input.text}`;

export async function exchangeOAuthForApiSession(input: {
  acquisition?: Acquisition;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  provider: "google" | "microsoft-entra-id";
  providerAccountId?: string | null;
  googleAddonHandoffToken?: string | null;
}): Promise<AuthResponse> {
  const exchangeUrl = `${serverEnv.INTERNAL_API_BASE_URL}/v1/auth/oauth-login`;

  const response = await fetch(exchangeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-auth-exchange-secret": serverEnv.AUTH_EXCHANGE_SECRET,
    },
    body: JSON.stringify({
      acquisition: input.acquisition,
      email: input.email,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      googleAddonHandoffToken: input.googleAddonHandoffToken ?? undefined,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(AUTH_EXCHANGE_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("ReadyMeet auth exchange failed.", {
      exchangeUrl,
      status: response.status,
      statusText: response.statusText,
      responseText: text,
    });
    throw new AuthExchangeHttpError({
      status: response.status,
      message: AUTH_EXCHANGE_FAILED_MESSAGE({ status: response.status, text }),
    });
  }

  const payload: unknown = await response.json();

  return authResponseSchema.parse(payload);
}

export async function refreshApiSession(apiToken: string): Promise<AuthResponse> {
  const exchangeUrl = `${serverEnv.INTERNAL_API_BASE_URL}/v1/auth/me`;
  const response = await fetch(exchangeUrl, {
    headers: { authorization: `Bearer ${apiToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(AUTH_EXCHANGE_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new AuthExchangeHttpError({
      status: response.status,
      message: SESSION_REFRESH_FAILED_MESSAGE({ status: response.status, text }),
    });
  }

  const payload: unknown = await response.json();

  return authResponseSchema.parse(payload);
}
