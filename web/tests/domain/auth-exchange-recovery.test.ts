import { userSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { authConfig } from "../../auth";
import { AuthExchangeHttpError, exchangeWithSessionRecovery } from "../../domain/auth-exchange-recovery";

const MESSAGE_FETCH_FAILED = "fetch failed";
const MESSAGE_RATE_LIMITED = "rate limited";
const MESSAGE_REJECTED = "rejected";
const MESSAGE_UNAVAILABLE = "unavailable";

const TEST_VALUE_1000 = 1000;
const TEST_VALUE_1001 = 1001;
const TEST_VALUE_31000 = 31000;
const TEST_VALUE_400 = 400;
const TEST_VALUE_401 = 401;
const TEST_VALUE_403 = 403;
const TEST_VALUE_404 = 404;
const TEST_VALUE_429 = 429;
const TEST_VALUE_503 = 503;

const user = userSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  email: "test@example.com",
  displayName: "Test",
  avatarUrl: null,
  workspaceId: "22222222-2222-4222-8222-222222222222",
  createdAt: "2026-01-01T00:00:00Z",
});
const apiToken = `header.${Buffer.from(JSON.stringify({ sub: user.id })).toString("base64url")}.signature`;

[
  new TypeError(MESSAGE_FETCH_FAILED),
  new AuthExchangeHttpError({ status: TEST_VALUE_503, message: MESSAGE_UNAVAILABLE }),
  new AuthExchangeHttpError({ status: TEST_VALUE_429, message: MESSAGE_RATE_LIMITED }),
].forEach((failure) => {
  void test(`temporary exchange failure retains the same session with a cooldown (${failure.message})`, async () => {
    const token = { apiToken, appUser: user, apiRefreshRetryAt: undefined as number | undefined };
    const calls = { count: 0 };
    const exchange = async () => {
      calls.count += 1;
      throw failure;
    };
    assert.deepEqual(
      await exchangeWithSessionRecovery({ token, hasFreshOAuthAccount: false, exchange, now: TEST_VALUE_1000 }),
      {
        token: apiToken,
        user,
      },
    );
    await exchangeWithSessionRecovery({ token, hasFreshOAuthAccount: false, exchange, now: TEST_VALUE_1001 });
    assert.equal(calls.count, 1);
    const fresh = { token: `${apiToken}-new`, user };
    assert.equal(
      await exchangeWithSessionRecovery({
        token,
        hasFreshOAuthAccount: false,
        exchange: async () => fresh,
        now: TEST_VALUE_31000,
      }),
      fresh,
    );
    assert.equal(token.apiRefreshRetryAt, undefined);
  });
});

void test("new sign-ins, account switches, invalid cached identities, and permanent rejections fail closed", async () => {
  const temporary = new AuthExchangeHttpError({ status: TEST_VALUE_503, message: MESSAGE_UNAVAILABLE });
  await [
    { token: {}, hasFreshOAuthAccount: false },
    { token: { apiToken, appUser: user }, hasFreshOAuthAccount: true },
    { token: { apiToken: "invalid", appUser: user }, hasFreshOAuthAccount: false },
  ].reduce(async (previous, input) => {
    await previous;
    await assert.rejects(
      exchangeWithSessionRecovery({
        ...input,
        exchange: async () => {
          throw temporary;
        },
      }),
      (error) => error === temporary,
    );
  }, Promise.resolve());
  await [TEST_VALUE_400, TEST_VALUE_401, TEST_VALUE_403, TEST_VALUE_404].reduce(async (previous, status) => {
    await previous;
    const error = new AuthExchangeHttpError({ status, message: MESSAGE_REJECTED });
    await assert.rejects(
      exchangeWithSessionRecovery({
        token: { apiToken, appUser: user },
        hasFreshOAuthAccount: false,
        exchange: async () => {
          throw error;
        },
      }),
      (received) => received === error,
    );
  }, Promise.resolve());
});

void test("the real JWT refresh callback preserves OAuth and dev sessions during an API outage", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const exchanges = { count: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    exchanges.count += 1;

    return new Response("unavailable", { status: TEST_VALUE_503 });
  });
  await (["google", "microsoft-entra-id", "dev-login"] as const).reduce(async (previous, provider) => {
    await previous;
    const token = {
      apiToken,
      appUser: user,
      email: user.email,
      apiAuthProvider: provider,
      oauthProvider: provider === "dev-login" ? undefined : provider,
    };
    const args = {
      token,
      user: { id: user.id },
      account: null,
      trigger: "update" as const,
      session: { /** @external NextAuth session wire field */ refreshApiToken: true },
    };
    const refreshed = await authConfig.callbacks.jwt(args);
    assert.deepEqual(refreshed, token, "JWT callback must not throw and cause NextAuth to delete the cookie");
    assert.equal(Reflect.get(refreshed, "apiToken"), apiToken);
    const before = exchanges.count;
    await authConfig.callbacks.jwt(args);
    assert.equal(exchanges.count, before, "repeat refreshes do not hammer the API during cooldown");
  }, Promise.resolve());
});
