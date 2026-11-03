import { oauthLoginRequestSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { exchangeOAuthForApiSession } from "../../application/server-auth-exchange";

const REQUEST_CAPTURED_MESSAGE = "request captured";
const REQUEST_CAPTURED = new Error(REQUEST_CAPTURED_MESSAGE);
const OAUTH_HANDOFF_TOKEN = "header.payload.signature";
const OAUTH_PROVIDERS = ["google", "microsoft-entra-id"] as const;
const OAUTH_HANDOFF_VALUES = [null, undefined, OAUTH_HANDOFF_TOKEN] as const;

function requestBodyText(body: RequestInit["body"]): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body === null || body === undefined) {
    return "";
  }

  return JSON.stringify(body);
}

type CapturedOAuthBody = ReturnType<typeof oauthLoginRequestSchema.parse>;

function readCapturedBody(state: { parsed?: CapturedOAuthBody }): CapturedOAuthBody | undefined {
  return state.parsed;
}

void test("OAuth exchange sends API-compatible requests with and without an add-on handoff", async (t) => {
  const bodyState: { parsed?: CapturedOAuthBody } = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const parsed = oauthLoginRequestSchema.safeParse(JSON.parse(requestBodyText(init.body)));
    assert.equal(parsed.success, true);
    assert.ok(parsed.success);
    bodyState.parsed = parsed.data;
    throw REQUEST_CAPTURED;
  });

  const cases = OAUTH_PROVIDERS.flatMap((provider) => OAUTH_HANDOFF_VALUES.map((handoff) => ({ provider, handoff })));
  // The fetch mock captures into shared state, so cases must run one at a time.
  await cases.reduce(async (previous, { provider, handoff }) => {
    await previous;
    delete bodyState.parsed;
    await assert.rejects(
      exchangeOAuthForApiSession({
        email: "person@example.com",
        displayName: "Test Person",
        avatarUrl: null,
        providerAccountId: null,
        provider,
        googleAddonHandoffToken: handoff,
      }),
      (error) => error === REQUEST_CAPTURED,
    );

    const parsedBody: CapturedOAuthBody | undefined = readCapturedBody(bodyState);
    assert.ok(parsedBody !== undefined);
    assert.equal(oauthLoginRequestSchema.safeParse(parsedBody).success, true);
    if (handoff === null || handoff === undefined) {
      assert.equal(Object.hasOwn(parsedBody, "googleAddonHandoffToken"), false);
    } else {
      assert.equal(parsedBody.googleAddonHandoffToken, handoff);
    }
  }, Promise.resolve());
});

void test("add-on sign-in never forwards integration credentials, including legacy caller fields", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const parsed = oauthLoginRequestSchema.parse(JSON.parse(requestBodyText(init.body)));
    assert.equal(parsed.googleAddonCalendarCredentials, undefined);
    assert.equal(parsed.googleAddonHandoffToken, OAUTH_HANDOFF_TOKEN);
    const headers = init.headers;
    const headerRecord =
      headers instanceof Headers
        ? Object.fromEntries(headers.entries())
        : Array.isArray(headers)
          ? Object.fromEntries(headers)
          : (headers ?? {});
    assert.ok(typeof headerRecord["x-auth-exchange-secret"] === "string");
    throw REQUEST_CAPTURED;
  });
  const legacyInput = {
    email: "person@example.com",
    displayName: "Person",
    provider: "google" as const,
    providerAccountId: "subject",
    googleAddonHandoffToken: OAUTH_HANDOFF_TOKEN,
    googleAddonCalendarCredentials: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scope: "granted",
      tokenType: "Bearer",
    },
  };
  await assert.rejects(exchangeOAuthForApiSession(legacyInput), (error) => error === REQUEST_CAPTURED);
});
