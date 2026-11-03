import assert from "node:assert/strict";
import test from "node:test";

import { apiTokenMatchesUser } from "../../domain/api-session-consistency";

function unsignedToken(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

void test("API session consistency requires the token subject to match the Ready user", () => {
  const token = unsignedToken({ sub: "user-personbr" });

  assert.equal(apiTokenMatchesUser({ apiToken: token, userId: "user-personbr" }), true);
  assert.equal(apiTokenMatchesUser({ apiToken: token, userId: "user-samz" }), false);
});

void test("API session consistency rejects missing or malformed token subjects", () => {
  assert.equal(apiTokenMatchesUser({ apiToken: null, userId: "user-personbr" }), false);
  assert.equal(apiTokenMatchesUser({ apiToken: "not-a-jwt", userId: "user-personbr" }), false);
  assert.equal(
    apiTokenMatchesUser({ apiToken: unsignedToken({ email: "personbr@example.com" }), userId: "user-personbr" }),
    false,
  );
});
