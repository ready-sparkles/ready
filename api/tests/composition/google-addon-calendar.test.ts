import { GOOGLE_CALENDAR_SCOPES } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import type { PendingGoogleAddonCalendarCredentials } from "../../application/calendar-oauth-credentials";
import {
  importGoogleAddonCalendarSafely,
  validateGoogleAddonCalendarGrant,
} from "../../application/google-addon-calendar";
import { apiEnv } from "../../composition/env";

const HTTP_STATUS_BAD_REQUEST = 400;
const EXPECTED_VALIDATE_GRANT_FETCH_CALL_COUNT = 2;
const EXPECTED_TRANSIENT_RETRY_REFRESH_REQUEST_COUNT = 2;
const FIRST_REFRESH_REQUEST_SEQUENCE = 1;

const GOOGLE_OAUTH_INVALID_GRANT_ERROR = "invalid_grant";
const UNEXPECTED_NETWORK_REQUEST_MESSAGE = "unexpected network request";
const PROVIDER_RESPONSE_SENSITIVE_DETAILS_MESSAGE = "provider response containing sensitive details";
const IDENTITY_ENDPOINT_UNAVAILABLE_MESSAGE = "identity endpoint unavailable";
const USERINFO_UNAVAILABLE_MESSAGE = "userinfo unavailable";
const SECRET_TOKEN_STORAGE_ERROR_MESSAGE = "secret token";
const TEMPORARY_REFRESH_FAILURE_MESSAGE = "temporary refresh failure";
const TEMPORARY_CALENDAR_FAILURE_MESSAGE = "temporary Calendar failure";
const EXPECTED_URL_SEARCH_PARAMS_BODY_MESSAGE = "Expected fetch body to be URLSearchParams.";
const BEARER_REFRESHED_ACCESS_AUTHORIZATION = "Bearer refreshed-access";

const addonCalendarWarningSchema = z.object({
  stage: z.string(),
  errorType: z.string(),
});

type AddonCalendarWarning = z.infer<typeof addonCalendarWarningSchema>;

type OptionalImportFailureMode = "refresh" | "userinfo" | "calendar-access" | "sync-subscription" | "sync-enqueue";

const OPTIONAL_IMPORT_FAILURE_MODES: OptionalImportFailureMode[] = [
  "refresh",
  "userinfo",
  "calendar-access",
  "sync-subscription",
  "sync-enqueue",
];

const OPTIONAL_IMPORT_VALIDATION_FAILURE_MODES: OptionalImportFailureMode[] = ["refresh", "userinfo"];

const credentials = {
  accessToken: "signin-access",
  refreshToken: "offline-refresh",
  expiresAt: "2030-01-01T00:00:00.000Z",
  scope: GOOGLE_CALENDAR_SCOPES.join(" "),
  tokenType: "Bearer",
};

function requireFetchUrlSearchParamsBody(params: { init?: RequestInit }): URLSearchParams {
  const body = params.init?.body;
  if (!(body instanceof URLSearchParams)) {
    throw new Error(EXPECTED_URL_SEARCH_PARAMS_BODY_MESSAGE);
  }

  return body;
}

function parseAddonCalendarWarning(params: { value: unknown }): AddonCalendarWarning {
  return addonCalendarWarningSchema.parse(params.value);
}

function configureGoogle(t: { after: (fn: () => void) => void }) {
  const original = {
    GOOGLE_CALENDAR_CLIENT_ID: apiEnv.GOOGLE_CALENDAR_CLIENT_ID,
    GOOGLE_CALENDAR_CLIENT_SECRET: apiEnv.GOOGLE_CALENDAR_CLIENT_SECRET,
    GOOGLE_CALENDAR_REDIRECT_URI: apiEnv.GOOGLE_CALENDAR_REDIRECT_URI,
  };
  Object.assign(apiEnv, {
    GOOGLE_CALENDAR_CLIENT_ID: "test-client",
    GOOGLE_CALENDAR_CLIENT_SECRET: "test-secret",
    GOOGLE_CALENDAR_REDIRECT_URI: "https://api.example.com/callback",
  });
  t.after(() => Object.assign(apiEnv, original));
}

void test("first add-on sign-in validates offline access and the actual Google identity", async (t) => {
  configureGoogle(t);
  const fetchCallLog = { urls: [] as string[] };
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    fetchCallLog.urls = [...fetchCallLog.urls, url];
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(requireFetchUrlSearchParamsBody({ init }).get("refresh_token"), "offline-refresh");

      return Response.json({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        scope: credentials.scope,
      });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), BEARER_REFRESHED_ACCESS_AUTHORIZATION);

    return Response.json({ id: "google-subject", email: "person@example.com" });
  });
  const grant = await validateGoogleAddonCalendarGrant({ credentials, googleSubject: "google-subject" });
  assert.equal(grant?.tokens.refreshToken, "rotated-refresh");
  assert.equal(grant.tokens.accessToken, "refreshed-access");
  assert.equal(grant.accountProfile.providerAccountId, "google-subject");
  assert.equal(fetchCallLog.urls.length, EXPECTED_VALIDATE_GRANT_FETCH_CALL_COUNT);
});

void test("missing offline access never creates a connected account", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(UNEXPECTED_NETWORK_REQUEST_MESSAGE);
  });
  assert.equal(
    await validateGoogleAddonCalendarGrant({
      credentials: { ...credentials, refreshToken: "" },
      googleSubject: "subject",
    }),
    null,
  );
});

void test("partial and identity-only grants never auto-connect Calendar", async (t) => {
  configureGoogle(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ access_token: "refreshed", scope: "openid email profile" }),
  );
  assert.equal(await validateGoogleAddonCalendarGrant({ credentials, googleSubject: "subject" }), null);
});

void test("revoked offline grants fail even when the sign-in access token is valid", async (t) => {
  configureGoogle(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: GOOGLE_OAUTH_INVALID_GRANT_ERROR }, { status: HTTP_STATUS_BAD_REQUEST }),
  );
  await assert.rejects(
    validateGoogleAddonCalendarGrant({ credentials, googleSubject: "subject" }),
    /expired or revoked/,
  );
});

void test("offline credentials belonging to another Google account are rejected", async (t) => {
  configureGoogle(t);
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url === "https://oauth2.googleapis.com/token"
      ? Response.json({ access_token: "refreshed", scope: credentials.scope })
      : Response.json({ id: "wrong-subject", email: "someone@example.com" }),
  );
  await assert.rejects(
    validateGoogleAddonCalendarGrant({ credentials, googleSubject: "expected-subject" }),
    /does not match/,
  );
});

void test("optional Calendar import does not reject sign-in when refresh, identity, or connection fails", async (t) => {
  configureGoogle(t);
  const { importGoogleAddonCalendarSafely } = await import("../../application/google-addon-calendar");
  await OPTIONAL_IMPORT_FAILURE_MODES.reduce<Promise<void>>(async (previous, failure) => {
    await previous;
    await t.test(failure, async (t) => {
      const warningLog = { items: [] as AddonCalendarWarning[] };
      const connection = { isCalled: false };
      t.mock.method(globalThis, "fetch", async (url: string) => {
        if (url === "https://oauth2.googleapis.com/token") {
          if (failure === "refresh") {
            throw new Error(PROVIDER_RESPONSE_SENSITIVE_DETAILS_MESSAGE);
          }

          return Response.json({ access_token: "refreshed", scope: credentials.scope });
        }
        if (failure === "userinfo") {
          throw new Error(IDENTITY_ENDPOINT_UNAVAILABLE_MESSAGE);
        }

        return Response.json({ id: "subject", email: "person@example.com" });
      });
      const isConnected = await importGoogleAddonCalendarSafely({
        credentials,
        googleSubject: "subject",
        connect: async () => {
          connection.isCalled = true;
          throw new Error(failure);
        },
        warn: (details) => {
          warningLog.items = [...warningLog.items, parseAddonCalendarWarning({ value: details })];
        },
      });
      assert.equal(isConnected, false);
      assert.equal(connection.isCalled, !OPTIONAL_IMPORT_VALIDATION_FAILURE_MODES.includes(failure));
      assert.deepEqual(warningLog.items, [
        {
          stage: OPTIONAL_IMPORT_VALIDATION_FAILURE_MODES.includes(failure) ? "validation" : "connection",
          errorType: "Error",
        },
      ]);
      assert.equal(JSON.stringify(warningLog.items).includes("sensitive"), false);
    });
  }, Promise.resolve());
});

void test("optional Calendar import only reports connected after validation and persistence succeed", async (t) => {
  configureGoogle(t);
  const { importGoogleAddonCalendarSafely } = await import("../../application/google-addon-calendar");
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url === "https://oauth2.googleapis.com/token"
      ? Response.json({ access_token: "refreshed", scope: credentials.scope })
      : Response.json({ id: "subject", email: "person@example.com" }),
  );
  const connection = { isCalled: false };
  assert.equal(
    await importGoogleAddonCalendarSafely({
      credentials,
      googleSubject: "subject",
      connect: async (grant) => {
        connection.isCalled = true;
        assert.equal(grant.tokens.accessToken, "refreshed");
      },
      warn: () => assert.fail("unexpected warning"),
    }),
    true,
  );
  assert.equal(connection.isCalled, true);
});

void test("a transient provider failure preserves fresh and rotated credentials for the next add-on sign-in", async (t) => {
  configureGoogle(t);
  const pendingState: {
    stored: PendingGoogleAddonCalendarCredentials | null;
    isUnavailable: boolean;
    refreshRequests: number;
  } = { stored: null, isUnavailable: true, refreshRequests: 0 };
  const pending = {
    userId: "ready-user",
    stage: async (value: PendingGoogleAddonCalendarCredentials) => {
      pendingState.stored = value;
    },
    read: async () => pendingState.stored,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") {
      pendingState.refreshRequests += 1;
      // The original grant is durable before any Google validation call.
      assert.ok(pendingState.stored);
      assert.equal(
        requireFetchUrlSearchParamsBody({ init }).get("refresh_token"),
        pendingState.refreshRequests === FIRST_REFRESH_REQUEST_SEQUENCE ? "offline-refresh" : "rotated-refresh",
      );

      return Response.json({ access_token: "refreshed", refresh_token: "rotated-refresh", scope: credentials.scope });
    }
    if (pendingState.isUnavailable) {
      throw new Error(USERINFO_UNAVAILABLE_MESSAGE);
    }

    return Response.json({ id: "subject", email: "person@example.com" });
  });
  assert.equal(
    await importGoogleAddonCalendarSafely({
      credentials,
      googleSubject: "subject",
      pending,
      connect: async () => assert.fail("must not connect before identity validation"),
      warn: () => {},
    }),
    false,
  );
  pendingState.isUnavailable = false;
  assert.equal(
    await importGoogleAddonCalendarSafely({
      credentials: { ...credentials, refreshToken: "" },
      googleSubject: "subject",
      pending,
      connect: async (grant) => assert.equal(grant.tokens.refreshToken, "rotated-refresh"),
      warn: () => assert.fail("unexpected warning"),
    }),
    true,
  );
  assert.equal(pendingState.refreshRequests, EXPECTED_TRANSIENT_RETRY_REFRESH_REQUEST_COUNT);
});

void test("storage failures remain optional and never expose provider credentials in warnings", async () => {
  const warningLog = { items: [] as AddonCalendarWarning[] };
  assert.equal(
    await importGoogleAddonCalendarSafely({
      credentials,
      googleSubject: "subject",
      pending: {
        userId: "ready-user",
        stage: async () => {
          throw new Error(SECRET_TOKEN_STORAGE_ERROR_MESSAGE);
        },
        read: async () => null,
      },
      connect: async () => assert.fail("unexpected connection"),
      warn: (details) => {
        warningLog.items = [...warningLog.items, parseAddonCalendarWarning({ value: details })];
      },
    }),
    false,
  );
  assert.deepEqual(warningLog.items, [{ stage: "storage", errorType: "Error" }]);
});

void test("fresh offline credentials survive a failed first refresh or Calendar connection", async (t) => {
  configureGoogle(t);
  await ["refresh", "connection"].reduce<Promise<void>>(async (previous, failure) => {
    await previous;
    const pendingState: { stored: PendingGoogleAddonCalendarCredentials | null } = { stored: null };
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (failure === "refresh") {
        throw new Error(TEMPORARY_REFRESH_FAILURE_MESSAGE);
      }

      return url === "https://oauth2.googleapis.com/token"
        ? Response.json({ access_token: "refreshed", scope: credentials.scope })
        : Response.json({ id: "subject", email: "person@example.com" });
    });
    assert.equal(
      await importGoogleAddonCalendarSafely({
        credentials,
        googleSubject: "subject",
        pending: {
          userId: "ready-user",
          stage: async (value) => {
            pendingState.stored = value;
          },
          read: async () => pendingState.stored,
        },
        connect: async () => {
          throw new Error(TEMPORARY_CALENDAR_FAILURE_MESSAGE);
        },
        warn: () => {},
      }),
      false,
    );
    assert.ok(pendingState.stored);
    assert.equal(pendingState.stored.tokens.refreshToken, "offline-refresh");
    assert.equal(pendingState.stored.googleSubject, "subject");
  }, Promise.resolve());
});

void test("incomplete grants are not staged and another user or subject cannot recover a pending grant", async (t) => {
  const staged: PendingGoogleAddonCalendarCredentials = {
    kind: "google-addon-calendar-pending-v1",
    userId: "ready-user",
    googleSubject: "subject",
    tokens: { ...credentials, provider: "google_calendar" },
  };
  await [{ userId: "other-user" }, { googleSubject: "other-subject" }].reduce<Promise<void>>(
    async (previous, mismatch) => {
      await previous;
      assert.equal(
        await importGoogleAddonCalendarSafely({
          credentials: { ...credentials, refreshToken: "" },
          googleSubject: "subject",
          pending: {
            userId: "ready-user",
            stage: async () => assert.fail("unexpected stage"),
            read: async () => ({ ...staged, ...mismatch }),
          },
          connect: async () => assert.fail("unexpected connection"),
          warn: () => assert.fail("unexpected warning"),
        }),
        false,
      );
    },
    Promise.resolve(),
  );
  configureGoogle(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ access_token: "refreshed", scope: "openid email profile" }),
  );
  assert.equal(
    await importGoogleAddonCalendarSafely({
      credentials: { ...credentials, scope: "openid email profile" },
      googleSubject: "subject",
      pending: {
        userId: "ready-user",
        stage: async () => assert.fail("partial grant must not be staged"),
        read: async () => null,
      },
      connect: async () => assert.fail("unexpected connection"),
      warn: () => assert.fail("unexpected warning"),
    }),
    false,
  );
});
