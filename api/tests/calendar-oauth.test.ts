import { GOOGLE_CALENDAR_SCOPES } from "@readymeet/shared";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";

import {
  buildCalendarAuthorizationUrl,
  type CalendarTokenSet,
  exchangeCalendarCode,
  getCalendarAccountProfile,
} from "../application/calendar-client";
import {
  getRevocableCalendarTokens,
  restoreCalendarRefreshToken,
  revokeStoredGoogleCalendarCredentials,
} from "../application/calendar-oauth-credentials";
import { apiEnv } from "../composition/env";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const TOKEN_REFRESH_EXPIRES_SECONDS = 3600;

const GOOGLE_OAUTH_INVALID_GRANT_ERROR = "invalid_grant";
const GOOGLE_OAUTH_TEMPORARILY_UNAVAILABLE_ERROR = "temporarily_unavailable";
const NETWORK_UNAVAILABLE_ERROR_MESSAGE = "network unavailable";
const EXPECTED_REFRESH_TOKEN_IN_REQUEST_MESSAGE = "Expected a refresh token";
const EXPECTED_REVOKE_TOKEN_IN_REQUEST_MESSAGE = "Expected a revoke token";
const EXPECTED_URL_SEARCH_PARAMS_BODY_MESSAGE = "Expected fetch body to be URLSearchParams.";

const googleWorkspaceAddonManifestSchema = z.object({
  oauthScopes: z.array(z.string()),
});

function readGoogleWorkspaceAddonManifest() {
  const manifestRaw = readFileSync(
    new URL("../../web/adapters/primary/google-calendar/appsscript.json", import.meta.url),
    "utf8",
  );

  return googleWorkspaceAddonManifestSchema.parse(JSON.parse(manifestRaw));
}

function requireFetchUrlSearchParamsBody(params: { init?: RequestInit }): URLSearchParams {
  const body = params.init?.body;
  if (!(body instanceof URLSearchParams)) {
    throw new Error(EXPECTED_URL_SEARCH_PARAMS_BODY_MESSAGE);
  }

  return body;
}

function configureGoogle(t: { after: (fn: () => void) => void }) {
  const previous = {
    GOOGLE_CALENDAR_CLIENT_ID: apiEnv.GOOGLE_CALENDAR_CLIENT_ID,
    GOOGLE_CALENDAR_CLIENT_SECRET: apiEnv.GOOGLE_CALENDAR_CLIENT_SECRET,
    GOOGLE_CALENDAR_REDIRECT_URI: apiEnv.GOOGLE_CALENDAR_REDIRECT_URI,
  };
  Object.assign(apiEnv, {
    GOOGLE_CALENDAR_CLIENT_ID: "test-client",
    GOOGLE_CALENDAR_CLIENT_SECRET: "test-secret",
    GOOGLE_CALENDAR_REDIRECT_URI: "https://api.example.com/callback",
  });
  t.after(() => Object.assign(apiEnv, previous));
}

const tokens: CalendarTokenSet = {
  provider: "google_calendar",
  accessToken: "new-access",
  refreshToken: "",
  expiresAt: "2030-01-01T00:00:00Z",
  scope: GOOGLE_CALENDAR_SCOPES.join(" "),
  tokenType: "Bearer",
};
const accountProfile = {
  providerAccountId: "google-subject",
  email: "person@example.com",
  displayName: null,
  tenantId: null,
};
const account = {
  id: "connector",
  userId: "ready-user",
  provider: "google_calendar",
  providerAccountId: "google-subject",
  status: "connected",
};

void test("web Calendar scopes stay separate from standalone Marketplace permissions", () => {
  const manifest = readGoogleWorkspaceAddonManifest();
  assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/calendar.events"));
  (
    ["https://www.googleapis.com/auth/contacts.readonly", "https://www.googleapis.com/auth/directory.readonly"] as const
  ).forEach((scope) => {
    assert.ok(GOOGLE_CALENDAR_SCOPES.includes(scope));
    assert.equal(manifest.oauthScopes.includes(scope), false);
  });
});

void test("normal Google connection reuses grants without forcing a consent screen", (t) => {
  configureGoogle(t);
  const url = new URL(buildCalendarAuthorizationUrl({ provider: "google_calendar", state: "signed-state" }));
  assert.equal(url.searchParams.has("prompt"), false);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.equal(url.searchParams.get("scope"), GOOGLE_CALENDAR_SCOPES.join(" "));
});

void test("offline credential recovery explicitly requests consent for the verified account", (t) => {
  configureGoogle(t);
  const url = new URL(
    buildCalendarAuthorizationUrl({
      provider: "google_calendar",
      state: "recovery-state",
      recoverOfflineAccess: true,
      loginHint: "google-subject",
    }),
  );
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("login_hint"), "google-subject");
});

void test("code exchange accepts a missing Google refresh token so the callback can restore it", async (t) => {
  configureGoogle(t);
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async () => Response.json({ access_token: "new-access", scope: tokens.scope });
  const result = await exchangeCalendarCode("google_calendar", "code");
  assert.equal(result.refreshToken, "");
  assert.equal(result.accessToken, "new-access");
  globalThis.fetch = async () => Response.json({ refresh_token: "refresh-only" });
  await assert.rejects(exchangeCalendarCode("google_calendar", "code"), /usable credentials/);
});

void test("validates stored offline credentials and uses the refreshed grant for Calendar access", async (t) => {
  configureGoogle(t);
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const refreshRequests = { count: 0 };
  globalThis.fetch = async (url, init) => {
    refreshRequests.count += 1;
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(init?.method, "POST");
    const body = requireFetchUrlSearchParamsBody({ init });
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "stored-refresh");
    assert.equal(body.get("client_id"), "test-client");

    return Response.json({ access_token: "validated-access", expires_in: TOKEN_REFRESH_EXPIRES_SECONDS });
  };
  const storedScope = "https://www.googleapis.com/auth/calendar.events";
  const restored = await restoreCalendarRefreshToken({
    userId: "ready-user",
    tokens,
    accountProfile,
    accounts: [account],
    readTokens: async () => ({
      ...tokens,
      refreshToken: "stored-refresh",
      accessToken: "old-access",
      scope: storedScope,
    }),
  });
  assert.equal(refreshRequests.count, 1);
  assert.equal(restored.refreshToken, "stored-refresh");
  assert.equal(restored.accessToken, "validated-access");
  assert.equal(restored.scope, storedScope);
  assert.notEqual(restored.expiresAt, tokens.expiresAt);
});

void test("preserves refreshed scope and rotated credentials returned by Google", async (t) => {
  configureGoogle(t);
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async () =>
    Response.json({
      access_token: "validated-access",
      refresh_token: "rotated-refresh",
      scope: "https://www.googleapis.com/auth/calendar.events",
    });
  const restored = await restoreCalendarRefreshToken({
    userId: "ready-user",
    tokens,
    accountProfile,
    accounts: [account],
    readTokens: async () => ({ ...tokens, refreshToken: "stored-refresh", accessToken: "old-access" }),
  });
  assert.equal(restored.refreshToken, "rotated-refresh");
  assert.equal(restored.accessToken, "validated-access");
  assert.equal(restored.scope, "https://www.googleapis.com/auth/calendar.events");
});

void test("revoked stored refresh tokens leave offline access missing for bounded consent recovery", async (t) => {
  configureGoogle(t);
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async () =>
    Response.json(
      { error: GOOGLE_OAUTH_INVALID_GRANT_ERROR, error_description: "Token has been expired or revoked." },
      { status: HTTP_STATUS_BAD_REQUEST },
    );
  const result = await restoreCalendarRefreshToken({
    userId: "ready-user",
    tokens,
    accountProfile,
    accounts: [account],
    readTokens: async () => ({ ...tokens, refreshToken: "revoked-refresh" }),
  });
  assert.strictEqual(result, tokens);
  assert.equal(result.refreshToken, "");
});

void test("transient and malformed refresh responses fail closed instead of requesting consent", async (t) => {
  configureGoogle(t);
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const restore = () =>
    restoreCalendarRefreshToken({
      userId: "ready-user",
      tokens,
      accountProfile,
      accounts: [account],
      readTokens: async () => ({ ...tokens, refreshToken: "stored-refresh" }),
    });
  globalThis.fetch = async () => {
    throw new Error(NETWORK_UNAVAILABLE_ERROR_MESSAGE);
  };
  await assert.rejects(restore(), new RegExp(NETWORK_UNAVAILABLE_ERROR_MESSAGE));
  globalThis.fetch = async () =>
    Response.json({ error: GOOGLE_OAUTH_TEMPORARILY_UNAVAILABLE_ERROR }, { status: HTTP_STATUS_SERVICE_UNAVAILABLE });
  await assert.rejects(restore(), /token request failed/);
  globalThis.fetch = async () => Response.json({ refresh_token: "refresh-without-access" });
  await assert.rejects(restore(), /usable credentials/);
});

void test("does not refresh credentials for mismatched accounts or missing stored tokens", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async () => {
    assert.fail("must not refresh unverified credentials");
  };
  await (
    [
      { userId: "another-user" },
      { provider: "outlook_calendar" },
      { providerAccountId: "other-google-subject" },
      { providerAccountId: null },
      { status: "disconnected" },
    ] as const
  ).reduce(async (previous, mismatch) => {
    await previous;
    const result = await restoreCalendarRefreshToken({
      userId: "ready-user",
      tokens,
      accountProfile,
      accounts: [{ ...account, ...mismatch }],
      readTokens: async () => {
        assert.fail("must not read mismatched credentials");
      },
    });
    assert.equal(result.refreshToken, "");
  }, Promise.resolve());
  await (
    [
      null,
      tokens,
      { ...tokens, provider: "outlook_calendar" as const, refreshToken: "other-provider-refresh" },
    ] as const
  ).reduce(async (previous, stored) => {
    await previous;
    const result = await restoreCalendarRefreshToken({
      userId: "ready-user",
      tokens,
      accountProfile,
      accounts: [account],
      readTokens: async () => stored,
    });
    assert.strictEqual(result, tokens);
  }, Promise.resolve());
});

void test("keeps a newly issued refresh token without reading stored credentials", async () => {
  const result = await restoreCalendarRefreshToken({
    userId: "ready-user",
    tokens: { ...tokens, refreshToken: "new-refresh" },
    accountProfile,
    accounts: [account],
    readTokens: async () => {
      assert.fail("must not replace new credentials");
    },
  });
  assert.equal(result.refreshToken, "new-refresh");
});

void test("manual Connect validates pending offline credentials and their actual Google identity before reuse", async (t) => {
  configureGoogle(t);
  const pending = {
    kind: "google-addon-calendar-pending-v1" as const,
    userId: "ready-user",
    googleSubject: "google-subject",
    tokens: { ...tokens, refreshToken: "pending-refresh" },
  };
  const identity: { subject: string; isPreserved: boolean } = { subject: "google-subject", isPreserved: false };
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url === "https://oauth2.googleapis.com/token"
      ? Response.json({ access_token: "validated-access", refresh_token: "rotated-refresh" })
      : Response.json({ id: identity.subject, email: "person@example.com" }),
  );
  const restore = () =>
    restoreCalendarRefreshToken({
      userId: "ready-user",
      tokens,
      accountProfile,
      accounts: [{ ...account, status: "error" }],
      readTokens: async () => null,
      readPendingTokens: async () => pending,
      preservePending: async (value) => {
        identity.isPreserved = true;
        assert.equal(value.tokens.refreshToken, "rotated-refresh");
      },
    });
  assert.equal((await restore()).refreshToken, "rotated-refresh");
  assert.equal(identity.isPreserved, true);
  identity.subject = "another-google-account";
  await assert.rejects(restore(), /does not match/);
  await ([{ userId: "other-user" }, { googleSubject: "other-subject" }] as const).reduce(async (previous, mismatch) => {
    await previous;
    const result = await restoreCalendarRefreshToken({
      userId: "ready-user",
      tokens,
      accountProfile,
      accounts: [{ ...account, status: "error" }],
      readTokens: async () => null,
      readPendingTokens: async () => ({ ...pending, ...mismatch }),
    });
    assert.strictEqual(result, tokens);
  }, Promise.resolve());
});

void test("unmarked error credentials are not promoted and revoked pending grants use bounded recovery", async (t) => {
  configureGoogle(t);
  const input = { userId: "ready-user", tokens, accountProfile, accounts: [{ ...account, status: "error" }] };
  assert.strictEqual(
    await restoreCalendarRefreshToken({ ...input, readTokens: async () => ({ ...tokens, refreshToken: "unmarked" }) }),
    tokens,
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: GOOGLE_OAUTH_INVALID_GRANT_ERROR }, { status: HTTP_STATUS_BAD_REQUEST }),
  );
  assert.strictEqual(
    await restoreCalendarRefreshToken({
      ...input,
      readTokens: async () => null,
      readPendingTokens: async () => ({
        kind: "google-addon-calendar-pending-v1",
        userId: "ready-user",
        googleSubject: "google-subject",
        tokens: { ...tokens, refreshToken: "revoked" },
      }),
    }),
    tokens,
  );
});

void test("a fresh pending grant recovers a connected account with revoked active credentials", async (t) => {
  configureGoogle(t);
  const pending = {
    kind: "google-addon-calendar-pending-v1" as const,
    userId: "ready-user",
    googleSubject: "google-subject",
    tokens: { ...tokens, refreshToken: "fresh-pending" },
  };
  const refreshed: { tokens: string[] } = { tokens: [] };
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url !== "https://oauth2.googleapis.com/token") {
      return Response.json({ id: "google-subject", email: "person@example.com" });
    }
    const refreshToken = requireFetchUrlSearchParamsBody({ init }).get("refresh_token");
    if (refreshToken === null) {
      throw new Error(EXPECTED_REFRESH_TOKEN_IN_REQUEST_MESSAGE);
    }
    refreshed.tokens = [...refreshed.tokens, refreshToken];

    return refreshToken === "revoked-active"
      ? Response.json({ error: GOOGLE_OAUTH_INVALID_GRANT_ERROR }, { status: HTTP_STATUS_BAD_REQUEST })
      : Response.json({ access_token: "verified-pending-access" });
  });
  const restored = await restoreCalendarRefreshToken({
    userId: "ready-user",
    tokens,
    accountProfile,
    accounts: [account],
    readTokens: async () => ({ ...tokens, refreshToken: "revoked-active" }),
    readPendingTokens: async () => pending,
  });
  assert.equal(restored.refreshToken, "fresh-pending");
  assert.equal(restored.accessToken, "verified-pending-access");
  assert.deepEqual(refreshed.tokens, ["revoked-active", "fresh-pending"]);
});

void test("transient active refresh failure does not trigger pending fallback or consent", async (t) => {
  configureGoogle(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(NETWORK_UNAVAILABLE_ERROR_MESSAGE);
  });
  await assert.rejects(
    restoreCalendarRefreshToken({
      userId: "ready-user",
      tokens,
      accountProfile,
      accounts: [account],
      readTokens: async () => ({ ...tokens, refreshToken: "active-refresh" }),
      readPendingTokens: async () => assert.fail("provider outage must not choose another grant"),
    }),
    new RegExp(NETWORK_UNAVAILABLE_ERROR_MESSAGE),
  );
});

void test("deletion revokes a verified pending grant before an old active grant", async (t) => {
  configureGoogle(t);
  const revoked: { tokens: string[] } = { tokens: [] };
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    // Calendar requests may pass a URL object; compare by its string form.
    const url = String(input);
    if (url.includes("/revoke")) {
      const token = requireFetchUrlSearchParamsBody({ init }).get("token");
      if (token === null) {
        throw new Error(EXPECTED_REVOKE_TOKEN_IN_REQUEST_MESSAGE);
      }
      revoked.tokens = [...revoked.tokens, token];

      return new Response(null, { status: HTTP_STATUS_OK });
    }

    return url === "https://oauth2.googleapis.com/token"
      ? Response.json({ access_token: "refreshed" })
      : Response.json({ id: "google-subject", email: "person@example.com" });
  });
  const result = await revokeStoredGoogleCalendarCredentials({
    userId: "ready-user",
    googleSubject: "google-subject",
    active: { ...tokens, refreshToken: "old-active" },
    pending: {
      kind: "google-addon-calendar-pending-v1",
      userId: "ready-user",
      googleSubject: "google-subject",
      tokens: { ...tokens, refreshToken: "fresh-pending" },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(revoked.tokens, ["fresh-pending"]);
});

void test("deletion verifies pending token identity before permitting Google revocation", async (t) => {
  configureGoogle(t);
  const pending = {
    kind: "google-addon-calendar-pending-v1" as const,
    userId: "ready-user",
    googleSubject: "google-subject",
    tokens: { ...tokens, refreshToken: "pending-refresh" },
  };
  const identity: { subject: string } = { subject: "google-subject" };
  const requests = { count: 0 };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.count += 1;

    return url === "https://oauth2.googleapis.com/token"
      ? Response.json({ access_token: "refreshed" })
      : Response.json({ id: identity.subject, email: "person@example.com" });
  });
  assert.equal(await getRevocableCalendarTokens(pending, "another-user", "google-subject"), null);
  assert.equal(await getRevocableCalendarTokens(pending, "ready-user", "another-subject"), null);
  assert.equal(requests.count, 0);
  assert.equal(
    (await getRevocableCalendarTokens(pending, "ready-user", "google-subject"))?.refreshToken,
    "pending-refresh",
  );
  identity.subject = "another-subject";
  await assert.rejects(getRevocableCalendarTokens(pending, "ready-user", "google-subject"), /does not match/);
  assert.strictEqual(await getRevocableCalendarTokens(tokens, "ready-user", "google-subject"), tokens);
});

void test("OAuth callback identity lookup fails closed instead of borrowing the Ready email", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async () => Response.json({}, { status: HTTP_STATUS_UNAUTHORIZED });
  await assert.rejects(getCalendarAccountProfile(tokens, "ready@example.com", true));
  globalThis.fetch = async () => Response.json({ email: "person@example.com" });
  await assert.rejects(getCalendarAccountProfile(tokens, "ready@example.com", true), /identity is missing/);
  globalThis.fetch = async () => Response.json({ id: "google-subject", email: "person@example.com" });
  assert.equal(
    (await getCalendarAccountProfile(tokens, "ready@example.com", true)).providerAccountId,
    "google-subject",
  );
});
