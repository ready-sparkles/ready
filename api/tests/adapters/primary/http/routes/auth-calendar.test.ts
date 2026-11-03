import Fastify from "fastify";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { authRoutes } from "../../../../../adapters/primary/http/routes/auth";
import { apiEnv } from "../../../../../composition/env";

const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_BAD_REQUEST = 400;

const oauthLoginErrorPayloadSchema = z.object({
  message: z.string(),
});

const payload = {
  email: "person@example.com",
  displayName: "Person",
  provider: "google",
  providerAccountId: "google-subject",
  googleAddonCalendarCredentials: {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: "2030-01-01T00:00:00.000Z",
    scope: "granted",
    tokenType: "Bearer",
  },
};

void test("Calendar credentials cannot be imported without the exchange secret and a valid add-on binding", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(authRoutes);
  const unauthorized = await app.inject({ method: "POST", url: "/auth/oauth-login", payload });
  assert.equal(unauthorized.statusCode, HTTP_STATUS_UNAUTHORIZED);
  const wrongSecret = await app.inject({
    method: "POST",
    url: "/auth/oauth-login",
    payload,
    headers: { "x-auth-exchange-secret": `${apiEnv.AUTH_EXCHANGE_SECRET}x` },
  });
  assert.equal(wrongSecret.statusCode, HTTP_STATUS_UNAUTHORIZED);
  // Same length, so the comparison reaches timingSafeEqual instead of the length check.
  const lastCharacter = apiEnv.AUTH_EXCHANGE_SECRET.slice(-1);
  const sameLengthWrongSecret = await app.inject({
    method: "POST",
    url: "/auth/oauth-login",
    payload,
    headers: {
      "x-auth-exchange-secret": `${apiEnv.AUTH_EXCHANGE_SECRET.slice(0, -1)}${lastCharacter === "x" ? "y" : "x"}`,
    },
  });
  assert.equal(sameLengthWrongSecret.statusCode, HTTP_STATUS_UNAUTHORIZED);
  const noBinding = await app.inject({
    method: "POST",
    url: "/auth/oauth-login",
    payload,
    headers: { "x-auth-exchange-secret": apiEnv.AUTH_EXCHANGE_SECRET },
  });
  assert.equal(noBinding.statusCode, HTTP_STATUS_BAD_REQUEST);
  const noBindingPayload = oauthLoginErrorPayloadSchema.parse(noBinding.json());
  assert.match(noBindingPayload.message, /verified add-on handoff/);
  const invalidBinding = await app.inject({
    method: "POST",
    url: "/auth/oauth-login",
    payload: { ...payload, googleAddonHandoffToken: "invalid.handoff.signature" },
    headers: { "x-auth-exchange-secret": apiEnv.AUTH_EXCHANGE_SECRET },
  });
  assert.equal(invalidBinding.statusCode, HTTP_STATUS_UNAUTHORIZED);
});
