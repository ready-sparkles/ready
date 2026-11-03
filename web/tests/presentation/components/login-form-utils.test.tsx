import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LOGIN_CALLBACK_URL } from "../../../domain/login-callback";
import {
  clearAuthEntryPoint,
  clearGoogleWorkspaceAddonAuthEntry,
  consumeAuthEntryReturnPath,
  getGoogleWorkspaceAddonSessionAction,
  getGoogleWorkspaceAddonSignInContext,
  getLoginCopy,
  getLoginErrorCopy,
  getSignupHref,
  hasGoogleWorkspaceAddonAuthEntry,
  rememberAuthEntryPoint,
} from "../../../presentation/components/login-form-utils";

const ADDON_ACCOUNT_ID = "94e9d223-9361-49e4-925e-8756e2116084";
const ADDON_HANDOFF_ID = "86f3cce4-556d-4a8c-9897-d3f806eac0ac";
const ADDON_HANDOFF_TOKEN = "header.payload.signature";
const EXPECTED_GOOGLE_WORKSPACE_ADDON_SIGN_IN_CONTEXT = "Expected a Google Workspace add-on sign-in context.";
const EXPECTED_COMPLETED_GOOGLE_WORKSPACE_ADDON_SIGN_IN_CONTEXT =
  "Expected a completed Google Workspace add-on sign-in context.";
const CLOCK_START_MS = 1_900_000_000_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1000;
const ONE_HOUR_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const ONE_MS = 1;

void test("guest notes signup link opens signup and preserves the notes return path", () => {
  assert.equal(
    getSignupHref("/guest/meetings/meeting-123/notes"),
    "/signup?callbackUrl=%2Fguest%2Fmeetings%2Fmeeting-123%2Fnotes",
  );
});

function withCookieDocument(run: (readCookie: () => string) => void) {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const cookies = new Map<string, string>();
  const mockDocument = {
    get cookie() {
      return Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; ");
    },
    set cookie(value: string) {
      const [pair = "", ...attributes] = value.split(";").map((part) => part.trim());
      const [name = "", cookieValue = ""] = pair.split("=");
      if (name === "") {
        return;
      }
      const shouldDelete = attributes.some((attribute) => attribute.toLowerCase() === "max-age=0");
      if (shouldDelete) {
        cookies.delete(name);

        return;
      }
      cookies.set(name, cookieValue);
    },
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: mockDocument,
  });

  try {
    run(() => mockDocument.cookie);
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "document", previousDescriptor);
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  }
}

void test("Google Workspace add-on sign-in returns through an account-verification callback", () => {
  const context = getGoogleWorkspaceAddonSignInContext({
    accountId: ADDON_ACCOUNT_ID,
    callbackUrl: "/workspace",
    complete: null,
    handoffId: ADDON_HANDOFF_ID,
    handoffToken: ADDON_HANDOFF_TOKEN,
    loginHint: "reviewer+ready@example.com",
    source: "google-workspace-addon",
  });

  assert.equal(context?.expectedAccountId, ADDON_ACCOUNT_ID);
  assert.equal(context.isCompletion, false);
  assert.equal(context.loginHint, "reviewer+ready@example.com");
  assert.equal(context.handoffToken, ADDON_HANDOFF_TOKEN);
  assert.equal(context.handoffId, ADDON_HANDOFF_ID);
  const retryUrl = new URL(context.retryUrl, "https://ready.app");
  assert.equal(retryUrl.pathname, "/login");
  assert.equal(retryUrl.searchParams.get("source"), "google-workspace-addon");
  assert.equal(retryUrl.searchParams.get("complete"), null);
  assert.equal(retryUrl.searchParams.get("accountId"), ADDON_ACCOUNT_ID);
  assert.equal(retryUrl.searchParams.get("loginHint"), "reviewer+ready@example.com");
  assert.equal(retryUrl.searchParams.get("handoffToken"), ADDON_HANDOFF_TOKEN);
  assert.equal(retryUrl.searchParams.get("handoffId"), ADDON_HANDOFF_ID);
  assert.equal(retryUrl.searchParams.get("callbackUrl"), "/workspace");
  const completionUrl = new URL(context.oauthCallbackUrl, "https://ready.app");
  assert.equal(completionUrl.pathname, "/login");
  assert.equal(completionUrl.searchParams.get("source"), "google-workspace-addon");
  assert.equal(completionUrl.searchParams.get("complete"), "1");
  assert.equal(completionUrl.searchParams.get("accountId"), ADDON_ACCOUNT_ID);
  assert.equal(completionUrl.searchParams.get("handoffToken"), null);
  assert.equal(completionUrl.searchParams.get("handoffId"), ADDON_HANDOFF_ID);
  assert.equal(completionUrl.searchParams.get("callbackUrl"), "/workspace");
});

void test("Google Workspace add-on sign-in fails closed without a valid Ready account id", () => {
  const context = getGoogleWorkspaceAddonSignInContext({
    accountId: "not-an-account-id",
    callbackUrl: "/workspace",
    complete: null,
    handoffId: ADDON_HANDOFF_ID,
    handoffToken: ADDON_HANDOFF_TOKEN,
    loginHint: "not-an-email",
    source: "google-workspace-addon",
  });

  assert.equal(context?.expectedAccountId, null);
  assert.equal(context.loginHint, null);
  assert.equal(
    getGoogleWorkspaceAddonSignInContext({
      accountId: ADDON_ACCOUNT_ID,
      callbackUrl: "/workspace",
      complete: null,
      handoffId: ADDON_HANDOFF_ID,
      handoffToken: null,
      loginHint: "reviewer+ready@example.com",
      source: "google-workspace-addon",
    })?.expectedAccountId,
    null,
  );
  assert.equal(
    getGoogleWorkspaceAddonSignInContext({
      accountId: ADDON_ACCOUNT_ID,
      callbackUrl: "/workspace",
      complete: null,
      handoffId: ADDON_HANDOFF_ID,
      handoffToken: ADDON_HANDOFF_TOKEN,
      loginHint: null,
      source: null,
    }),
    null,
  );
});

void test("Google Workspace add-on only clears mismatches from a verified OAuth flow", () => {
  assert.equal(
    getGoogleWorkspaceAddonSessionAction({
      authenticatedAccountId: "ready-user-old",
      expectedAccountId: ADDON_ACCOUNT_ID,
      hasVerifiedFlowState: false,
      isCompletion: false,
      sessionStatus: "authenticated",
    }),
    "none",
  );
  assert.equal(
    getGoogleWorkspaceAddonSessionAction({
      authenticatedAccountId: "ready-user-wrong",
      expectedAccountId: ADDON_ACCOUNT_ID,
      hasVerifiedFlowState: false,
      isCompletion: true,
      sessionStatus: "authenticated",
    }),
    "invalid",
  );
  assert.equal(
    getGoogleWorkspaceAddonSessionAction({
      authenticatedAccountId: "ready-user-wrong",
      expectedAccountId: ADDON_ACCOUNT_ID,
      hasVerifiedFlowState: true,
      isCompletion: true,
      sessionStatus: "authenticated",
    }),
    "clear",
  );
  assert.equal(
    getGoogleWorkspaceAddonSessionAction({
      authenticatedAccountId: ADDON_ACCOUNT_ID,
      expectedAccountId: ADDON_ACCOUNT_ID,
      hasVerifiedFlowState: true,
      isCompletion: true,
      sessionStatus: "authenticated",
    }),
    "complete",
  );
  assert.equal(
    getGoogleWorkspaceAddonSessionAction({
      authenticatedAccountId: null,
      expectedAccountId: ADDON_ACCOUNT_ID,
      hasVerifiedFlowState: true,
      isCompletion: true,
      sessionStatus: "unauthenticated",
    }),
    "none",
  );
});

void test("login copy keeps provider labels stable for default login", () => {
  const copy = getLoginCopy(DEFAULT_LOGIN_CALLBACK_URL);

  assert.equal(copy.title, "Sign in to Ready");
  assert.equal(copy.googleLabel, "Continue with Google");
  assert.equal(copy.microsoftLabel, "Continue with Microsoft");
  assert.equal(copy.legalPrefix, "By continuing");
  assert.notEqual(copy.googleLabel, "Opening Google...");
  assert.notEqual(copy.microsoftLabel, "Opening Microsoft...");
});

void test("login copy switches labels for meeting join callbacks", () => {
  const copy = getLoginCopy("/meet");

  assert.equal(copy.title, "Join meeting");
  assert.equal(copy.googleLabel, "Join with Google");
  assert.equal(copy.microsoftLabel, "Join with Microsoft");
  assert.equal(copy.legalPrefix, "By joining a meeting");
  assert.notEqual(copy.googleLabel, "Opening Google...");
  assert.notEqual(copy.microsoftLabel, "Opening Microsoft...");
});

void test("signup copy uses signup-oriented labels and legal text", () => {
  const copy = getLoginCopy(DEFAULT_LOGIN_CALLBACK_URL, "signup");

  assert.equal(copy.title, "Welcome to Ready");
  assert.equal(copy.googleLabel, "Sign up with Google");
  assert.equal(copy.microsoftLabel, "Sign up with Microsoft");
  assert.equal(copy.legalPrefix, "By signing up");
});

void test("meeting join callbacks override the signup variant", () => {
  const copy = getLoginCopy("/meet", "signup");

  assert.equal(copy.title, "Join meeting");
  assert.equal(copy.googleLabel, "Join with Google");
  assert.equal(copy.legalPrefix, "By joining a meeting");
});

void test("auth entry return path defaults to login outside the browser", async () => {
  const { consumeAuthEntryReturnPath } = await import("../../../presentation/components/login-form-utils");

  assert.equal(consumeAuthEntryReturnPath(), "/login");
});

void test("auth entry return path consumes the signup marker", () => {
  withCookieDocument((readCookie) => {
    rememberAuthEntryPoint("signup");

    assert.match(readCookie(), /ready-auth-entry=signup/);
    assert.equal(consumeAuthEntryReturnPath(), "/signup");
    assert.doesNotMatch(readCookie(), /ready-auth-entry=signup/);
    assert.equal(consumeAuthEntryReturnPath(), "/login");
  });
});

void test("auth entry return path preserves a validated Google add-on sign-in", () => {
  withCookieDocument((readCookie) => {
    const context = getGoogleWorkspaceAddonSignInContext({
      accountId: ADDON_ACCOUNT_ID,
      callbackUrl: "/workspace",
      complete: null,
      handoffId: ADDON_HANDOFF_ID,
      handoffToken: ADDON_HANDOFF_TOKEN,
      loginHint: "reviewer+ready@example.com",
      source: "google-workspace-addon",
    });

    if (context === null) {
      throw new Error(EXPECTED_GOOGLE_WORKSPACE_ADDON_SIGN_IN_CONTEXT);
    }
    rememberAuthEntryPoint("login", context.retryUrl);

    assert.match(readCookie(), /ready-auth-entry=%2Flogin%3Fsource%3Dgoogle-workspace-addon/);
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(context.retryUrl), true);
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(context.oauthCallbackUrl), true);
    assert.equal(consumeAuthEntryReturnPath(), context.retryUrl);
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(context.retryUrl), true);
    assert.doesNotMatch(readCookie(), /ready-auth-entry=/);
    clearGoogleWorkspaceAddonAuthEntry(context.oauthCallbackUrl);
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(context.retryUrl), false);
  });
});

function addonContext(handoffId = ADDON_HANDOFF_ID) {
  const context = getGoogleWorkspaceAddonSignInContext({
    accountId: ADDON_ACCOUNT_ID,
    callbackUrl: "/workspace",
    complete: null,
    handoffId,
    handoffToken: ADDON_HANDOFF_TOKEN,
    loginHint: "reviewer+ready@example.com",
    source: "google-workspace-addon",
  });
  if (context === null) {
    throw new Error(EXPECTED_GOOGLE_WORKSPACE_ADDON_SIGN_IN_CONTEXT);
  }

  return context;
}

void test("ordinary login in another tab cannot invalidate an in-progress add-on OAuth flow", () => {
  withCookieDocument(() => {
    const context = addonContext();
    rememberAuthEntryPoint("login", context.retryUrl);
    // signOut broadcasts to an old workspace tab, whose ordinary /login clears
    // or replaces the generic auth-entry cookie while Google OAuth is pending.
    clearAuthEntryPoint();
    rememberAuthEntryPoint("signup");
    assert.equal(consumeAuthEntryReturnPath(), "/signup");
    clearAuthEntryPoint();

    const hasVerifiedFlowState = hasGoogleWorkspaceAddonAuthEntry(context.oauthCallbackUrl);
    assert.equal(hasVerifiedFlowState, true);
    assert.equal(
      getGoogleWorkspaceAddonSessionAction({
        authenticatedAccountId: ADDON_ACCOUNT_ID,
        expectedAccountId: context.expectedAccountId,
        hasVerifiedFlowState,
        isCompletion: true,
        sessionStatus: "authenticated",
      }),
      "complete",
    );
  });
});

void test("add-on completion requires its own handoff, account, callback and trusted login URL", () => {
  withCookieDocument(() => {
    const context = addonContext();
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(context.oauthCallbackUrl), false);
    rememberAuthEntryPoint("login", context.retryUrl);
    (
      [
        ["handoffId", "2c826913-b9bd-4239-b386-1722efc4e8cc"],
        ["accountId", "2c826913-b9bd-4239-b386-1722efc4e8cc"],
        ["callbackUrl", "/workspace?view=past"],
        ["source", "another-source"],
      ] as const
    ).forEach(([name, value]) => {
      const completion = new URL(context.oauthCallbackUrl, "https://ready.app");
      completion.searchParams.set(name, value);
      assert.equal(hasGoogleWorkspaceAddonAuthEntry(completion.toString()), false);
    });
    const missingHandoff = new URL(context.oauthCallbackUrl, "https://ready.app");
    missingHandoff.searchParams.delete("handoffId");
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(missingHandoff.toString()), false);
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(`https://attacker.example${context.oauthCallbackUrl}`), false);
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(context.oauthCallbackUrl.replace("/login?", "/workspace?")), false);
  });
});

void test("completing or rejecting one handoff clears only that flow marker", () => {
  withCookieDocument((readCookie) => {
    const first = addonContext();
    const second = addonContext("2c826913-b9bd-4239-b386-1722efc4e8cc");
    rememberAuthEntryPoint("login", first.retryUrl);
    rememberAuthEntryPoint("login", second.retryUrl);
    clearGoogleWorkspaceAddonAuthEntry(first.oauthCallbackUrl);
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(first.oauthCallbackUrl), false);
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(second.oauthCallbackUrl), true);
    clearGoogleWorkspaceAddonAuthEntry(second.oauthCallbackUrl);
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(second.oauthCallbackUrl), false);
    assert.doesNotMatch(readCookie(), /ready-addon-flow-/);
  });
});

void test("add-on flow markers expire after one hour and never contain the signed handoff token", (t) => {
  const clock = { now: CLOCK_START_MS };
  t.mock.method(Date, "now", () => clock.now);
  withCookieDocument((readCookie) => {
    const context = addonContext();
    rememberAuthEntryPoint("login", context.retryUrl);
    clearAuthEntryPoint();
    assert.doesNotMatch(decodeURIComponent(readCookie()), /header\.payload\.signature/);
    clock.now += ONE_HOUR_MS - ONE_MS;
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(context.oauthCallbackUrl), true);
    clock.now += ONE_MS;
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(context.oauthCallbackUrl), false);
  });
});

void test("auth entry return path rejects untrusted and completed add-on URLs", () => {
  withCookieDocument(() => {
    rememberAuthEntryPoint("login", "https://attacker.example/login?source=google-workspace-addon");
    assert.equal(consumeAuthEntryReturnPath(), "/login");

    const completedContext = getGoogleWorkspaceAddonSignInContext({
      accountId: ADDON_ACCOUNT_ID,
      callbackUrl: "/workspace",
      complete: "1",
      handoffId: ADDON_HANDOFF_ID,
      handoffToken: null,
      loginHint: "reviewer+ready@example.com",
      source: "google-workspace-addon",
    });
    if (completedContext === null) {
      throw new Error(EXPECTED_COMPLETED_GOOGLE_WORKSPACE_ADDON_SIGN_IN_CONTEXT);
    }
    rememberAuthEntryPoint("login", completedContext.oauthCallbackUrl);
    assert.equal(consumeAuthEntryReturnPath(), "/login");
    assert.equal(hasGoogleWorkspaceAddonAuthEntry(completedContext.oauthCallbackUrl), false);
  });
});

void test("auth entry marker can be cleared before a normal login attempt", () => {
  withCookieDocument((readCookie) => {
    rememberAuthEntryPoint("signup");
    clearAuthEntryPoint();

    assert.doesNotMatch(readCookie(), /ready-auth-entry=signup/);
    assert.equal(consumeAuthEntryReturnPath(), "/login");
  });
});

void test("login error copy explains access denied failures", () => {
  const copy = getLoginErrorCopy("AccessDenied");

  assert.equal(copy?.title, "Access denied");
  assert.match(copy.description, /account did not pass our sign-in checks/);
  assert.match(copy.description, /verified email address/);
});

void test("login error copy hides empty error state", () => {
  assert.equal(getLoginErrorCopy(null), null);
});

void test("login error copy falls back safely for unknown auth errors", () => {
  const copy = getLoginErrorCopy("UnexpectedProviderError");

  assert.equal(copy?.title, "Sign-in failed");
  assert.match(copy.description, /could not complete authentication/);
  assert.doesNotMatch(copy.description, /UnexpectedProviderError/);
});
