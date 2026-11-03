import assert from "node:assert/strict";
import test from "node:test";

import { matchesInternalSecret } from "../adapters/primary/http/support/internal-secret";

const EXPECTED = "internal-service-secret-for-tests";

void test("accepts the exact secret, including the first value of a repeated header", () => {
  assert.equal(matchesInternalSecret({ header: EXPECTED, expected: EXPECTED }), true);
  assert.equal(matchesInternalSecret({ header: [EXPECTED, "other"], expected: EXPECTED }), true);
});

void test("rejects missing, empty, wrong, prefix and longer secrets", () => {
  const rejected = [undefined, "", [], "wrong", EXPECTED.slice(0, -1), `${EXPECTED}x`, ["other", EXPECTED]];
  rejected.forEach((header) => {
    assert.equal(matchesInternalSecret({ header, expected: EXPECTED }), false, JSON.stringify(header));
  });
});

void test("never matches when no secret is configured", () => {
  assert.equal(matchesInternalSecret({ header: "", expected: "" }), false);
  assert.equal(matchesInternalSecret({ header: "anything", expected: "" }), false);
});
