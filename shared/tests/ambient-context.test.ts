import assert from "node:assert/strict";
import { test } from "node:test";

import { AMBIENT_IDENTITY_UNVERIFIED, canRetryAmbientContextResearch } from "../domain/ambient-context";

void test("the card and retry route permit explicit retry for inconclusive follow-up research only", () => {
  assert.equal(canRetryAmbientContextResearch({ status: "ready", error: AMBIENT_IDENTITY_UNVERIFIED }), true);
  assert.equal(canRetryAmbientContextResearch({ status: "failed", error: null }), true);
  (["ready", "pending", "researching"] as const).forEach((status) => {
    assert.equal(canRetryAmbientContextResearch({ status, error: null }), false);
  });
  (["pending", "researching"] as const).forEach((status) => {
    assert.equal(canRetryAmbientContextResearch({ status, error: AMBIENT_IDENTITY_UNVERIFIED }), false);
  });
});
