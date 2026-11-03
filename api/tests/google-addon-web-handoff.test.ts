import "../composition/env";

import assert from "node:assert/strict";
import test from "node:test";

import {
  GoogleAddonHandoffAccountMismatchError,
  signGoogleAddonWebHandoff,
  verifyGoogleAddonOAuthBinding,
  verifyGoogleAddonWebHandoff,
} from "../adapters/primary/http/support/auth";

const SECONDS_PER_MINUTE = 60;
const GOOGLE_ADDON_HANDOFF_TTL_SECONDS = SECONDS_PER_MINUTE * SECONDS_PER_MINUTE;
const HANDOFF_MISSING_TIMING_FIELDS_MESSAGE = "Expected verified handoff payload to include exp and iat.";
const HANDOFF_INVALID_TIMING_TYPES_MESSAGE = "Expected verified handoff exp and iat to be numbers.";

const readHandoffTiming = (verified: ReturnType<typeof verifyGoogleAddonWebHandoff>) => {
  if (!("exp" in verified) || !("iat" in verified)) {
    throw new Error(HANDOFF_MISSING_TIMING_FIELDS_MESSAGE);
  }

  const exp = verified.exp;
  const iat = verified.iat;
  if (typeof exp !== "number" || typeof iat !== "number") {
    throw new Error(HANDOFF_INVALID_TIMING_TYPES_MESSAGE);
  }

  return { exp, iat };
};

void test("Google add-on browser handoff preserves the authenticated identities", () => {
  const token = signGoogleAddonWebHandoff({
    handoffId: "86f3cce4-556d-4a8c-9897-d3f806eac0ac",
    readyUserId: "94e9d223-9361-49e4-925e-8756e2116084",
    googleSubject: "google-subject-123",
    email: "reviewer@example.com",
  });

  const verified = verifyGoogleAddonWebHandoff(token);
  const { exp, iat } = readHandoffTiming(verified);
  assert.equal(exp - iat, GOOGLE_ADDON_HANDOFF_TTL_SECONDS);
  assert.deepEqual(
    {
      ...verified,
      iat: undefined,
      exp: undefined,
      aud: undefined,
      iss: undefined,
    },
    {
      purpose: "google-addon-web-handoff",
      handoffId: "86f3cce4-556d-4a8c-9897-d3f806eac0ac",
      readyUserId: "94e9d223-9361-49e4-925e-8756e2116084",
      googleSubject: "google-subject-123",
      email: "reviewer@example.com",
      iat: undefined,
      exp: undefined,
      aud: undefined,
      iss: undefined,
    },
  );
});

void test("ordinary Ready auth tokens cannot be used as add-on browser handoffs", () => {
  assert.throws(() => verifyGoogleAddonWebHandoff("not-a-signed-token"), /jwt malformed|invalid token/);
});

void test("Google add-on handoff rejects a different selected Google identity", () => {
  const token = signGoogleAddonWebHandoff({
    handoffId: "86f3cce4-556d-4a8c-9897-d3f806eac0ac",
    readyUserId: "94e9d223-9361-49e4-925e-8756e2116084",
    googleSubject: "google-subject-123",
    email: "reviewer@example.com",
  });

  assert.throws(
    () => verifyGoogleAddonOAuthBinding({ token, providerAccountId: "different-google-subject" }),
    GoogleAddonHandoffAccountMismatchError,
  );
  assert.equal(
    verifyGoogleAddonOAuthBinding({ token, providerAccountId: "google-subject-123" }).readyUserId,
    "94e9d223-9361-49e4-925e-8756e2116084",
  );
});
