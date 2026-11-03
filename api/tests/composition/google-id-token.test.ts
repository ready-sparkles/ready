import assert from "node:assert/strict";
import { test } from "node:test";

import { isVerifiedEmailClaim } from "../../adapters/secondary/jose/google-id-token";

void test("isVerifiedEmailClaim accepts both the boolean JWT form and the tokeninfo string form", () => {
  assert.equal(isVerifiedEmailClaim(true), true);
  assert.equal(isVerifiedEmailClaim("true"), true);
});

void test("isVerifiedEmailClaim rejects unverified or missing values", () => {
  assert.equal(isVerifiedEmailClaim(false), false);
  assert.equal(isVerifiedEmailClaim("false"), false);
  assert.equal(isVerifiedEmailClaim(undefined), false);
});
