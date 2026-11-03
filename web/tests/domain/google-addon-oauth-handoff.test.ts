import { GOOGLE_CALENDAR_SCOPES, GOOGLE_WORKSPACE_ADDON_SCOPES } from "@readymeet/shared";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";

import {
  GOOGLE_ADDON_OAUTH_HANDOFF_MAX_AGE_SECONDS,
  googleAddonAuthorizationParams,
  parseGoogleAddonOAuthHandoffToken,
} from "../../domain/google-addon-oauth-handoff";

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const EXPECTED_MANIFEST_OAUTH_SCOPE_COUNT = 6;
const SAMPLE_HANDOFF_TOKEN = "signed.handoff.token";
const SAMPLE_JWT_TOKEN = "header.payload.signature";

const googleWorkspaceAddonManifestSchema = z.object({
  oauthScopes: z.array(z.string()),
});

void test("Google add-on OAuth handoff accepts a compact signed token for one hour", () => {
  assert.equal(parseGoogleAddonOAuthHandoffToken(SAMPLE_JWT_TOKEN), SAMPLE_JWT_TOKEN);
  assert.equal(GOOGLE_ADDON_OAUTH_HANDOFF_MAX_AGE_SECONDS, SECONDS_PER_MINUTE * MINUTES_PER_HOUR);
});

void test("Google add-on OAuth handoff rejects missing and malformed values", () => {
  assert.equal(parseGoogleAddonOAuthHandoffToken(null), null);
  assert.equal(parseGoogleAddonOAuthHandoffToken("not-a-jwt"), null);
  assert.equal(parseGoogleAddonOAuthHandoffToken("header.payload.signature extra"), null);
});

void test("add-on web sign-in requests identity only and no combined or offline grant", () => {
  assert.deepEqual(googleAddonAuthorizationParams(SAMPLE_HANDOFF_TOKEN), {
    scope: "openid email profile",
    access_type: "online",
    include_granted_scopes: "false",
  });
  GOOGLE_CALENDAR_SCOPES.forEach((scope) => {
    assert.equal(googleAddonAuthorizationParams(SAMPLE_HANDOFF_TOKEN).scope?.split(" ").includes(scope), false);
  });
});

void test("standalone add-on scopes match the manifest and exclude web-only permissions", () => {
  const manifestRaw = readFileSync(
    new URL("../../adapters/primary/google-calendar/appsscript.json", import.meta.url),
    "utf8",
  );
  const manifest = googleWorkspaceAddonManifestSchema.parse(JSON.parse(manifestRaw));
  assert.deepEqual([...GOOGLE_WORKSPACE_ADDON_SCOPES].sort(), [...manifest.oauthScopes].sort());
  assert.equal(manifest.oauthScopes.length, EXPECTED_MANIFEST_OAUTH_SCOPE_COUNT);
  assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/calendar.events"));
  assert.equal(
    manifest.oauthScopes.some((scope) => /contacts|directory/.test(scope)),
    false,
  );
});

void test("ordinary website sign-in preserves identity-only authorization", () => {
  assert.deepEqual(googleAddonAuthorizationParams(null), {});
});
